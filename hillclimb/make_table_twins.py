#!/usr/bin/env python3
"""Borderless-table twins: render table pages of born-digital public PDFs to image-only PDFs, and keep what the text layer says.

  make_table_twins.py OUTDIR [--per-doc 5]      run with ../venv_onnx_export/bin/python from hillclimb/
Writes OUTDIR/twins.pdf (all chosen pages, as page images at 200 dpi, no text layer) and OUTDIR/truth.json:
a list per output page of table lines, each a list of cell strings left to right. A "table line" is a text line whose text
splits into 2+ segments at gaps wider than 1.2 character heights (the same split as line_bench.py)."""
import json
import re
import sys
import unicodedata

import pypdfium2 as pdfium

sys.path.insert(0, ".")
import line_bench as L  # noqa: E402

SOURCES = ["vietstock-vug-bctc-2025-hn", "vietstock-pac-bctc-q4-2025", "nso-ngtk-tomtat-2019", "cp-born-hochua-bang"]


def table_lines(page):
    """Group page segments into lines by vertical overlap; return lines with 2+ cells, each cell {t: text, b: [x0, y0, x1, y1]}
    with the box in pixels of a 200 dpi render, lines top to bottom, cells left to right."""
    h_pt = page.get_height()
    sc = L.SCALE
    segs = []
    for raw, (l, b, r, t) in L.page_segments(page):
        text = L.norm(raw)
        if text and not any(c not in L.VOCAB for c in text) and not re.search(r"\.{3,}|…|_{3,}", text):
            segs.append((text, l, b, r, t))
    # Layered or hidden text overlaps the visible text; a real table cell never overlaps another cell. Drop overlapping ones.
    def area(s):
        return max((s[3] - s[1]) * (s[4] - s[2]), 1e-6)

    def inter(a, c):
        return max(0, min(a[3], c[3]) - max(a[1], c[1])) * max(0, min(a[4], c[4]) - max(a[2], c[2]))

    junk = set()
    order = sorted(range(len(segs)), key=lambda i: segs[i][1])
    for ai, i in enumerate(order):
        for j in order[ai + 1:]:
            if segs[j][1] > segs[i][3]:
                break
            if inter(segs[i], segs[j]) > 0.2 * min(area(segs[i]), area(segs[j])):
                junk.update((i, j))
    segs = [s for k, s in enumerate(segs) if k not in junk]
    segs.sort(key=lambda s: -(s[2] + s[4]) / 2)
    lines, cur = [], []
    for s in segs:
        if cur and abs((s[2] + s[4]) / 2 - (cur[0][2] + cur[0][4]) / 2) > 0.35 * (s[4] - s[2]):
            lines.append(cur)
            cur = []
        cur.append(s)
    if cur:
        lines.append(cur)
    out = []
    for line in lines:
        if len(line) < 2:
            continue
        out.append([{"t": s[0], "b": [round(s[1] * sc), round((h_pt - s[4]) * sc), round(s[3] * sc), round((h_pt - s[2]) * sc)]}
                    for s in sorted(line, key=lambda s: s[1])])
    return out


def main():
    out, per_doc = sys.argv[1], int(sys.argv[sys.argv.index("--per-doc") + 1]) if "--per-doc" in sys.argv else 5
    manifest = {e["id"]: e for e in json.load(open("../benchmark/manifest.json"))}
    pages, truth, meta = [], [], []
    for doc in SOURCES:
        pdf = pdfium.PdfDocument(manifest[doc]["local_path"])
        scored = []
        for p in range(len(pdf)):
            tl = table_lines(pdf[p])
            if len(tl) >= 15:
                scored.append((len(tl), p, tl))
        picks = sorted(scored, reverse=True)[:per_doc * 3]
        step = max(len(picks) // per_doc, 1)
        for n, p, tl in sorted(picks, key=lambda x: x[1])[::step][:per_doc]:
            pages.append(pdf[p].render(scale=L.SCALE).to_pil().convert("L"))
            truth.append(tl)
            meta.append({"doc": doc, "page": p + 1, "table_lines": len(tl)})
        print("%-30s candidate pages %3d, picked %d" % (doc, len(scored), min(per_doc, len(picks))), file=sys.stderr)
    import os

    import cv2
    import numpy as np

    import robust_sweep_lib as D
    os.makedirs(out, exist_ok=True)
    pages[0].save(os.path.join(out, "twins.pdf"), save_all=True, append_images=pages[1:], resolution=200)
    json.dump({"meta": meta, "pages": truth}, open(os.path.join(out, "truth.json"), "w"), ensure_ascii=False)

    # degraded copies; truth boxes follow the rotation
    variants = {"scan": (0.6, D.chain(D.rotate(0.6), D.blur(0.8), D.noise(8), D.contrast(0.8), D.jpeg(40))),
                "x0.5": (0, D.lowres(0.5)),
                "rough": (1.5, D.chain(D.rotate(1.5), D.blur(1.2), D.noise(15), D.contrast(0.7), D.jpeg(30)))}
    for name, (deg, fn) in variants.items():
        D.seed(0)
        imgs, moved = [], []
        for img, page_truth in zip(pages, truth):
            arr = np.array(img)
            imgs.append(__import__("PIL.Image", fromlist=["Image"]).fromarray(fn(arr)))
            m = cv2.getRotationMatrix2D((arr.shape[1] / 2, arr.shape[0] / 2), deg, 1.0)
            rows = []
            for line in page_truth:
                cells = []
                for c in line:
                    x0, y0, x1, y1 = c["b"]
                    pts = cv2.transform(np.array([[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]], dtype=np.float32), m)[0] if deg else np.array([[x0, y0], [x1, y1]])
                    cells.append({"t": c["t"], "b": [int(pts[:, 0].min()), int(pts[:, 1].min()), int(pts[:, 0].max()), int(pts[:, 1].max())]})
                rows.append(cells)
            moved.append(rows)
        imgs[0].save(os.path.join(out, "twins_%s.pdf" % name), save_all=True, append_images=imgs[1:], resolution=200)
        json.dump({"meta": meta, "pages": moved}, open(os.path.join(out, "truth_%s.json" % name), "w"), ensure_ascii=False)
    print("pages %d, table lines %d" % (len(pages), sum(len(t) for t in truth)), file=sys.stderr)


if __name__ == "__main__":
    main()
