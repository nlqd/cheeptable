#!/usr/bin/env python3
"""Build the fixed evaluation set for the size hillclimb, once.   make_data.py OUT.pkl
Run from hillclimb/ with ../venv_onnx_export/bin/python (cells from `grid.py ... size/cells --scale 3` must exist).
  contract: every golden row paired with its grid row; crops for description, unit, quantity, price, total (golden values as answers)
  bench:    lines of the public born-digital PDFs, clean and rough, answer = the PDF text layer"""
import pickle
import sys
from pathlib import Path

import cv2

sys.path.insert(0, "..")
sys.path.insert(0, ".")
import compare_vs_gt as cg  # noqa: E402
import recog  # noqa: E402
import score  # noqa: E402
import variant_bench as V  # noqa: E402

out = sys.argv[1]
celldir = Path("size/cells")
cg.GT_PATH = "golden_v2.xlsx"
gt = cg.load_gt()
rows = recog.pair_rows(celldir, gt)
contract = []
for g in gt:
    r = rows.get(g["stt"])
    if not r:
        continue
    cells = [cv2.imread(str(celldir / c), 0) for c in r["cells"]]
    contract.append({"stt": g["stt"], "gt": g, "split": score.split_of(g["desc"]),
                     "crops": {"desc": cells[1], "unit": cells[2], "qty": cells[3], "price": cells[4], "total": cells[5]}})
print("contract rows paired", len(contract), "of", len(gt), flush=True)
bench = V.build_crops(12)
print("bench crops", len(bench), flush=True)
pickle.dump({"contract": contract, "bench": bench}, open(out, "wb"))
