#!/usr/bin/env python3
"""Cut every table cell out of a scanned page, with no OCR and no knowledge of the document.

  grid.py PDF OUTDIR [--scale 2]
Finds the ruled lines with morphology, builds the cell grid, keeps rows whose first column holds a number
(ink in the STT cell), and writes OUTDIR/p{page}_r{row}_c{col}.png plus OUTDIR/index.json.
Rows are paired with golden rows by order, so recognizers can be scored on cells instead of on the app's
row-building logic. Works for any bordered table; borderless tables are out of scope here.
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import pypdfium2 as pdfium


def clusters(vals, gap):
    vals = sorted(vals)
    out, cur = [], [vals[0]]
    for v in vals[1:]:
        if v - cur[-1] <= gap:
            cur.append(v)
        else:
            out.append(int(np.mean(cur)))
            cur = [v]
    out.append(int(np.mean(cur)))
    return out


def find_grid(gray):
    h, w = gray.shape
    bw = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 25, 10)
    hor = cv2.morphologyEx(bw, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (w // 8, 1)))
    ver = cv2.morphologyEx(bw, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 30)))
    ys = clusters(np.where(hor.sum(axis=1) > 255 * (w * 0.25))[0].tolist() or [0], 4)
    xs_all = np.where(ver.sum(axis=0) > 255 * 25)[0].tolist()
    w_ = gray.shape[1]
    xs = [x for x in (clusters(xs_all, 10) if xs_all else []) if 0.05 * w_ < x < 0.96 * w_]  # drop the scan-edge shadow
    return ys, xs


def main(pdf_path, outdir, scale=2):
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    pdf = pdfium.PdfDocument(pdf_path)
    index = []
    for p in range(len(pdf)):
        img = np.array(pdf[p].render(scale=scale).to_pil().convert("L"))
        ys, xs = find_grid(img)
        if len(xs) < 3 or len(ys) < 3:
            index.append({"page": p + 1, "error": "no grid"})
            continue
        # keep only the column lines that span most of the table height
        for r in range(len(ys) - 1):
            y0, y1 = ys[r] + 3, ys[r + 1] - 2
            if y1 - y0 < 12:
                continue
            stt = img[y0:y1, xs[0] + 3:xs[1] - 2]
            ink = float((stt < 140).mean()) if stt.size else 0.0
            cells = []
            for c in range(len(xs) - 1):
                x0, x1 = xs[c] + 3, xs[c + 1] - 2
                if x1 - x0 < 8:
                    continue
                name = "p%02d_r%03d_c%d.png" % (p + 1, r, c)
                cv2.imwrite(str(out / name), img[y0:y1, x0:x1])
                cells.append(name)
            index.append({"page": p + 1, "row": r, "y": [y0, y1], "x": xs, "stt_ink": round(ink, 4), "cells": cells})
    (out / "index.json").write_text(json.dumps(index))
    return index


if __name__ == "__main__":
    idx = main(sys.argv[1], sys.argv[2], int(sys.argv[sys.argv.index("--scale") + 1]) if "--scale" in sys.argv else 2)
    pages = {}
    for r in idx:
        pages.setdefault(r["page"], []).append(r)
    for pg, rows in pages.items():
        data = [r for r in rows if r.get("stt_ink", 0) > 0.01]
        print("page %2d: %d grid rows, %d with an STT mark, columns %s" % (pg, len(rows), len(data), rows[0].get("x") if rows else None))
