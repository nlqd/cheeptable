#!/usr/bin/env python3
"""Per-document pass rate from size/ab_tab_lane*.jsonl (the labelled table pages, read by size/ab_all.py --only).  run from hillclimb/:  size/ab_all_report.py [--pass 0.9] [--worst 40]
A page passes when its character 3-gram F1 against the text layer (spaces ignored) is at least --pass. A document passes when every one of its pages does,
so one bad page is enough to fail it. Pages with no scoreable layer (fewer than 15 words) are left out, and so are pages whose layer
is itself corrupt (an embedded bad OCR layer: "Pỉxụ llịc 2", stray backticks and capitals inside words); they are listed so they can be judged by the picture."""
import collections, glob, json, re, statistics as st, sys, unicodedata, zlib

import pypdfium2 as pdfium


a = sys.argv
opt = lambda k, d: type(d)(a[a.index(k) + 1]) if k in a else d
bar, worst_n = opt("--pass", 0.9), opt("--worst", 40)

# Page score: F1 of the character 3-grams of the page's text with all spaces removed. Some PDFs space their glyphs apart
# ("1 5 0 4 3", "Q U AN G"), which makes any word-level comparison against the text layer meaningless; this ignores spacing.
# runs of leader dots, dashes and underscores (blank forms) are collapsed to one: they would otherwise outweigh the words
squash = lambda s: re.sub(r"([.\-_·…])\1+", r"\1", re.sub(r"\s+", "", unicodedata.normalize("NFC", s).lower()))
grams = lambda s: collections.Counter(s[i:i + 3] for i in range(len(s) - 2))
# A text layer is trusted when at least this share of its words (three characters or more) is free of stray symbols and of a capital after a lower-case letter.
# Measured on the 267 table pages read: 265 sit at 0.93 or higher, the two corrupt layers at 0.73 and 0.85.
TRUST = 0.9
stray = re.compile(r"[`\\^|<>{}\[\]~´¨›‹“”]|'(?=\w)")
camel = lambda t: any(a.islower() and b.isupper() for a, b in zip(t, t[1:]))
paths = {e["id"]: e["local_path"] for f in glob.glob("../benchmark/manifest3_t*.json") for e in json.load(open(f))}


def layer_trust(text):
    words = [w for w in unicodedata.normalize("NFC", text).split() if len(w) >= 3]
    return 1.0 if not words else sum(not (stray.search(w) or camel(w)) for w in words) / len(words)


untrusted = []


def gram_f1(doc, page):
    raw = pdfium.PdfDocument(paths[doc])[page - 1].get_textpage().get_text_range()
    if layer_trust(raw) < TRUST:
        untrusted.append((doc, page))
        return None
    ref = squash(raw)
    got = squash("".join(str(c.get("value") if isinstance(c, dict) else c) for row in json.load(open(f"size/aball/{doc}_p{page}.student.json")) for c in row.get("cells", [])))
    if len(ref) < 20 or not got:
        return 0.0 if len(ref) >= 20 else None
    hit = sum((grams(ref) & grams(got)).values())
    return 0.0 if not hit else 2 * hit / (max(len(ref) - 2, 1) + max(len(got) - 2, 1))


pages = {}
for f in sorted(glob.glob("size/ab_tab_lane*.jsonl")):
    for line in open(f):
        r = json.loads(line)
        if r["student_words"] is not None:
            r["student_f1"] = gram_f1(r["id"], r["page"])
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
# --dev / --test: only the documents whose name hashes even / odd (the half that may be looked at while fixing / the half kept for the final number)
if "--dev" in a:
    scored = {d: rs for d, rs in scored.items() if zlib.crc32(d.encode()) % 2 == 0}
if "--test" in a:
    scored = {d: rs for d, rs in scored.items() if zlib.crc32(d.encode()) % 2 == 1}
failed = [r for r in pages.values() if r["student_words"] is None]
for d, p in untrusted:
    print(f"reference layer corrupt, left out: {d} p{p}")
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
