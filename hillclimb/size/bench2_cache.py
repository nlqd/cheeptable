#!/usr/bin/env python3
"""Cache the 52-document line crops (see bench2.py) so training runs can score them in seconds.   run from hillclimb/: ../venv_train/bin/python size/bench2_cache.py"""
import json, pickle, random, sys
import numpy as np, pypdfium2 as pdfium
sys.path.insert(0, "."); sys.path.insert(0, "..")
import line_bench as L, robust_sweep_lib as D
CONDS = {"clean": (0, lambda x: x), "rough": (1.5, D.chain(D.rotate(1.5), D.blur(1.2), D.noise(15), D.contrast(0.7), D.jpeg(30)))}
rng = random.Random(0); crops = []
for e in json.load(open("../benchmark/manifest2.json")):
    if e["born_digital"] is not True: continue
    try:
        pdf = pdfium.PdfDocument(e["local_path"]); picks = L.sample_pages(pdf, 3, 25, rng)
    except Exception as ex:
        print("skip", e["id"], ex); continue
    for p, lines in picks:
        page = pdf[p]; base = np.array(page.render(scale=L.SCALE).to_pil().convert("L"))
        for cond, (rot, fn) in CONDS.items():
            D.seed(0); img = fn(base)
            for text, box in lines:
                x0, y0, x1, y1 = L.box_px(box, page.get_height(), rot, img.shape); c = img[y0:y1, x0:x1]
                if c.size: crops.append({"doc": e["id"], "cat": e["category"], "cond": cond, "ref": text, "crop": c})
pickle.dump(crops, open("size/bench2_crops.pkl", "wb")); print(len(crops), "crops from", len({c["doc"] for c in crops}), "documents")
