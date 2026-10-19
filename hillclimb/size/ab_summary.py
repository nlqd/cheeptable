#!/usr/bin/env python3
"""Summarise an A/B run (ab_code.py, ab_model.py, ab_final.py): size/ab_summary.py 'size/ab_final_lane*.jsonl'"""
import glob, json, statistics as st, sys
r = [json.loads(l) for f in sorted(glob.glob(sys.argv[1])) for l in open(f)]
print(len(r), "pages; failed head/new", sum(x["head_words"] is None for x in r), sum(x["new_words"] is None for x in r))
d = [x["new_f1"] - x["head_f1"] for x in r if x["new_f1"] is not None and x["head_f1"] is not None]
if d:
    print("against the text layer: %d pages, mean diff %+.4f, new better/worse/same %d/%d/%d" % (len(d), st.mean(d), sum(v > 0.005 for v in d), sum(v < -0.005 for v in d), sum(abs(v) <= 0.005 for v in d)))
ag = [x["agree_f1"] for x in r if x["agree_f1"] is not None]
print("agreement mean %.3f, identical %d of %d" % (st.mean(ag), sum(a > 0.999 for a in ag), len(ag)))
