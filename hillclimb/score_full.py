#!/usr/bin/env python3
"""Score every row of the contract sheet, not only the numbered ones.
  score_full.py ROWS.json [--gt golden_v2.xlsx] [--worst 25]
Golden rows and extracted rows are compared as text (cells joined, spaces ignored) and lined up in page order: a banded dynamic
programme over row pairs, so a row that was cut in two, merged or invented does not shift everything after it. Per kind of golden row
(heading, table header, section title, item, summary) it prints how many were found and the character error of the found ones;
then the worst rows with what the app produced instead."""
import json
import re
import sys
import unicodedata

import openpyxl

sys.path.insert(0, ".")
import score  # noqa: E402  (lev, norm)

BAND, FOUND = 25, 0.35


def squash(s):
    return re.sub(r"\s+", "", unicodedata.normalize("NFC", s or "")).lower()


def golden(path):
    cells_of = []
    for i, r in enumerate(openpyxl.load_workbook(path).active.iter_rows(values_only=True), 1):
        cells = [("" if c is None else str(c)).replace("\n", " ").strip() for c in r]
        if any(cells):
            cells_of.append((i, cells))
    last_item = max(k for k, (_, c) in enumerate(cells_of) if re.fullmatch(r"\d{1,3}", c[0]))
    first_head = next(k for k, (_, c) in enumerate(cells_of) if c[0] == "Stt")
    rows = []
    for k, (i, cells) in enumerate(cells_of):
        if re.fullmatch(r"\d{1,3}", cells[0]):
            kind = "item"
        elif k < first_head:
            kind = "heading"
        elif k <= first_head + 1:
            kind = "table header"
        elif k > last_item:
            kind = "summary"
        else:
            kind = "section"
        rows.append({"line": i, "kind": kind, "text": " ".join(c for c in cells if c), "key": squash("".join(cells))})
    return rows


def extracted(path):
    out = []
    for r in json.load(open(path)):
        cells = [str(c.get("value") if isinstance(c, dict) else c).strip() for c in r["cells"]]
        if any(cells):
            out.append({"page": r.get("page"), "text": " ".join(c for c in cells if c), "key": squash("".join(cells))})
    return out


def cost(a, b):
    if not a and not b:
        return 0.0
    return min(1.0, score.lev(a, b) / max(len(a), len(b), 1))


def align(g, o):
    """Monotone alignment inside a band around the diagonal; cost 0..1 per pair, 1 per skipped row."""
    n, m = len(g), len(o)
    INF = 1e9
    D = {(0, 0): 0.0}
    back = {}
    scale = m / max(n, 1)
    def get(i, j):
        return D.get((i, j), INF)
    for i in range(n + 1):
        centre = int(i * scale)
        for j in range(max(0, centre - BAND), min(m, centre + BAND) + 1):
            if i == 0 and j == 0:
                continue
            best, how = INF, None
            if i and j and get(i - 1, j - 1) < INF:
                c = get(i - 1, j - 1) + cost(g[i - 1]["key"], o[j - 1]["key"])
                best, how = c, "match"
            if i and get(i - 1, j) + 1.0 < best:
                best, how = get(i - 1, j) + 1.0, "miss"
            if j and get(i, j - 1) + 1.0 < best:
                best, how = get(i, j - 1) + 1.0, "extra"
            if how:
                D[(i, j)] = best
                back[(i, j)] = how
    pairs, i, j = [], n, m
    while i or j:
        how = back.get((i, j))
        if how == "match":
            pairs.append((i - 1, j - 1)); i -= 1; j -= 1
        elif how == "miss":
            pairs.append((i - 1, None)); i -= 1
        elif how == "extra":
            pairs.append((None, j - 1)); j -= 1
        else:
            break
    return pairs[::-1]


if __name__ == "__main__":
    a = sys.argv
    gt = a[a.index("--gt") + 1] if "--gt" in a else "golden_v2.xlsx"
    worst = int(a[a.index("--worst") + 1]) if "--worst" in a else 25
    G, O = golden(gt), extracted(a[1])
    pairs = align(G, O)
    per, extra = {}, []
    scored = []
    for gi, oj in pairs:
        if gi is None:
            extra.append(O[oj])
            continue
        g = G[gi]
        c = cost(g["key"], O[oj]["key"]) if oj is not None else 1.0
        found = oj is not None and c <= FOUND
        d = per.setdefault(g["kind"], {"n": 0, "found": 0, "errs": 0, "chars": 0})
        d["n"] += 1
        d["found"] += found
        if found:
            d["errs"] += score.lev(g["key"], O[oj]["key"]); d["chars"] += len(g["key"])
        scored.append((c if found else 1.0, g, O[oj] if oj is not None else None))
    print("%-13s %5s %6s %8s" % ("kind", "rows", "found", "char err"))
    tot = {"n": 0, "found": 0, "errs": 0, "chars": 0}
    for k in ("heading", "table header", "section", "item", "summary"):
        d = per.get(k)
        if d:
            print("%-13s %5d %6d %8.3f" % (k, d["n"], d["found"], d["errs"] / max(d["chars"], 1)))
            for key in tot:
                tot[key] += d[key]
    print("%-13s %5d %6d %8.3f   extra rows with no golden row: %d" % ("all", tot["n"], tot["found"], tot["errs"] / max(tot["chars"], 1), len(extra)))
    print("\nworst golden rows (not found counts as 1.0):")
    for c, g, o in sorted(scored, key=lambda t: -t[0])[:worst]:
        print("  [%s line %d] %.2f  GOLD: %s\n          GOT : %s" % (g["kind"], g["line"], c, g["text"][:90], (o["text"][:90] if o else "-")))
    print("\nextra rows (first 12):")
    for o in extra[:12]:
        print("  p%s %s" % (o["page"], o["text"][:100]))
