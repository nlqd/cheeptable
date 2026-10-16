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
    """Text segments from character boxes: a new segment starts at a line break, when the next character is not on the same
    line, or after a gap wider than 1.2 character heights (a cell or column gap; a justified word gap is below 1). Returns [(text, (l, b, r, t))] in PDF points."""
    tp = page.get_textpage()
    n = tp.count_chars()
    segs, cur = [], None
    for i in range(n):
        ch = tp.get_text_range(i, 1)
        if len(ch) != 1:
            continue
        l, b, r, t = tp.get_charbox(i)
        if ch in "\r\n" or r <= l or t <= b:
            if ch in "\r\n" and cur:
                segs.append(cur); cur = None
            continue
        if cur:
            cl, cb, cr, ct, text = cur
            h = max(ct - cb, 1e-3)
            same_line = min(t, ct) - max(b, cb) > 0.5 * min(t - b, h)
            if not same_line or l - cr > 1.2 * h or l < cl - h:
                segs.append(cur); cur = None
        if cur is None:
            cur = [l, b, r, t, ch]
        else:
            # some PDFs have no space characters and place words by position: a visible gap is a space
            if l - cur[2] > 0.25 * max(cur[3] - cur[1], 1e-3) and not cur[4].endswith(" ") and ch != " ":
                cur[4] += " "
            cur[0], cur[1], cur[2], cur[3] = min(cur[0], l), min(cur[1], b), max(cur[2], r), max(cur[3], t)
            cur[4] += ch
    if cur:
        segs.append(cur)
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
