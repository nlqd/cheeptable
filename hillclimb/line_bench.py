#!/usr/bin/env python3
"""Line-level recogniser benchmark on public born-digital Vietnamese PDFs (their text layer is the answer key).

  line_bench.py OUT.json [--pages 4] [--lines 25] [--conditions clean,scan,x0.5]
Run from hillclimb/ with ../venv_onnx_export/bin/python.
For every sampled page: render at 200 dpi, degrade like a scan, cut each sampled text line out of the image (box from the
text layer, mapped through any rotation), read it the way the pipeline does (ink-tight crop, 10 px white margin, VietOCR),
and compare with the text layer after NFC normalisation. Only lines whose characters are all in the recogniser's vocabulary
are used, so the answer is producible and legacy-font gibberish in old PDFs is excluded.
Reports error per document with a document-level bootstrap interval, because lines of one document are not independent."""
import json
import os
import random
import re
import sys
import unicodedata

import cv2
import numpy as np
import pypdfium2 as pdfium

sys.path.insert(0, "..")
sys.path.insert(0, ".")
import recog  # noqa: E402
import robust_sweep_lib as D  # noqa: E402

MANIFEST = "../benchmark/manifest.json"
VOCAB = set(unicodedata.normalize("NFC", open("../benchmark/vocab.txt", encoding="utf8").read().replace("\n", ""))) | {" "}
SCALE = 200 / 72
CONDITIONS = {
    "clean": lambda img: img,
    "scan": D.chain(D.rotate(0.6), D.blur(0.8), D.noise(8), D.contrast(0.8), D.jpeg(40)),
    "x0.5": D.lowres(0.5),
    "rough": D.chain(D.rotate(1.5), D.blur(1.2), D.noise(15), D.contrast(0.7), D.jpeg(30)),
}


def norm(s):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", s)).strip()


def strip_marks(s):
    s = "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")
    return s.replace("đ", "d").replace("Đ", "D")


def page_segments(page):
    """Text segments from character boxes. Characters are first grouped into lines by position (a PDF may write them in any
    order, for example cell by cell), then each line is read left to right and split at gaps wider than 1.2 character heights
    (a cell or column gap; a justified word gap is below 1). A visible gap of 0.25 heights or more is a space even where the
    PDF has no space character. Returns [(text, (l, b, r, t))] in PDF points."""
    tp = page.get_textpage()
    ox, oy = page.get_cropbox()[:2]          # text coordinates are relative to the media box; the render starts at the crop box
    rot = page.get_rotation() % 360          # a rotated page renders sideways to its text coordinates
    cw, ch_ = page.get_cropbox()[2] - ox, page.get_cropbox()[3] - oy

    def upright(l, b, r, t):
        if rot == 90:      # clockwise: (x, y) -> (y, W - x)
            return b, cw - r, t, cw - l
        if rot == 270:     # counter-clockwise: (x, y) -> (H - y, x)
            return ch_ - t, l, ch_ - b, r
        if rot == 180:
            return cw - r, ch_ - t, cw - l, ch_ - b
        return l, b, r, t

    chars = []
    for i in range(tp.count_chars()):
        ch = tp.get_text_range(i, 1)
        l, b, r, t = tp.get_charbox(i, loose=True)      # font-sized box: same height for every glyph on a line
        if len(ch) == 1 and r > l and t > b and ch not in "\r\n":
            chars.append((ch, *upright(l - ox, b - oy, r - ox, t - oy)))
    chars.sort(key=lambda c: -(c[2] + c[4]) / 2)             # top to bottom by vertical centre
    lines, cur = [], []
    for c in chars:
        if cur:
            mid = sum((x[2] + x[4]) / 2 for x in cur) / len(cur)
            h = max(sorted(x[4] - x[2] for x in cur)[len(cur) // 2], 1e-3)
            if abs((c[2] + c[4]) / 2 - mid) > 0.35 * h:
                lines.append(cur); cur = []
        cur.append(c)
    if cur:
        lines.append(cur)

    segs = []
    for line in lines:
        line.sort(key=lambda c: c[1])
        h = max(sorted(x[4] - x[2] for x in line)[len(line) // 2], 1e-3)
        seg, prev_r, pending = None, None, False
        for ch, l, b, r, t in line:
            if ch == " ":
                pending = True
                continue
            if seg is not None and l - prev_r > 1.2 * h:
                segs.append(seg); seg = None
            if seg is None:
                seg = [l, b, r, t, ch]
            else:
                if pending or l - prev_r > 0.25 * h:
                    seg[4] += " "
                seg[0], seg[1], seg[2], seg[3] = min(seg[0], l), min(seg[1], b), max(seg[2], r), max(seg[3], t)
                seg[4] += ch
            prev_r, pending = max(prev_r or r, r), False
        if seg is not None:
            segs.append(seg)
    return [(text, (l, b, r, t)) for l, b, r, t, text in segs]


def page_lines(page):
    out, seen = [], set()
    for raw, (l, b, r, t) in page_segments(page):
        text = norm(raw)
        if text in seen or len(text) < 5 or r - l < 25 or not (5 <= t - b <= 30):
            continue
        if any(c not in VOCAB for c in text):
            continue
        # dotted fill-in fields (".....") are not text to compare
        if re.search(r"\.{3,}|…|_{3,}|-{3,}", text):
            continue
        seen.add(text)
        out.append((text, (l, b, r, t)))
    return out


def sample_pages(pdf, n_pages, n_lines, rng):
    cand = []
    for p in range(len(pdf)):
        lines = page_lines(pdf[p])
        if len(lines) >= 10:
            cand.append((p, lines))
    if not cand:
        return []
    picks = [cand[int(i * (len(cand) - 1) / max(n_pages - 1, 1))] for i in range(min(n_pages, len(cand)))]
    return [(p, rng.sample(lines, min(n_lines, len(lines)))) for p, lines in picks]


def box_px(box, height_pt, rot_deg, shape):
    l, b, r, t = box
    pts = np.array([[l * SCALE, (height_pt - t) * SCALE], [r * SCALE, (height_pt - t) * SCALE],
                    [r * SCALE, (height_pt - b) * SCALE], [l * SCALE, (height_pt - b) * SCALE]], dtype=np.float32)
    if rot_deg:
        h, w = shape
        m = cv2.getRotationMatrix2D((w / 2, h / 2), rot_deg, 1.0)
        pts = cv2.transform(pts[None], m)[0]
    x0, y0 = pts.min(axis=0) - 2
    x1, y1 = pts.max(axis=0) + 2
    return int(max(x0, 0)), int(max(y0, 0)), int(min(x1, shape[1])), int(min(y1, shape[0]))


def read(img, box):
    x0, y0, x1, y1 = box
    crop = img[y0:y1, x0:x1]
    if crop.size == 0:
        return ""
    return recog.predictor().predict(recog.to_pil(recog.pad(recog.tight(crop), 10)))


def main():
    args = sys.argv[1:]
    out_path = args[0]
    n_pages = int(args[args.index("--pages") + 1]) if "--pages" in args else 4
    n_lines = int(args[args.index("--lines") + 1]) if "--lines" in args else 25
    names = args[args.index("--conditions") + 1].split(",") if "--conditions" in args else list(CONDITIONS)
    rng = random.Random(0)
    docs = [e for e in json.load(open(MANIFEST)) if e["born_digital"] is True]
    plan = []
    for e in docs:
        pdf = pdfium.PdfDocument(e["local_path"])
        plan.append((e, pdf, sample_pages(pdf, n_pages, n_lines, rng)))
        print("%-36s pages %d lines %d" % (e["id"], len(plan[-1][2]), sum(len(l) for _, l in plan[-1][2])), file=sys.stderr, flush=True)

    results = []
    for cond in names:
        D.seed(0)
        rot = {"clean": 0, "scan": 0.6, "x0.5": 0, "rough": 1.5}[cond]
        for e, pdf, pages in plan:
            for p, lines in pages:
                page = pdf[p]
                height_pt = page.get_height()
                img = np.array(page.render(scale=SCALE).to_pil().convert("L"))
                img = CONDITIONS[cond](img)
                for text, box in lines:
                    hyp = norm(read(img, box_px(box, height_pt, rot, img.shape)))
                    results.append({"cond": cond, "doc": e["id"], "page": p, "ref": text, "hyp": hyp})
        print("done", cond, file=sys.stderr, flush=True)
    json.dump(results, open(out_path, "w"), ensure_ascii=False)


if __name__ == "__main__":
    main()
