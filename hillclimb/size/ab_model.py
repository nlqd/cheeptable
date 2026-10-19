#!/usr/bin/env python3
"""Same pictures, same page code (the working copy), two models: head = y16 (live), new = z1.
  size/ab_model.py OUT.jsonl --lane I --lanes K     (run from hillclimb/; serve.py on :8080, headless Chrome on port 9340+I;
                                                    the committed code is unpacked in size/head_docs/docs)
Pages are the pictures already cut by ab3.py (size/ab3/*.png) listed in size/ab3_lane*.jsonl and size/ab3n_lane*.jsonl.
Scores: word F1 against the page's text layer when it has one, and F1 of the two versions against each other."""
import collections, glob, json, os, re, subprocess, sys, unicodedata
import pypdfium2 as pdfium
a = sys.argv
opt = lambda k, d: type(d)(a[a.index(k) + 1]) if k in a else d
out, lane, lanes = a[1], opt("--lane", 0), opt("--lanes", 1)
port = 9340 + lane
BASE = "http://localhost:8080"
PAGE = BASE + "/docs/index.html"
MODELS = {"head": BASE + "/hillclimb/size/hosted", "new": BASE + "/hillclimb/size/hosted_z1"}      # head = y16, new = z1
norm = lambda s: unicodedata.normalize("NFC", s).lower()
words = lambda s: [w for w in re.split(r"\s+", norm(s)) if w]
man = {e["id"]: e for f in glob.glob("../benchmark/manifest3_t*.json") for e in json.load(open(f))}
man.update({e["id"]: e for e in json.load(open("../benchmark/manifest2.json"))})


def f1(ref, hyp):
    r, h = collections.Counter(ref), collections.Counter(hyp)
    hit = sum((r & h).values())
    if not ref or not hyp or not hit:
        return None if not ref or not hyp else 0.0
    p, q = hit / sum(h.values()), hit / sum(r.values())
    return 2 * p * q / (p + q)


def run(models, png, dst):
    if os.path.exists(dst):
        os.remove(dst)
    try:
        subprocess.run(["python3", "ux/e2e.py", PAGE, png, dst, "--port", str(port), "--models", models], capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        return None
    if not os.path.exists(dst):
        return None
    toks = []
    for r in json.load(open(dst)):
        for c in r.get("cells", []):
            toks += words(str(c.get("value") if isinstance(c, dict) else c))
    return toks


recs = [json.loads(l) for f in sorted(glob.glob("size/ab3_lane*.jsonl") + glob.glob("size/ab3n_lane*.jsonl")) for l in open(f)]
recs = [r for r in recs if (r.get("student_words") or 0) > 0]          # pages where the app found rows
done = {(json.loads(l)["id"], json.loads(l)["page"]) for l in open(out)} if os.path.exists(out) else set()
os.makedirs("size/ab_model", exist_ok=True)
for i, r in enumerate(recs):
    if i % lanes != lane or (r["id"], r["page"]) in done:
        continue
    png = f"size/ab3/{r['id']}_p{r['page']}.png"
    if not os.path.exists(png):
        continue
    e = man.get(r["id"])
    layer = []
    if e and e["local_path"].lower().endswith(".pdf"):
        try:
            layer = words(pdfium.PdfDocument(e["local_path"])[r["page"] - 1].get_textpage().get_text_range())
        except Exception:
            layer = []
    got = {k: run(m, png, f"size/ab_model/{r['id']}_p{r['page']}.{k}.json") for k, m in MODELS.items()}
    rec = {"id": r["id"], "page": r["page"], "scan": r.get("scan"), "layer_words": len(layer)}
    for k, g in got.items():
        rec[k + "_words"] = None if g is None else len(g)
        rec[k + "_f1"] = f1(layer, g) if g and len(layer) >= 15 else None
    rec["agree_f1"] = f1(got["head"], got["new"]) if got["head"] and got["new"] else None
    open(out, "a").write(json.dumps(rec, ensure_ascii=False) + "\n")
