#!/usr/bin/env python3
"""Score the rows the app reads from a picture of a page against the rows it takes from the same page's text layer.
  table_ab.py REF.json OUT.json [--page N]      rows as dumped by e2e.py
Per reference row: the best output row by character error on the cell texts joined (spaces ignored), and whether the number of
filled cells agrees. Prints row recall (matches within 10% error), character error over all reference rows, share of matched rows
with the same cell count."""
import json, re, sys, unicodedata
sys.path.insert(0, "."); sys.path.insert(0, "..")
import score  # noqa: E402

def cells(r):
    return [str(c.get("value") if isinstance(c, dict) else c).strip() for c in r.get("cells", [])]
norm = lambda s: re.sub(r"\s+", "", unicodedata.normalize("NFC", s)).lower()

def rows_of(path, page=None):
    return [cells(r) for r in json.load(open(path)) if page is None or r.get("page") == page]

def compare(ref, out):
    ref = [[c for c in r if c] for r in ref]; ref = [r for r in ref if r]
    out = [[c for c in r if c] for r in out]; out = [r for r in out if r]
    ot = [norm("".join(r)) for r in out]
    matched = same = errs = chars = 0
    for r in ref:
        t = norm("".join(r))
        if not t:
            continue
        best = min(range(len(out)), key=lambda i: score.lev(t, ot[i]) if abs(len(ot[i]) - len(t)) <= 0.5 * len(t) + 3 else 10 ** 9, default=None)
        e = score.lev(t, ot[best]) if best is not None and abs(len(ot[best]) - len(t)) <= 0.5 * len(t) + 3 else len(t)
        errs += e; chars += len(t)
        if e <= 0.1 * len(t):
            matched += 1
            same += len(out[best]) == len(r)
    return {"ref_rows": len(ref), "out_rows": len(out), "recall": matched / max(len(ref), 1), "cer": errs / max(chars, 1), "same_cell_count": same / max(matched, 1)}

if __name__ == "__main__":
    a = sys.argv
    page = int(a[a.index("--page") + 1]) if "--page" in a else None
    print(json.dumps(compare(rows_of(a[1], page), rows_of(a[2]))))
