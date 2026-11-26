#!/usr/bin/env python3
"""Mean page F1 and pages at 0.9 or higher, from lane files or a results csv.   run from hillclimb/:  size/pass_rate.py 'size/repro_lane*.jsonl'   or   size/pass_rate.py size/results/pages-final.csv
A page counts when its text layer has 15 words or more; a table page read as nothing scores 0 (the same rule as ab_cmp.py)."""
import csv, glob, json, statistics as st, sys

scores = {}
for path in glob.glob(sys.argv[1]):
    if path.endswith(".csv"):
        for r in csv.DictReader(open(path)):
            if int(r["layer_words"]) >= 15 and r["student_words"] != "":
                scores[(r["id"], r["page"])] = 0.0 if int(r["student_words"]) == 0 else float(r["f1"] or 0)
    else:
        for line in open(path):
            r = json.loads(line)
            if r["layer_words"] >= 15 and r["student_words"] is not None:
                scores[(r["id"], str(r["page"]))] = 0.0 if r["student_words"] == 0 else (r["student_f1"] or 0.0)
print(f"pages {len(scores)}  mean F1 {st.mean(scores.values()):.4f}  at 0.9 or higher {sum(v >= 0.9 for v in scores.values())}")
