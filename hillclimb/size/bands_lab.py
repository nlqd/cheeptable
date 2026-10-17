"""Do the text-line bands cut out of a table cell match the lines the text layer says it holds?   bands_lab.py [--split dev]
Truth: distinct text lines (by character y) of the PDF page inside each grid cell. Candidate: gridTextBands as in docs/boq-grid.js,
optionally followed by splitting bands that are too tall for one line."""
import json, os, sys, collections
import numpy as np, pypdfium2 as pdfium
from PIL import Image
MAN = {e["id"]: e for e in json.load(open("../../benchmark/manifest2.json"))}
F = 1654 / 1191          # full size over the size the grid was found at, as in findGrid

def bands(row_ink, min_gap, min_h):
    out, start, last, gap = [], None, 0, 0
    for y, v in enumerate(row_ink):
        if v:
            if start is None: start = y
            last, gap = y, 0
        elif start is not None:
            gap += 1
            if gap >= min_gap: out.append((start, last + 1)); start, gap = None, 0
    if start is not None: out.append((start, last + 1))
    return [b for b in out if b[1] - b[0] >= min_h]

def split_tall(bs, counts, h_est, ratio=1.7, window=0.3):
    out = []
    for a, b in bs:
        h = b - a
        if h < ratio * h_est: out.append((a, b)); continue
        n = max(2, round(h / h_est)); cuts = []
        for k in range(1, n):
            t = a + k * h / n; lo, hi = int(t - window * h_est), int(t + window * h_est)
            c = min(range(max(a + 2, lo), min(b - 2, hi) + 1), key=lambda r: (counts[r], abs(r - t)))
            cuts.append(c)
        p = a
        for c in cuts + [b]:
            if c - p >= 3: out.append((p, c))
            p = c
    return out

def truth_lines(page, H, rect):
    x0, y0, x1, y1 = rect                      # points, y from top
    tp = page.get_textpage(); ys = []
    for i in range(tp.count_chars()):
        l, b, r, t = tp.get_charbox(i)
        cx, cy = (l + r) / 2, H - (b + t) / 2
        if x0 <= cx <= x1 and y0 <= cy <= y1 and tp.get_text_range(i, 1).strip(): ys.append(cy)
    ys.sort(); lines = 0; last = None
    for y in ys:
        if last is None or y - last > 4: lines += 1
        last = y
    return lines

def run(split=None, h_mode="p30", ratio=1.7, window=0.3, verbose=False):
    tot = collections.Counter(); per = {}
    for f in sorted(os.listdir("lab")):
        if not f.endswith(".json"): continue
        j = json.load(open("lab/" + f)); cap = j["capture"]
        if not cap or not cap["cells"] or (split and j["meta"]["split"] != split): continue
        page = pdfium.PdfDocument(MAN[j["meta"]["id"]]["local_path"])[j["meta"]["page"] - 1]; H = page.get_height()
        img = np.array(Image.open("lab/" + f[:-5] + ".png").convert("L")); s = 200 / 72
        cells = [c for c in cap["cells"]]
        info = []
        for c in cells:
            x, y, w, h = int(c["x"] * s), int(c["y"] * s), int(c["width"] * s), int(c["height"] * s)
            sub = img[y:y + h, x:x + w]
            counts = (sub < 170).sum(axis=1); ink = counts > 0
            bs = bands(ink, max(2, round(3 * F)), round(6 * F))
            info.append((c, bs, counts))
        heights = [b - a for _, bs, _ in info for a, b in bs]
        if heights and h_mode:
            h_est = float(np.percentile(heights, int(h_mode[1:])))
        for c, bs, counts in info:
            if h_mode and heights: bs = split_tall(bs, counts, h_est, ratio, window)
            t = truth_lines(page, H, (c["x"], c["y"], c["x"] + c["width"], c["y"] + c["height"]))
            n = len(bs)
            tot["cells_with_text" if t else "cells_empty"] += 1
            if t:
                tot["exact"] += (n == t); tot["under"] += (n < t); tot["over"] += (n > t); tot["lines_true"] += t; tot["lines_found"] += min(n, t)
        per[f[:-5]] = None
    return tot

if __name__ == "__main__":
    split = sys.argv[sys.argv.index("--split") + 1] if "--split" in sys.argv else None
    for mode, ratio, window in [(None, 1.7, .3), ("p70", 1.7, .3), ("p70", 1.9, .3), ("p80", 1.7, .3)]:
        t = run(split, mode, ratio, window)
        print("%-5s ratio %.1f window %.2f: exact %.4f too few %.4f too many %.4f | true lines found %.4f" % (mode or "none", ratio, window, t["exact"] / t["cells_with_text"], t["under"] / t["cells_with_text"], t["over"] / t["cells_with_text"], t["lines_found"] / max(t["lines_true"], 1)), flush=True)
