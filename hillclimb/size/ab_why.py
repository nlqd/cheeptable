#!/usr/bin/env python3
"""For the pages of size/ab_tab_lane*.jsonl below the pass mark: how much of the page's text did the app find (recall), how much of what it
wrote is on the page (precision)?  run from hillclimb/:  size/ab_why.py [--pass 0.9]
low recall = content missed; low precision = junk or invented text; both middling = characters misread."""
import collections, glob, json, re, sys, unicodedata, zlib
import pypdfium2 as pdfium
a = sys.argv
bar = float(a[a.index("--pass") + 1]) if "--pass" in a else 0.9
# Development half: documents whose name hashes even. The other half is kept unexamined for the final report; --all lists both.
dev = lambda doc: "--all" in a or zlib.crc32(doc.encode()) % 2 == 0
norm = lambda s: unicodedata.normalize("NFC", s).lower()
words = lambda s: [w for w in re.split(r"\s+", norm(s)) if w]
paths = {e["id"]: e["local_path"] for f in glob.glob("../benchmark/manifest3_t*.json") for e in json.load(open(f))}
out = []
for f in sorted(glob.glob("size/ab_tab_lane*.jsonl")):
    for l in open(f):
        r = json.loads(l)
        if r["student_words"] is None or r["layer_words"] < 15 or not dev(r["id"]):
            continue
        got = []
        for row in json.load(open(f"size/aball/{r['id']}_p{r['page']}.student.json")):
            for c in row.get("cells", []):
                got += words(str(c.get("value") if isinstance(c, dict) else c))
        ref = words(pdfium.PdfDocument(paths[r["id"]])[r["page"] - 1].get_textpage().get_text_range())
        hit = sum((collections.Counter(ref) & collections.Counter(got)).values())
        rec, prec = hit / max(len(ref), 1), hit / max(len(got), 1)
        f1 = 2 * rec * prec / (rec + prec) if rec + prec else 0
        if f1 >= bar:
            continue
        kind = "read nothing" if not got else "missed content" if rec < 0.6 and prec >= 0.7 else "junk or invented" if prec < 0.6 and rec >= 0.7 else "both low" if rec < 0.6 and prec < 0.6 else "misread characters"
        out.append((kind, f1, rec, prec, r["id"], r["page"], len(ref), len(got), r.get("category")))
c = collections.Counter(o[0] for o in out)
print(len(out), "pages below", bar, dict(c))
for kind in c:
    print("\n==", kind)
    for o in sorted((o for o in out if o[0] == kind), key=lambda o: o[1])[:14]:
        print(f"  F1 {o[1]:.2f} rec {o[2]:.2f} prec {o[3]:.2f} ref {o[6]:4} got {o[7]:4} p{o[5]:<4} {o[4][:44]} [{o[8]}]")
