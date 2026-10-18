#!/usr/bin/env python3
"""Summarise size/ab3_lane*.jsonl: new model (student) against the original (teacher) on held-out page pictures.  run from hillclimb/"""
import collections, glob, json, statistics as st

import sys
rows = [json.loads(l) for f in sorted(glob.glob(sys.argv[1] if len(sys.argv) > 1 else "size/ab3_lane*.jsonl")) for l in open(f)]
print("pages", len(rows), "failed student", sum(r["student_words"] is None for r in rows), "failed teacher", sum(r["teacher_words"] is None for r in rows))


def mean(xs):
    xs = [x for x in xs if x is not None]
    return (st.mean(xs), len(xs)) if xs else (float("nan"), 0)


def table(label, sel):
    sub = [r for r in rows if sel(r)]
    if not sub:
        return
    line = [label.ljust(22), str(len(sub)).rjust(4)]
    for k in ("student_f1", "teacher_f1", "student_num", "teacher_num"):
        m, n = mean(r[k] for r in sub)
        line.append(f"{k}={m:.3f}({n})")
    m, n = mean(r["agree_f1"] for r in sub)
    line.append(f"agree={m:.3f}({n})")
    both = [r for r in sub if r["student_f1"] is not None and r["teacher_f1"] is not None]
    d = [r["student_f1"] - r["teacher_f1"] for r in both]
    if d:
        line.append(f"f1 diff mean {st.mean(d):+.4f} better/worse/same {sum(x > 0.005 for x in d)}/{sum(x < -0.005 for x in d)}/{sum(abs(x) <= 0.005 for x in d)}")
    print("  ".join(line))


table("all", lambda r: True)
table("with text layer", lambda r: r["student_f1"] is not None)
for s in sorted({r["scan"] for r in rows if r["scan"]}):
    table("scan=" + s, lambda r, s=s: r["scan"] == s)
cats = collections.Counter(r["category"] for r in rows)
for c, _ in cats.most_common(8):
    table("cat=" + str(c), lambda r, c=c: r["category"] == c)
print("\nlargest regressions of the new model (word F1 vs layer):")
worst = sorted((r for r in rows if r["student_f1"] is not None and r["teacher_f1"] is not None), key=lambda r: r["student_f1"] - r["teacher_f1"])[:8]
for r in worst:
    print(f"  {r['id'][:40]:40} p{r['page']} {r['scan']!s:12} student {r['student_f1']:.3f} teacher {r['teacher_f1']:.3f} agree {r['agree_f1'] or 0:.3f}")
print("\nlowest agreement between the models:")
for r in sorted((r for r in rows if r["agree_f1"] is not None), key=lambda r: r["agree_f1"])[:8]:
    print(f"  {r['id'][:40]:40} p{r['page']} {r['scan']!s:12} agree {r['agree_f1']:.3f} words {r['student_words']}/{r['teacher_words']}")
