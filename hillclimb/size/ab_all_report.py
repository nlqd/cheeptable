#!/usr/bin/env python3
"""Per-document pass rate from size/ab_tab_lane*.jsonl (the labelled table pages, read by size/ab_all.py --only).  run from hillclimb/:  size/ab_all_report.py [--pass 0.9] [--worst 40]
A page passes when its word F1 against the text layer is at least --pass. A document passes when every one of its pages does,
so one bad page is enough to fail it. Pages with no scoreable layer (fewer than 15 words) are left out."""
import collections, glob, json, statistics as st, sys


a = sys.argv
opt = lambda k, d: type(d)(a[a.index(k) + 1]) if k in a else d
bar, worst_n = opt("--pass", 0.9), opt("--worst", 40)

pages = {}
for f in sorted(glob.glob("size/ab_tab_lane*.jsonl")):
    for line in open(f):
        r = json.loads(line)
        pages[(r["id"], r["page"])] = r
docs = collections.defaultdict(list)
for r in pages.values():
    docs[r["id"]].append(r)

# The pages are the ones labelled as tables (size/labels/page_labels.json, from looking at the pictures); a table page read as nothing is a zero.
no_table = []
for r in pages.values():
    if r["student_words"] == 0 and r["layer_words"] >= 15:
        r["student_f1"], r["student_num"] = 0.0, None
scored = {d: [r for r in rs if r["student_f1"] is not None] for d, rs in docs.items()}
scored = {d: rs for d, rs in scored.items() if rs}
failed = [r for r in pages.values() if r["student_words"] is None]
print(f"pages read {len(pages)}  documents {len(docs)}  scoreable documents {len(scored)}  pages the app failed on {len(failed)}")

page_f1 = [r["student_f1"] for rs in scored.values() for r in rs]
print(f"page pass rate (F1 >= {bar}): {sum(x >= bar for x in page_f1) / len(page_f1):.3f}   mean F1 {st.mean(page_f1):.3f}   median {st.median(page_f1):.3f}")
doc_min = {d: min(r["student_f1"] for r in rs) for d, rs in scored.items()}
print(f"document pass rate (every page >= {bar}): {sum(v >= bar for v in doc_min.values()) / len(doc_min):.3f}")
for t in (0.5, 0.7, 0.8, 0.9, 0.95):
    print(f"  worst page F1 below {t}: {sum(v < t for v in doc_min.values())} documents")

by = collections.defaultdict(list)
for d, rs in scored.items():
    by[rs[0].get("category")].append(doc_min[d])
print("\nper category: documents, share passing, lowest worst-page F1")
for c, v in sorted(by.items(), key=lambda kv: sum(x >= bar for x in kv[1]) / len(kv[1])):
    print(f"  {str(c):24} {len(v):4}  {sum(x >= bar for x in v) / len(v):.2f}  {min(v):.3f}")

print(f"\nworst {worst_n} documents (worst page F1, numbers found):")
for d, v in sorted(doc_min.items(), key=lambda kv: kv[1])[:worst_n]:
    r = min(scored[d], key=lambda r: r["student_f1"])
    num = "-" if r["student_num"] is None else f"{r['student_num']:.2f}"
    print(f"  {v:.3f}  num {num}  p{r['page']:<3} words {r['student_words']}/{r['layer_words']}  {d[:60]}  [{r.get('category')}]")
if failed:
    print("\npages the app failed on:", ", ".join(f"{r['id'][:30]} p{r['page']}" for r in failed[:15]))
