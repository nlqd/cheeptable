#!/usr/bin/env python3
"""Table pages of born-digital documents as pictures: both models read the picture, the text layer is the answer key.
  size/ab_pages.py   (run from hillclimb/ after ab.sh and with ab_pages.json written; serve.py and Chrome up)"""
import json, os, subprocess, sys
import pypdfium2 as pdfium
sys.path.insert(0, "size")
import table_ab  # noqa: E402
man = {e["id"]: e for e in json.load(open("../benchmark/manifest2.json"))}
pages = json.load(open("size/ab_pages.json"))
os.makedirs("size/ab_pages", exist_ok=True)
out = []
for id_, pg, _, _, cat in pages:
    png = f"size/ab_pages/{id_}_p{pg}.png"
    pdfium.PdfDocument(man[id_]["local_path"])[pg - 1].render(scale=200 / 72).to_pil().convert("RGB").save(png)
    ref = [r for r in json.load(open(f"size/corpus_rows_student/{id_}.json")) if r.get("page") == pg]
    json.dump(ref, open(f"size/ab_pages/{id_}_p{pg}.ref.json", "w"), ensure_ascii=False)
    rec = {"id": id_, "page": pg, "category": cat}
    for name, models in (("student", "hosted"), ("teacher", "hosted_teacher")):
        o = f"size/ab_pages/{id_}_p{pg}.{name}.json"
        subprocess.run(["python3", "ux/e2e.py", "http://localhost:8080/docs/index.html", png, o, "--port", "9333", "--models", f"http://localhost:8080/hillclimb/size/{models}"], capture_output=True, text=True, timeout=900)
        rec[name] = table_ab.compare(table_ab.rows_of(f"size/ab_pages/{id_}_p{pg}.ref.json"), table_ab.rows_of(o)) if os.path.exists(o) else None
    print(json.dumps(rec, ensure_ascii=False), flush=True)
    out.append(rec)
json.dump(out, open("size/ab_pages_results.json", "w"), ensure_ascii=False)
