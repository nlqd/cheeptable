#!/usr/bin/env python3
"""Repair OCR'd numbers with the one invariant every bill of quantities has: quantity x price = total.

  arith_repair.py ROWS.json OUT.json [--tiers 1,2]
Rows whose three numbers already agree are left alone. Otherwise:
  tier 1  single-character edit of one field (digit confusion, ./, swap, one digit inserted or deleted);
          accepted only when exactly one edit makes the identity hold
  tier 2  solve one field from the other two (qty = total / price and so on); accepted only when the solved
          value is clean and the OCR text of that field is clearly the closest to it
No knowledge of the document: no column positions, no vocabulary.
"""
import json
import re
import sys

sys.path.insert(0, "..")
import compare_vs_gt as cg  # noqa: E402

CONFUSIONS = {"0": "689", "1": "7", "2": "7", "3": "58", "4": "9", "5": "63", "6": "058", "7": "12", "8": "0369", "9": "4086"}
TOL = 0.005


def values(text):
    return cg.parse_vn_candidates(text) if text else []


def holds(q, p, t, tol=TOL):
    return any(abs(a * b - c) / max(abs(c), 1) <= tol for a in values(q) for b in values(p) for c in values(t) if c)


def edits(text):
    for i, ch in enumerate(text):
        for sub in CONFUSIONS.get(ch, ""):
            yield text[:i] + sub + text[i + 1:]
        if ch in ".,":
            yield text[:i] + (",." [ch == ","]) + text[i + 1:]
            yield text[:i] + text[i + 1:]
        elif ch.isdigit():
            yield text[:i] + text[i + 1:]
    for i in range(len(text) + 1):
        for d in "0123456789":
            yield text[:i] + d + text[i:]


def fmt_int(v):
    return "{:,}".format(int(round(v))).replace(",", ".")


def fmt_qty(v):
    s = ("%.3f" % v).rstrip("0").rstrip(".")
    return s.replace(".", ",")


def lev(a, b):
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[-1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def tier1(q, p, t):
    found = []
    for i, field in enumerate((q, p, t)):
        for e in edits(field):
            trial = [q, p, t]
            trial[i] = e
            if holds(*trial):
                found.append(tuple(trial))
    found = list(dict.fromkeys(found))
    return found[0] if len(found) == 1 else None


def tier2(q, p, t):
    vq, vp, vt = (values(x) for x in (q, p, t))
    cands = []
    if vp and vt and vp[0]:
        s = vt[0] / vp[0]
        if abs(s * 1000 - round(s * 1000)) < 1e-6 and s > 0:
            cands.append((0, fmt_qty(s), q))
    if vq and vt and vq[0]:
        s = vt[0] / vq[0]
        if abs(s - round(s)) < 1e-6 and s > 0:
            cands.append((1, fmt_int(s), p))
    if vq and vp:
        s = vq[0] * vp[0]
        cands.append((2, fmt_int(s), t))
    if not cands:
        return None
    scored = sorted((lev(new, old) / max(len(new), len(old), 1), i, new) for i, new, old in cands)
    if len(scored) > 1 and scored[1][0] - scored[0][0] < 0.3:
        return None
    _, i, new = scored[0]
    trial = [q, p, t]
    trial[i] = new
    return tuple(trial) if holds(*trial) else None


def repair(q, p, t, tiers=(1, 2)):
    """Return (q, p, t, tier_used or 0)."""
    numeric = lambda s: bool(re.fullmatch(r"[\d.,]+", s.strip()))
    if not (numeric(p) and numeric(t)) or (q and holds(q, p, t)):
        return q, p, t, 0
    if 1 in tiers and q and numeric(q):
        r = tier1(q, p, t)
        if r:
            return (*r, 1)
    if 2 in tiers:
        r = tier2(q, p, t)
        if r:
            return (*r, 2)
    return q, p, t, 0


def main(src, dst, tiers=(1, 2)):
    rows = json.load(open(src))
    used = {1: 0, 2: 0}
    for r in rows:
        c = r["cells"]
        if len(c) < 6:
            continue
        q, p, t, tier = repair(c[3]["value"], c[4]["value"], c[5]["value"], tiers)
        if tier:
            used[tier] += 1
            c[3]["value"], c[4]["value"], c[5]["value"] = q, p, t
    json.dump(rows, open(dst, "w"))
    return used


if __name__ == "__main__":
    tiers = tuple(int(x) for x in sys.argv[sys.argv.index("--tiers") + 1].split(",")) if "--tiers" in sys.argv else (1, 2)
    print("repaired per tier", main(sys.argv[1], sys.argv[2], tiers))
