#!/usr/bin/env python3
"""How skewed are real scans, and does the grid finder cope?  scan_survey.py
For up to 3 pages of each image-only PDF in the corpus: estimate skew from near-horizontal line segments (median angle of
HoughLinesP on the binarised page), then run the grid finder. Run with ../venv_onnx_export/bin/python from hillclimb/."""
import json
import sys

import cv2
import numpy as np
import pypdfium2 as pdfium

sys.path.insert(0, ".")
import grid  # noqa: E402

for e in json.load(open("../benchmark/manifest.json")):
    if e["born_digital"] is True:
        continue
    pdf = pdfium.PdfDocument(e["local_path"])
    n = len(pdf)
    picks = sorted({min(n - 1, max(0, int(x))) for x in np.linspace(1, n - 2, 3)}) if n > 3 else list(range(n))
    out = []
    for p in picks:
        img = np.array(pdf[p].render(scale=2).to_pil().convert("L"))
        bw = cv2.adaptiveThreshold(img, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 25, 10)
        lines = cv2.HoughLinesP(bw, 1, np.pi / 720, 200, minLineLength=img.shape[1] // 4, maxLineGap=10)
        angles = []
        if lines is not None:
            for x1, y1, x2, y2 in lines[:, 0]:
                a = np.degrees(np.arctan2(y2 - y1, x2 - x1))
                if abs(a) < 8:
                    angles.append(a)
        skew = float(np.median(angles)) if len(angles) >= 3 else None
        ys, xs, _ = grid.find_grid2(img)
        out.append("p%d skew %s grid %dx%d" % (p + 1, "%.2f" % skew if skew is not None else " n/a", max(len(xs) - 1, 0), max(len(ys) - 1, 0)))
    print("%-34s %s" % (e["id"][:34], " | ".join(out)))
