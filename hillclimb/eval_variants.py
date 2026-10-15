#!/usr/bin/env python3
"""Compare encoders end to end on the contract: eval_variants.py QDIR GOLDEN_DIR NAME [NAME ...]
For each page set the golden is cut to the STT range seen in the fp32 run (rows copied by value)."""
import json
import subprocess
import sys

import openpyxl

sys.path.insert(0, "..")
sys.path.insert(0, ".")
import score  # noqa: E402

PDF = "../7. Biểu giá HĐ.pdf"
PAGESETS = {"p3-4": "3,4", "p8-9": "8,9"}
qdir, gdir, names = sys.argv[1], sys.argv[2], sys.argv[3:]


def run(enc, pages, out):
    subprocess.run(["../venv_onnx_export/bin/python", "run_with_encoder.py", enc, PDF, out, "--pages", pages],
                   check=True, capture_output=True)


def cut_golden(rows_json, dst):
    stts = [int(r["cells"][0]["value"]) for r in json.load(open(rows_json)) if r["cells"][0]["value"].isdigit()]
    lo, hi = min(stts), max(stts)
    out = openpyxl.Workbook()
    ws = out.active
    for row in openpyxl.load_workbook("golden_v2.xlsx", data_only=True).active.iter_rows(values_only=True):
        try:
            if lo <= int(str(row[0]).strip()) <= hi:
                ws.append(row[:6])
        except ValueError:
            pass
    out.save(dst)


for label, pages in PAGESETS.items():
    gold = None
    for name in names:
        out = "%s/%s_%s.json" % (qdir, label, name)
        run("torch" if name == "torch" else "%s/enc_%s.onnx" % (qdir, name), pages, out)
        if gold is None:
            gold = "%s/golden_%s.xlsx" % (gdir, label)
            cut_golden(out, gold)
        r = score.report(out, gold)
        print("%-5s %-10s" % (label, name), " | ".join(
            "%s all3 %.3f exact %.3f cer %.3f" % (k, r[k]["all3"], r[k]["desc_exact"], r[k]["cer"]) for k in ("dev", "test", "all")),
            flush=True)
