#!/usr/bin/env python3
"""Every born-digital PDF of manifest3_t*.json: three page pictures each (first, middle, last), read through the whole app.
  size/ab_all.py OUT.jsonl --lane I --lanes K [--labcache TAG]
(run from hillclimb/; serve.py on :8080 and a headless Chrome on port 9340+I; model staged in size/hosted)
Scores are word F1 against the page's text layer and the share of the layer's numeric words found exactly."""
import collections, glob, json, os, random, re, subprocess, sys, unicodedata
import pypdfium2 as pdfium
from PIL import Image

a = sys.argv
opt = lambda k, d: type(d)(a[a.index(k) + 1]) if k in a else d
out, lane, lanes = a[1], opt("--lane", 0), opt("--lanes", 1)
n_scan, n_dig, n_pages = opt("--scanned", 70), opt("--digital", 50), opt("--pages", 3)
labcache = opt("--labcache", "")                   # a tag: reads of unchanged crops are reused (docs/boq-onnx.js, lab only); change it with the model
ids = opt("--ids", "")                             # e.g. doc1,doc2: only these documents (every sampled page of them)
tags = opt("--tags", "")                           # e.g. t11,t12: only these manifests, every document
port = 9340 + lane
BASE = opt("--base", "http://localhost:8080")            # --base URL: another server (the live code in a worktree, say)
AB = opt("--aball", "size/aball")                          # --aball DIR: where the page pictures and reads go
MODELS = {"student": BASE + "/hillclimb/size/" + opt("--hosted", "hosted")}   # --hosted DIR: another staged copy of the models

norm = lambda s: unicodedata.normalize("NFC", s).lower()
words = lambda s: [w for w in re.split(r"\s+", norm(s)) if w]


def sample():
    if "--only" in a:                                   # just the pages that size/labels/page_labels.json calls tables
        want = {(o["id"], o["page"]) for o in json.load(open("size/labels/page_labels.json")) if o["label"] == "table"}
        by_id = {e["id"]: e for f in glob.glob("../benchmark/manifest3_t*.json") for e in json.load(open(f))}
        return [(by_id[i], p - 1) for i, p in sorted(want)]
    docs = []
    for f in sorted(glob.glob("../benchmark/manifest3_t*.json")):
        docs += json.load(open(f))
    docs = [e for e in docs if e["born_digital"] is True and e["local_path"].lower().endswith(".pdf")]
    if ids:
        docs = [e for e in docs if e["id"] in ids.split(",")]
    jobs = []
    for e in docs:
        n = len(pdfium.PdfDocument(e["local_path"]))
        picks = sorted({0, n // 2, n - 1}) if n_pages >= 3 else [0]
        jobs += [(e, p) for p in picks[:n_pages]]
    return jobs


def f1(ref, hyp):
    r, h = collections.Counter(ref), collections.Counter(hyp)
    hit = sum((r & h).values())
    if not ref or not hyp:
        return None
    p, q = hit / sum(h.values()), hit / sum(r.values())
    return 2 * p * q / (p + q) if p + q else 0.0


def number_recall(ref, hyp):
    nums = [w for w in ref if re.search(r"\d", w) and len(w) >= 3]
    if len(nums) < 5:
        return None
    h = collections.Counter(hyp)
    need = collections.Counter(nums)
    return sum((need & h).values()) / len(nums)


def run(png, models, dst):
    if os.path.exists(dst):
        os.remove(dst)
    try:
        subprocess.run(["python3", "ux/e2e.py", BASE + "/docs/index.html", png, dst, "--port", str(port), "--models", models, *(["--labcache", labcache] if labcache else [])],
                       capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        return None
    if not os.path.exists(dst):
        return None
    data = json.load(open(dst))
    if not isinstance(data, list):
        return None
    toks = []
    for r in data:
        for c in r.get("cells", []):
            toks += words(str(c.get("value") if isinstance(c, dict) else c))
    return toks


os.makedirs(AB, exist_ok=True)
done = {(json.loads(l)["id"], json.loads(l)["page"]) for l in open(out)} if os.path.exists(out) else set()
for i, (e, p) in enumerate(sample()):
    if i % lanes != lane or (e["id"], (p or 0) + 1) in done:
        continue
    png = f"{AB}/{e['id']}_p{(p or 0) + 1}.png"
    if p is None:                                      # a picture, no text layer to compare with
        layer = []
        Image.open(e["local_path"]).convert("RGB").save(png)
        p = 0
    else:
        page = pdfium.PdfDocument(e["local_path"])[p]
        layer = words(page.get_textpage().get_text_range())
        page.render(scale=200 / 72).to_pil().convert("RGB").save(png)
    got = {k: run(png, m, f"{AB}/{e['id']}_p{p + 1}.{k}.json") for k, m in MODELS.items()}
    rec = {"id": e["id"], "page": p + 1, "scan": e.get("scan_quality"), "category": e.get("category"), "layer_words": len(layer)}
    for k, g in got.items():
        rec[k + "_words"] = None if g is None else len(g)
        rec[k + "_f1"] = f1(layer, g) if g and len(layer) >= 15 else None
        rec[k + "_num"] = number_recall(layer, g) if g and len(layer) >= 15 else None
        open(out, "a").write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(json.dumps(rec, ensure_ascii=False), flush=True)
