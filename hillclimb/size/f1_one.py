#!/usr/bin/env python3
"""Read one labelled page picture again with the current code and print its word F1 next to the earlier one.
  size/f1_one.py DOC PAGE [PORT]        (run from hillclimb/ with RODNEY_HOME set for that port's browser)"""
import collections, glob, json, re, subprocess, sys, unicodedata
import pypdfium2 as pdfium
doc, page, port = sys.argv[1], int(sys.argv[2]), sys.argv[3] if len(sys.argv) > 3 else "9341"
norm = lambda s: unicodedata.normalize("NFC", s).lower()
words = lambda s: [w for w in re.split(r"\s+", norm(s)) if w]
def f1(ref, got):
    hit = sum((collections.Counter(ref) & collections.Counter(got)).values())
    return 0 if not hit else 2 * hit / (len(ref) + len(got))
def tokens(path):
    t = []
    for row in json.load(open(path)):
        for c in row.get("cells", []):
            t += words(str(c.get("value") if isinstance(c, dict) else c))
    return t
path = {e["id"]: e["local_path"] for f in glob.glob("../benchmark/manifest3_t*.json") for e in json.load(open(f))}[doc]
ref = words(pdfium.PdfDocument(path)[page - 1].get_textpage().get_text_range())
old = f"size/aball/{doc}_p{page}.student.json"
new = f"/tmp/one_{doc}_{page}.json"
subprocess.run(["python3", "ux/e2e.py", "http://localhost:8080/docs/index.html", f"size/aball/{doc}_p{page}.png", new, "--port", port, "--models", "http://localhost:8080/hillclimb/size/hosted"], capture_output=True, text=True, timeout=300)
print(f"{doc} p{page}: F1 before {f1(ref, tokens(old)):.3f}  after {f1(ref, tokens(new)):.3f}")
