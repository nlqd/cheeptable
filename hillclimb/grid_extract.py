#!/usr/bin/env python3
"""Grid-only extraction prototype: ruled-line cell cutter + VietOCR per text line, no text detector.

  grid_extract.py PDF OUT.json [--pages 3,4]
Writes rows in the same shape the app dumps (type/cells/page), so score.py can compare it with the app.
Run with ../venv_onnx_export/bin/python.
"""
import json
import sys

import cv2
import numpy as np
import pypdfium2 as pdfium

import grid
import recog

INK = 170
MIN_BAND_H = 6


def bands(gray, min_gap=3):
    """Split a cell into text lines using the horizontal ink projection."""
    ink = (gray < INK).sum(axis=1) > 0
    out, start, gap = [], None, 0
    for y, on in enumerate(ink):
        if on:
            if start is None:
                start = y
            gap = 0
        elif start is not None:
            gap += 1
            if gap >= min_gap:
                out.append((start, y - gap + 1))
                start, gap = None, 0
    if start is not None:
        out.append((start, len(ink)))
    return [(a, b) for a, b in out if b - a >= MIN_BAND_H]


def read_cell(gray):
    lines = []
    for a, b in bands(gray):
        crop = recog.pad(recog.tight(gray[a:b]), 10)
        lines.append(recog.predictor().predict(recog.to_pil(crop)))
    return " ".join(lines)


def extract(pdf_path, pages=None, scale=2):
    pdf = pdfium.PdfDocument(pdf_path)
    rows = []
    for p in range(len(pdf)):
        if pages and (p + 1) not in pages:
            continue
        img = np.array(pdf[p].render(scale=scale).to_pil().convert("L"))
        ys, xs = grid.find_grid(img)
        if len(xs) < 3 or len(ys) < 3:
            continue
        for r in range(len(ys) - 1):
            y0, y1 = ys[r] + 3, ys[r + 1] - 2
            if y1 - y0 < 12:
                continue
            cells = []
            for c in range(len(xs) - 1):
                x0, x1 = xs[c] + 3, xs[c + 1] - 2
                cells.append(read_cell(img[y0:y1, x0:x1]) if x1 - x0 >= 8 else "")
            if not cells[0].strip():
                continue
            rows.append({"type": "data", "page": p + 1, "cells": [{"value": v} for v in cells]})
        print("page %d: %d rows so far" % (p + 1, len(rows)), file=sys.stderr, flush=True)
    return rows


if __name__ == "__main__":
    pages = None
    if "--pages" in sys.argv:
        pages = {int(x) for x in sys.argv[sys.argv.index("--pages") + 1].split(",")}
    json.dump(extract(sys.argv[1], pages), open(sys.argv[2], "w"))
