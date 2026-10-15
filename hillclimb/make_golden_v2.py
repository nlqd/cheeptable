#!/usr/bin/env python3
"""golden.xlsx -> golden_v2.xlsx: apply the description fixes found by auditing every golden row against
the page images (4 independent readers, high and medium confidence; whitespace-only findings skipped).
Also writes golden_changes.tsv listing every changed row."""
import glob
import json
import re
import openpyxl

wb = openpyxl.load_workbook("../golden.xlsx")
ws = wb.active
fixes = {}
for f in sorted(glob.glob("audit_p*.jsonl")):
    for line in open(f):
        if line.strip():
            r = json.loads(line)
            if r["field"] == "desc" and r["confidence"] in ("high", "medium"):
                fixes[int(r["stt"])] = re.sub(r"\s+", " ", r["seen"]).strip()
changes = []
for row in ws.iter_rows(min_row=1):
    stt = row[0].value
    if isinstance(stt, (int, float)) and int(stt) in fixes:
        old = row[1].value
        row[1].value = fixes[int(stt)]
        changes.append((int(stt), old, row[1].value))
wb.save("golden_v2.xlsx")
with open("golden_changes.tsv", "w") as f:
    f.write("stt\told\tnew\n" + "".join("%d\t%s\t%s\n" % c for c in changes))
print(len(changes), "rows changed of", len(fixes), "fixes")
