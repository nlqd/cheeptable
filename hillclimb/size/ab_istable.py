#!/usr/bin/env python3
"""Which of the pages ab_all.py read are tables? Ask the app itself, on the page as a one-page PDF (its text-layer path, no OCR).
  size/ab_istable.py OUT.jsonl --lane I --lanes K      (run from hillclimb/; same servers and browsers as ab_all.py)
A page is a table when the app, given the PDF, keeps rows for it. The rows it reads from the text layer are also saved:
they are exact, so they are the reference to compare the picture's reading against."""
import glob, json, os, subprocess, sys

import pypdfium2 as pdfium

a = sys.argv
opt = lambda k, d: type(d)(a[a.index(k) + 1]) if k in a else d
out, lane, lanes = a[1], opt("--lane", 0), opt("--lanes", 1)
port, BASE = 9340 + lane, "http://localhost:8080"
paths = {e["id"]: e["local_path"] for f in glob.glob("../benchmark/manifest3_t*.json") for e in json.load(open(f))}
jobs = sorted({(json.loads(l)["id"], json.loads(l)["page"]) for f in glob.glob("size/ab_all_lane*.jsonl") for l in open(f)})
done = {(json.loads(l)["id"], json.loads(l)["page"]) for l in open(out)} if os.path.exists(out) else set()
os.makedirs("size/aball", exist_ok=True)
for i, (doc, page) in enumerate(jobs):
    if i % lanes != lane or (doc, page) in done:
        continue
    one = f"size/aball/{doc}_p{page}.pdf"
    src = pdfium.PdfDocument(paths[doc])
    dst = pdfium.PdfDocument.new()
    dst.import_pages(src, [page - 1])
    dst.save(one)
    res = f"size/aball/{doc}_p{page}.pdfpath.json"
    if os.path.exists(res):
        os.remove(res)
    try:
        subprocess.run(["python3", "ux/e2e.py", BASE + "/docs/index.html", one, res, "--port", str(port), "--models", BASE + "/hillclimb/size/hosted"],
                       capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        pass
    rows = json.load(open(res)) if os.path.exists(res) else None
    rows = rows if isinstance(rows, list) else None
    rec = {"id": doc, "page": page, "pdf_rows": None if rows is None else len(rows)}
    open(out, "a").write(json.dumps(rec) + "\n")
    print(json.dumps(rec), flush=True)
