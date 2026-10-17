#!/usr/bin/env python3
"""Run the app on the first pages of every document in benchmark/manifest2.json and record what it finds.
  size/corpus_e2e.py size/OUT.jsonl (run from hillclimb/; --models URL and --rows DIR are optional) [--pages 3]    (serve.py on :8080 and headless Chrome on :9333 must be running; models staged in size/hosted)"""
import json, os, subprocess, sys, tempfile, time
import pypdfium2 as pdfium
a = sys.argv
out, pages = a[1], int(a[a.index("--pages") + 1]) if "--pages" in a else 3
models = a[a.index("--models") + 1] if "--models" in a else "http://localhost:8080/hillclimb/size/hosted"
rows_dir = a[a.index("--rows") + 1] if "--rows" in a else None
if rows_dir:
    os.makedirs(rows_dir, exist_ok=True)
man = json.load(open("../benchmark/manifest2.json"))
done = {json.loads(l)["id"] for l in open(out)} if os.path.exists(out) else set()
for e in man:
    if e["id"] in done:
        continue
    src = pdfium.PdfDocument(e["local_path"])
    dst = pdfium.PdfDocument.new()
    dst.import_pages(src, list(range(min(pages, len(src)))))
    tmp = tempfile.mktemp(suffix=".pdf"); dst.save(tmp)
    j = tempfile.mktemp(suffix=".json")
    t = time.time()
    r = subprocess.run(["python3", "ux/e2e.py", "http://localhost:8080/docs/index.html", tmp, j, "--port", "9333", "--models", models], capture_output=True, text=True, timeout=900)
    last = (r.stdout.strip().splitlines() or [""])[-1]
    rec = {"id": e["id"], "category": e.get("category"), "born_digital": e["born_digital"], "table_style": e.get("table_style"), "pages": min(pages, len(src)), "seconds": round(time.time() - t), "summary": last[:300]}
    if os.path.exists(j):
        rows = json.load(open(j)); rec["engine_rows"] = len(rows)
        if rows_dir:
            json.dump(rows, open(os.path.join(rows_dir, e["id"] + ".json"), "w"), ensure_ascii=False)
    open(out, "a").write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(rec["id"], rec["summary"][:110], flush=True)
