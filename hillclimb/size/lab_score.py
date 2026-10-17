#!/usr/bin/env python3
"""Score lab_out rows against the text-layer key.   lab_score.py [OUTDIR] [--split dev|test]
  token F1: bag of words of the page, key against output (reading and finding the text, nothing about layout)
  pair F1: adjacent cell pairs. A pair (a, b) of cells in an output row counts when some key row holds a then b as cells (fuzzy,
           spaces ignored); the key's pairs count the other way. Wrapped cells do not hurt it, wrong splits and merges do."""
import collections, json, os, re, sys, unicodedata
import pypdfium2 as pdfium
# papers whose text layer is in a legacy font: the key is garbage, so they are not scored
SKIP = ("paper-tcvlx-266109", "paper-tcvlx-266112")
MAN = {e["id"]: e for e in json.load(open("../../benchmark/manifest2.json"))}
sys.path.insert(0, ".."); sys.path.insert(0, "../..")
import score
norm = lambda s: re.sub(r"\s+", "", unicodedata.normalize("NFC", str(s))).lower()
cells = lambda r: [str(c.get("value") if isinstance(c, dict) else c).strip() for c in r.get("cells", []) if str(c.get("value") if isinstance(c, dict) else c).strip()]

def same(a, b):
    a, b = norm(a), norm(b)
    if a == b: return True
    if min(len(a), len(b)) < 3: return False
    return abs(len(a) - len(b)) <= 0.2 * max(len(a), len(b)) and score.lev(a, b) <= 0.15 * max(len(a), len(b))

def pairs(rows):
    out = []
    for r in rows:
        c = cells(r)
        out += list(zip(c, c[1:]))
    return out

def has_pair(pair, rows_cells):
    a, b = pair
    for c in rows_cells:
        for i in range(len(c) - 1):
            if same(c[i], a) and same(c[i + 1], b): return True
    return False

def f1(p, r): return 2 * p * r / (p + r) if p + r else 0.0

def region_tokens(meta, cap):
    k = meta.get("dpi", 200) / 200            # the page reader assumes 200 dpi; a sharper picture inflates its point coordinates by this
    """Words of the text layer inside the area the page reading covered: the grid cells, or the boxes of the detected text.
    Titles and notes outside it are not part of the table and are not held against the output."""
    page = pdfium.PdfDocument(MAN[meta["id"]]["local_path"])[meta["page"] - 1]
    H = page.get_height()
    cap = {"cells": [{**c, "x": c["x"] / k, "y": c["y"] / k, "width": c["width"] / k, "height": c["height"] / k} for c in cap["cells"]], "words": [{**w, "x": w["x"] / k, "y": w["y"] / k, "x1": w["x1"] / k, "y1": w["y1"] / k} for w in cap["words"]]}
    if len(cap["cells"]) >= 20:                       # a real grid; fewer cells are stray boxes and the text boxes give the area
        x0 = min(c["x"] for c in cap["cells"]); x1 = max(c["x"] + c["width"] for c in cap["cells"])
        y0 = min(c["y"] for c in cap["cells"]); y1 = max(c["y"] + c["height"] for c in cap["cells"])
    else:
        x0 = min(w["x"] for w in cap["words"]); x1 = max(w["x1"] for w in cap["words"]); y0 = min(w["y"] for w in cap["words"]); y1 = max(w["y1"] for w in cap["words"])
    text = page.get_textpage().get_text_bounded(left=x0 - 2, bottom=H - y1 - 2, right=x1 + 2, top=H - y0 + 2)
    return collections.Counter(re.findall(r"\w+", unicodedata.normalize("NFC", text).lower()))

def page_score(key, out, region=None):
    kt = collections.Counter(w for r in key for c in cells(r) for w in re.findall(r"\w+", norm(c) and unicodedata.normalize("NFC", c).lower()))
    ot = collections.Counter(w for r in out for c in cells(r) for w in re.findall(r"\w+", unicodedata.normalize("NFC", c).lower()))
    tp = sum((kt & ot).values()) / max(sum(ot.values()), 1)
    rk = region if region is not None else kt
    tr = sum((rk & ot).values()) / max(sum(rk.values()), 1)
    kc, oc = [cells(r) for r in key], [cells(r) for r in out]
    op, kp = pairs(out), pairs(key)
    pp = sum(has_pair(p, kc) for p in op) / max(len(op), 1)
    pr = sum(has_pair(p, oc) for p in kp) / max(len(kp), 1)
    return f1(tp, tr), f1(pp, pr), len(out), len(key), tp, tr

if __name__ == "__main__":
    a = sys.argv
    d = a[1] if len(a) > 1 and not a[1].startswith("--") else "lab_out"
    want = a[a.index("--split") + 1] if "--split" in a else None
    res = []
    LAB = os.environ.get("LAB", "lab")
    for f in sorted(os.listdir(LAB)):
        if not f.endswith(".json") or not os.path.exists(os.path.join(d, f)): continue
        j = json.load(open(os.path.join(LAB, f)))
        if want and j["meta"]["split"] != want: continue
        if j["meta"]["id"].startswith(SKIP): continue
        out = json.load(open(os.path.join(d, f)))
        t, p, no, nk, tp, tr = page_score(j["ref"], out, region_tokens(j["meta"], j["capture"]) if j["capture"] else None)
        res.append((f[:-5], t, p, no, nk, tp, tr))
    for r in res: print("%-48s token F1 %.3f  pair F1 %.3f  rows %3d/%3d   precision %.3f recall %.3f" % r)
    if res: print("MEAN token F1 %.4f  pair F1 %.4f  precision %.4f  recall %.4f  over %d pages" % (sum(r[1] for r in res) / len(res), sum(r[2] for r in res) / len(res), sum(r[5] for r in res) / len(res), sum(r[6] for r in res) / len(res), len(res)))
