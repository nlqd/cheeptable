#!/usr/bin/env python3
"""Held-out check of two models on pictures of pages from the 594 documents of manifest3_t*.json.
  size/ab3.py OUT.jsonl --lane I --lanes K [--scanned 70 --digital 50 --pages 2]
(run from hillclimb/; serve.py on :8080 and a headless Chrome on port 9340+I; models staged in size/hosted and size/hosted_teacher)
Each sampled page is rendered at 200 dpi and read by both models through the whole app. Scores are word F1 against the page's text
layer (when it has one), the share of the layer's numeric words found exactly, and the F1 of the two models against each other."""
import collections, glob, json, os, random, re, subprocess, sys, unicodedata
import pypdfium2 as pdfium
from PIL import Image

a = sys.argv
opt = lambda k, d: type(d)(a[a.index(k) + 1]) if k in a else d
out, lane, lanes = a[1], opt("--lane", 0), opt("--lanes", 1)
n_scan, n_dig, n_pages = opt("--scanned", 70), opt("--digital", 50), opt("--pages", 2)
tags = opt("--tags", "")                           # e.g. t11,t12: only these manifests, every document
port = 9340 + lane
BASE = "http://localhost:8080"
MODELS = {"student": BASE + "/hillclimb/size/hosted", "teacher": BASE + "/hillclimb/size/hosted_teacher2"}

norm = lambda s: unicodedata.normalize("NFC", s).lower()
words = lambda s: [w for w in re.split(r"\s+", norm(s)) if w]


def sample():
    docs = []
    for f in sorted(glob.glob("../benchmark/manifest3_t*.json")):
        if not tags or f.split("manifest3_")[1][:-5] in tags.split(","):
            docs += json.load(open(f))
    rng = random.Random(7)
    scanned = [e for e in docs if e["born_digital"] is not True or e.get("scan_quality") in ("clean scan", "phone photo", "fax", "mixed")]
    digital = [e for e in docs if e not in scanned]
    rng.shuffle(scanned); rng.shuffle(digital)
    pick = scanned + digital if tags else scanned[:n_scan] + digital[:n_dig]
    jobs = []
    for e in pick:
        if not e["local_path"].lower().endswith(".pdf"):
            jobs.append((e, None))
            continue
        pdf = pdfium.PdfDocument(e["local_path"])
        n = len(pdf)
        for p in rng.sample(range(min(n, 8)), min(n_pages, n, 8)):
            jobs.append((e, p))
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
        subprocess.run(["python3", "ux/e2e.py", BASE + "/docs/index.html", png, dst, "--port", str(port), "--models", models],
                       capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        return None
    if not os.path.exists(dst):
        return None
    toks = []
    for r in json.load(open(dst)):
        for c in r.get("cells", []):
            toks += words(str(c.get("value") if isinstance(c, dict) else c))
    return toks


os.makedirs("size/ab3", exist_ok=True)
done = {(json.loads(l)["id"], json.loads(l)["page"]) for l in open(out)} if os.path.exists(out) else set()
for i, (e, p) in enumerate(sample()):
    if i % lanes != lane or (e["id"], (p or 0) + 1) in done:
        continue
    png = f"size/ab3/{e['id']}_p{(p or 0) + 1}.png"
    if p is None:                                      # a picture, no text layer to compare with
        layer = []
        Image.open(e["local_path"]).convert("RGB").save(png)
        p = 0
    else:
        page = pdfium.PdfDocument(e["local_path"])[p]
        layer = words(page.get_textpage().get_text_range())
        page.render(scale=200 / 72).to_pil().convert("RGB").save(png)
    got = {k: run(png, m, f"size/ab3/{e['id']}_p{p + 1}.{k}.json") for k, m in MODELS.items()}
    rec = {"id": e["id"], "page": p + 1, "scan": e.get("scan_quality"), "category": e.get("category"), "layer_words": len(layer)}
    for k, g in got.items():
        rec[k + "_words"] = None if g is None else len(g)
        rec[k + "_f1"] = f1(layer, g) if g and len(layer) >= 15 else None
        rec[k + "_num"] = number_recall(layer, g) if g and len(layer) >= 15 else None
    rec["agree_f1"] = f1(got["teacher"], got["student"]) if got["student"] and got["teacher"] else None
    open(out, "a").write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(json.dumps(rec, ensure_ascii=False), flush=True)
