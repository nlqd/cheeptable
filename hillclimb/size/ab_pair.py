#!/usr/bin/env python3
"""Two snapshots of per-page outputs (directories of *.student.json) scored the way ab_all_report.py scores them, page by page.
  size/ab_pair.py BEFORE_DIR AFTER_DIR      run from hillclimb/ (the page set is size/ab_tab_lane*.jsonl or ab_base/)"""
import collections, glob, json, os, re, statistics as st, sys, unicodedata
import pypdfium2 as pdfium

before, after = sys.argv[1], sys.argv[2]
paths = {e["id"]: e["local_path"] for f in glob.glob("../benchmark/manifest3_t*.json") for e in json.load(open(f))}
squash = lambda s: re.sub(r"([.\-_·…])\1+", r"\1", re.sub(r"\s+", "", unicodedata.normalize("NFC", s).lower()))
grams = lambda s: collections.Counter(s[i:i + 3] for i in range(len(s) - 2))
pages = sorted({(json.loads(l)["id"], json.loads(l)["page"]) for f in glob.glob("size/ab_new/ab_tab_lane*.jsonl") for l in open(f)})


def score(d, doc, page, ref):
    try:
        got = squash("".join(str(c.get("value") if isinstance(c, dict) else c) for row in json.load(open(f"{d}/{doc}_p{page}.student.json")) for c in row.get("cells", [])))
    except Exception:
        return None
    hit = sum((grams(ref) & grams(got)).values())
    return 0.0 if not got or not hit else 2 * hit / (max(len(ref) - 2, 1) + max(len(got) - 2, 1))


rows = []
for doc, page in pages:
    ref = squash(pdfium.PdfDocument(paths[doc])[page - 1].get_textpage().get_text_range())
    if len(ref) < 20:
        continue
    a, b = score(before, doc, page, ref), score(after, doc, page, ref)
    if a is not None and b is not None:
        rows.append((b - a, a, b, doc, page))
rows.sort()
print(f"pages {len(rows)}  mean before {st.mean(r[1] for r in rows):.3f} after {st.mean(r[2] for r in rows):.3f}   better {sum(r[0] > 0.01 for r in rows)}  worse {sum(r[0] < -0.01 for r in rows)}")
print("largest losses:");  [print(f"  {a:.3f} -> {b:.3f}  {d[:46]} p{p}") for _, a, b, d, p in rows[:8]]
print("largest gains:");   [print(f"  {a:.3f} -> {b:.3f}  {d[:46]} p{p}") for _, a, b, d, p in rows[::-1][:8]]
