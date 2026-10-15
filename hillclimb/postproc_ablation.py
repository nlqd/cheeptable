#!/usr/bin/env python3
"""Does the app's hand-written post-processing (boq-onnx.js _postProcess) help or hurt a padded VietOCR read?
Replays each fix in Python on the saved padded predictions, using each cell's ink width for the word-count estimate."""
import json
import re
import sys

import cv2
import numpy as np

sys.path.insert(0, "..")
import compare_vs_gt as cg
import score

cg.GT_PATH = "golden_v2.xlsx"
gt = cg.load_gt()
pred = {r["stt"]: r["desc"] for r in json.load(open("recog_v3_pad.json"))}
idx = {(r["page"], r["row"]): r for r in json.load(open("/tmp/vocr-cells-real/index.json"))}

TAIL1 = set("thế trị nhau lại năm tháng nha thuận trước nghệ thể nhất trận chính đội nam tế là tc th tp tm tt ch ban hh hhh thuy thị thanh khác t l m la mm".split())
TAIL2 = {"thế trị", "thế trước", "th tp"}
TAILRAW = {"(m", "(s", "(S", "(m2", "(m3"}
YEAR = re.compile(r"^(?:(?:19|20)\d{2}|19|20)$")
PHRASES = [(r"phui mương ống", "phui muông ống"), (r"căn khí nén\b", "cần khi nền"), (r"đấu nối", "đầu nối"),
           (r"Bửng chận", "Bừng chận"), (r"ôtô tự đồ", "ôtô tự đổ"), (r"\bUPVC\b", "uPVC")]


def width_of(g, rowmap):
    r = rowmap.get(g["stt"])
    if not r:
        return 300
    img = cv2.imread("/tmp/vocr-cells-real/" + r["cells"][1], 0)
    xs = np.where((img < 170).any(axis=0))[0]
    return int(xs.max() - xs.min() + 1) if len(xs) else 0


def fix14(text, cropw):
    est = max(1, round(cropw / 55))
    w = text.split()
    if len(w) > est + 3:
        w = w[:est + 2]
    if len(w) > est:
        if len(w) >= 2 and " ".join(w[-2:]).lower() in TAIL2:
            w = w[:-2]
        if len(w) > est and w:
            raw = w[-1]
            t1 = re.sub(r"[.,!?()\[\]]", "", raw.lower())
            if raw in TAILRAW or t1 in TAIL1 or YEAR.match(t1):
                w = w[:-1]
    return " ".join(w)


def fix6(text):
    for pat, rep in PHRASES:
        text = re.sub(pat, rep, text)
    return text


# map stt -> grid row (same pairing as recog.py: reread from the saved pairing is not stored, so rebuild by order of readings)
rowmap = {}
for r in idx.values():
    pass
import recog  # noqa: E402  (pairing helper)
rowmap = recog.pair_rows("/tmp/vocr-cells-real", gt)


def run(label, fn):
    out = []
    for part in ("dev", "test"):
        e = c = ex = n = 0
        for g in gt:
            if score.split_of(g["desc"]) != part:
                continue
            ref = score.norm(g["desc"])
            hyp = score.norm(fn(pred[g["stt"]], width_of(g, rowmap)))
            e += score.lev(ref, hyp); c += len(ref); ex += ref == hyp; n += 1
        out.append("%s CER %.3f exact %.3f" % (part, e / c, ex / n))
    print("%-34s %s" % (label, " | ".join(out)))


run("as read (padded)", lambda t, w: t)
run("+ word-count clip/tail strip (1,4)", lambda t, w: fix14(t, w))
run("+ phrase substitutions (6)", lambda t, w: fix6(t))
run("+ all of the app's fixes", lambda t, w: fix6(fix14(t, w)))

if "--show" in sys.argv:
    n = 0
    for g in gt:
        a, w = pred[g["stt"]], width_of(g, rowmap)
        b = fix14(a, w)
        if a != b and n < 6:
            print("w=%d est=%d\n  in : %s\n  out: %s" % (w, round(w / 55), a[:90], b[:90])); n += 1
