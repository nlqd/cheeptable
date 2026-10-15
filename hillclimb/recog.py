#!/usr/bin/env python3
"""Recognizer experiments on table cells (run with venv_paddle311, which has torch + vietocr).

  recog.py CELLDIR GOLDEN.xlsx VARIANT [VARIANT...]
CELLDIR comes from grid.py. Each variant turns a cell crop into text; all are scored with score.py's
metrics on the dev/test split of the golden file. Decisions use dev only.
"""
import json
import re
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))  # compare_vs_gt.py lives in the project root
import compare_vs_gt as cg  # noqa: E402
import score  # noqa: E402
from vietocr.tool.config import Cfg  # noqa: E402
from vietocr.tool.predictor import Predictor  # noqa: E402

_PRED = {}


def predictor(beam=False):
    if beam not in _PRED:
        cfg = Cfg.load_config_from_name("vgg_transformer")
        cfg["device"] = "cpu"
        cfg["predictor"]["beamsearch"] = beam
        cfg["cnn"]["pretrained"] = False
        _PRED[beam] = Predictor(cfg)
    return _PRED[beam]


def to_pil(gray):
    return Image.fromarray(gray).convert("RGB")


def chunks(gray, max_ratio=12.0, min_gap=6):
    """Split a text-line crop at blank vertical gaps so no piece is wider than max_ratio x its height."""
    h, w = gray.shape
    if w <= max_ratio * h:
        return [gray]
    ink = (gray < 170).any(axis=0)
    # candidate cut positions: centres of blank runs at least min_gap wide
    cuts, run = [], 0
    for x in range(w):
        if not ink[x]:
            run += 1
        else:
            if run >= min_gap:
                cuts.append(x - run // 2)
            run = 0
    out, start = [], 0
    for c in cuts:
        # extend the current piece until the next cut would exceed the limit
        pass
    pieces, start, last_ok = [], 0, None
    for c in cuts + [w]:
        if c - start > max_ratio * h and last_ok is not None and last_ok > start:
            pieces.append(gray[:, start:last_ok])
            start = last_ok
        last_ok = c
    pieces.append(gray[:, start:w])
    return [tight(p) for p in pieces if (p < 170).any()]


def tight(gray, margin=3):
    """Crop to the ink bounding box, like a text detector's box would, instead of the whole cell."""
    ys, xs = np.where(gray < 170)
    if len(xs) == 0:
        return gray
    y0, y1 = max(ys.min() - margin, 0), min(ys.max() + margin + 1, gray.shape[0])
    x0, x1 = max(xs.min() - margin, 0), min(xs.max() + margin + 1, gray.shape[1])
    return gray[y0:y1, x0:x1]


def pad(gray, px):
    return cv2.copyMakeBorder(gray, 0, 0, px, px, cv2.BORDER_CONSTANT, value=255)


def read(gray, variant):
    """Variant is a '+'-joined recipe, e.g. 'pad10+chunk' or 'padv12+beam'. Base: tight crop, one read."""
    gray = tight(gray)
    opts = variant.split("+")
    beam = "beam" in opts
    px = next((int(o[3:]) for o in opts if re.fullmatch(r"pad\d+", o)), 0)      # white margin left and right
    pv = next((int(o[4:]) for o in opts if re.fullmatch(r"padv\d+", o)), 0)     # white margin on all four sides
    parts = chunks(gray) if "chunk" in opts else [gray]
    out = []
    for c in parts:
        if px:
            c = pad(c, px)
        if pv:
            c = cv2.copyMakeBorder(c, pv, pv, pv, pv, cv2.BORDER_CONSTANT, value=255)
        out.append(predictor(beam).predict(to_pil(c)))
    return " ".join(out)


def pair_rows(celldir, gt_rows):
    """Pair grid rows with golden rows: read each candidate row's STT cell, then repair misreads from the
    fact that STT numbers run consecutively (a candidate between STT a and b with b-a-1 candidates gets the gap)."""
    idx = json.load(open(Path(celldir) / "index.json"))
    wanted = sorted({g["stt"] for g in gt_rows})
    cand = []
    for r in idx:
        if r.get("stt_ink", 0) <= 0.03:
            continue
        img = cv2.imread(str(Path(celldir) / r["cells"][0]), 0)
        txt = re.sub(r"\D", "", predictor().predict(to_pil(pad(img, 6))))
        cand.append((r, int(txt) if txt and int(txt) in wanted else None))
    # drop header and section rows: they read as no number AND sit outside any run of consecutive numbers
    rows, i = {}, 0
    reads = [(k, v) for k, (r, v) in enumerate(cand) if v is not None]
    for (k1, a), (k2, b) in zip(reads, reads[1:]):
        gap = [c for c in cand[k1 + 1:k2] if c[1] is None]
        if b - a - 1 == len(gap) and len(gap) > 0:
            for off, c in enumerate(gap, 1):
                cand[cand.index(c)] = (c[0], a + off)
    for r, v in cand:
        if v is not None and v not in rows:
            rows[v] = r
    return rows


def main(celldir, gt_path, variants):
    cg.GT_PATH = gt_path
    gt_rows = cg.load_gt()
    t = time.time()
    rows = pair_rows(celldir, gt_rows)
    print("paired %d/%d golden rows by STT reading (%.0fs)" % (len(rows), len(gt_rows), time.time() - t), flush=True)
    results = {}
    for v in variants:
        t = time.time()
        pairs = []
        for g in gt_rows:
            r = rows.get(g["stt"])
            if not r:
                pairs.append((g, None))
                continue
            cells = [cv2.imread(str(Path(celldir) / c), 0) for c in r["cells"]]
            texts = [str(g["stt"]), read(cells[1], v), read(cells[2], "pad10"), read(cells[3], "pad10"),
                     read(cells[4], "pad10"), read(cells[5], "pad10")]
            pairs.append((g, [texts[0], texts[1], texts[2], texts[3], texts[4], texts[5]]))
        # reorder so score.metrics sees [stt, desc, unit, qty, price, total]
        out = {"all": score.metrics(pairs)}
        for part in ("dev", "test"):
            out[part] = score.metrics([(g, o) for g, o in pairs if score.split_of(g["desc"]) == part])
        results[v] = out
        print("\n== %s (%.0fs)" % (v, time.time() - t))
        for part in ("dev", "test"):
            m = out[part]
            print("  %-5s rows %3d  desc CER %.3f  exact %.3f  tone-only %.3f | qty %.3f price %.3f total %.3f unit %.3f" % (
                part, m["rows"], m["cer"], m["desc_exact"], m["tone_only_err"], m["qty"], m["price"], m["total"], m["unit"]), flush=True)
        json.dump([{"stt": g["stt"], "desc": o[1] if o else None} for g, o in pairs], open("recog_%s.json" % v, "w"), ensure_ascii=False)
    return results


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3:])
