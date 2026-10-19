#!/usr/bin/env python3
"""Two runs over the same table pages: size/ab_tab_v1_lane*.jsonl (before) and size/ab_tab_lane*.jsonl (after).  run from hillclimb/
Page F1 against the text layer (a table page read as nothing is 0); pages gained and lost; document pass rate (every page >= 0.9) for each."""
import collections, glob, json, statistics as st, sys
bar = 0.9
def load(pat):
    out = {}
    for f in glob.glob(pat):
        for l in open(f):
            r = json.loads(l)
            if r["layer_words"] < 15 or r["student_words"] is None:
                continue
            out[(r["id"], r["page"])] = 0.0 if r["student_words"] == 0 else (r["student_f1"] or 0.0)
    return out
a, b = load("size/ab_tab_v1_lane*.jsonl"), load("size/ab_tab_lane*.jsonl")
common = sorted(set(a) & set(b))
print(f"pages in both {len(common)}   mean F1 before {st.mean(a[k] for k in common):.3f} after {st.mean(b[k] for k in common):.3f}")
d = [b[k] - a[k] for k in common]
print(f"better {sum(x > 0.01 for x in d)}  worse {sum(x < -0.01 for x in d)}  same {sum(abs(x) <= 0.01 for x in d)}")
for name, run in (("before", a), ("after", b)):
    docs = collections.defaultdict(list)
    for k in common:
        docs[k[0]].append(run[k])
    print(f"{name}: page pass {sum(run[k] >= bar for k in common) / len(common):.3f}  document pass {sum(min(v) >= bar for v in docs.values()) / len(docs):.3f}  ({len(docs)} documents)")
print("\nlargest losses:")
for k in sorted(common, key=lambda k: b[k] - a[k])[:10]:
    print(f"  {a[k]:.3f} -> {b[k]:.3f}  {k[0][:46]} p{k[1]}")
print("\nlargest gains:")
for k in sorted(common, key=lambda k: a[k] - b[k])[:10]:
    print(f"  {a[k]:.3f} -> {b[k]:.3f}  {k[0][:46]} p{k[1]}")
