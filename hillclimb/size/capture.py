#!/usr/bin/env python3
"""Keep what the OCR pass hands to the table extractor, so extraction can be tuned without reading the pages again.
  size/capture.py   (from hillclimb/; serve.py on :8080, Chrome on :9333; needs size/ab_pages2.json)
Writes size/lab/<id>_p<page>.json: the words, lines and border cells, and the key (text-layer rows of the same page)."""
import json, os, subprocess, sys, time
import pypdfium2 as pdfium
man = {e["id"]: e for e in json.load(open("../benchmark/manifest2.json"))}
URL = "http://localhost:8080/docs/index.html"
DPI = float(os.environ.get("DPI", "200")); OUTDIR = os.environ.get("OUTDIR", "size/lab"); ONLY = os.environ.get("ONLY", "").split(",") if os.environ.get("ONLY") else None
os.makedirs(OUTDIR, exist_ok=True)
MODELS = "http://localhost:8080/hillclimb/size/hosted"
def rodney(*a, timeout=300):
    r = subprocess.run(["rodney", *a], capture_output=True, text=True, timeout=timeout); return (r.stdout + r.stderr).strip()
rodney("connect", "localhost:9333")
for p in json.load(open("size/ab_pages2.json")):
    if ONLY and f"{p['id']}_p{p['page']}" not in ONLY:
        continue
    out = f"{OUTDIR}/{p['id']}_p{p['page']}.json"
    if os.path.exists(out):
        continue
    png = f"{OUTDIR}/{p['id']}_p{p['page']}.png"
    pdfium.PdfDocument(man[p["id"]]["local_path"])[p["page"] - 1].render(scale=DPI / 72).to_pil().convert("RGB").save(png)
    rodney("open", "about:blank"); rodney("open", URL); rodney("waitload")
    rodney("js", f"(localStorage.setItem('ct.models', '{MODELS}'), localStorage.setItem('ct.mode', 'simple'), localStorage.setItem('ct.lang', 'vi'), 1)")
    rodney("open", URL); rodney("waitload"); time.sleep(0.5)
    rodney("js", "(window.__cap = null, CT.preloadEngine().then(() => { const o = ocrTableExtract; ocrTableExtract = async (lines, words, cells) => { window.__cap = JSON.stringify({ lines, words, cells }); return o(lines, words, cells); }; window.__hooked = true; }), 1)")
    for _ in range(40):
        if rodney("js", "!!window.__hooked") == "true": break
        time.sleep(0.5)
    rodney("file", "#fileInput", png)
    for _ in range(300):
        if rodney("js", "!!(CT.state && (CT.state.done || CT.state.failed)) || !!document.querySelector('.nonehelp') || !document.getElementById('stage-result').hidden") == "true": break
        time.sleep(1)
    cap = rodney("js", "window.__cap || ''")
    ref = [r for r in json.load(open(f"size/corpus_rows_student/{p['id']}.json")) if r.get("page") == p["page"]]
    try:
        data = json.loads(json.loads(cap)) if cap.startswith('"') else json.loads(cap)
    except Exception:
        data = None
    json.dump({"meta": {**p, "dpi": DPI}, "capture": data, "ref": ref}, open(out, "w"), ensure_ascii=False)
    print(p["id"], p["page"], "captured" if data else "NO CAPTURE", flush=True)
