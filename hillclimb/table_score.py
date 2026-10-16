#!/usr/bin/env python3
"""Score a reading method on the borderless-table twins.   table_score.py TRUTH.json WORDS.json [--by-doc]
TRUTH: pages -> lines -> cells {t, b:[x0,y0,x1,y1]} (make_table_twins.py). WORDS: pages -> boxes {t, b} produced by a method.
For every truth cell:
  whole    boxes lying inside the cell (>= half of their width inside, >= half of their height on the cell's row), joined
           left to right; this also covers a cell the method read in several pieces
  merged   no box inside, but a box at least 1.4x wider than the cell covers half of it: the method fused neighbours
  missing  neither
'exact' compares whole-cell text after NFC and removing spaces. CER is edits over truth characters, 1.0 for merged or missing."""
import collections
import json
import re
import sys
import unicodedata

sys.path.insert(0, ".")
import score  # noqa: E402


def norm(s):
    return "".join(unicodedata.normalize("NFC", s).split())


def overlap(a0, a1, b0, b1):
    return max(0, min(a1, b1) - max(a0, b0))


def judge(cell, boxes):
    x0, y0, x1, y1 = cell["b"]
    w = max(x1 - x0, 1)
    inside, wide = [], []
    for p in boxes:
        px0, py0, px1, py1 = p["b"]
        pw, ph = max(px1 - px0, 1), max(py1 - py0, 1)
        if overlap(y0, y1, py0, py1) < 0.5 * ph:
            continue
        ho = overlap(x0, x1, px0, px1)
        if ho >= 0.5 * pw:
            inside.append(p)
        elif ho >= 0.5 * w and pw > 1.4 * w:
            wide.append(p)
    if inside:
        text = "".join(p["t"] for p in sorted(inside, key=lambda p: p["b"][0]))
        return "whole", norm(text), len(inside)
    return ("merged", "", 0) if wide else ("missing", "", 0)


def main():
    truth = json.load(open(sys.argv[1]))
    words = json.load(open(sys.argv[2]))
    stats = collections.defaultdict(lambda: collections.Counter())
    for meta, page, boxes in zip(truth["meta"], truth["pages"], words):
        for line in page:
            for cell in line:
                kind, text, pieces = judge(cell, boxes)
                ref = norm(cell["t"])
                numeric = bool(re.fullmatch(r"[\d.,()\-/%]+", ref))
                for key in ("all", meta["doc"], "numeric" if numeric else "text"):
                    s = stats[key]
                    s["cells"] += 1
                    s[kind] += 1
                    s["chars"] += len(ref)
                    if kind == "whole":
                        e = min(score.lev(ref, text), len(ref))
                        s["edits"] += e
                        s["exact"] += e == 0
                        s["split"] += pieces > 1
                    else:
                        s["edits"] += len(ref)
    keys = ["all", "numeric", "text"] + ([k for k in stats if k not in ("all", "numeric", "text")] if "--by-doc" in sys.argv else [])
    print("%-34s %6s %7s %7s %7s %7s %7s %7s" % ("", "cells", "whole", "merged", "missing", "exact", "split", "CER"))
    for k in keys:
        s = stats[k]
        n = s["cells"]
        print("%-34s %6d %6.1f%% %6.1f%% %6.1f%% %6.1f%% %6.1f%% %7.3f" % (k[:34], n, 100 * s["whole"] / n, 100 * s["merged"] / n,
              100 * s["missing"] / n, 100 * s["exact"] / n, 100 * s["split"] / n, s["edits"] / max(s["chars"], 1)))


if __name__ == "__main__":
    main()
