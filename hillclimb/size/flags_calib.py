"""How well do the review flags work for a given set of engine rows?   flags_calib.py ROWS.json [ROWS2.json ...]
For description cells: share of cells under each confidence cutoff and how many of those are really wrong (against golden_v2)."""
import json
import re
import sys
import unicodedata

sys.path.insert(0, "..")
sys.path.insert(0, ".")
import compare_vs_gt as cg  # noqa: E402

CUTS = tuple(float(x) for x in __import__("os").environ.get("CUTS", "").split(",") if x)
cg.GT_PATH = "golden_v2.xlsx"
gt = {g["stt"]: g for g in cg.load_gt()}
norm = lambda s: re.sub(r"\s+", " ", unicodedata.normalize("NFC", s or "")).strip()
for path in sys.argv[1:]:
    rows = json.load(open(path))
    desc, num = [], []
    for r in rows:
        c = r.get("cells") or []
        if r.get("type") != "data" or len(c) < 6 or not str(c[0].get("value", "")).strip().isdigit():
            continue
        g = gt.get(int(c[0]["value"]))
        if not g:
            continue
        desc.append((c[1].get("confidence") or 0, norm(c[1]["value"]) != norm(g["desc"])))
        for col, key in ((3, "qty"), (4, "price"), (5, "total")):
            num.append((c[col].get("confidence") or 0, not cg.num_match(c[col]["value"], g[key])))
    print("==", path.split("/")[-1], "description cells", len(desc), "wrong", sum(w for _, w in desc), "| number cells", len(num), "wrong", sum(w for _, w in num))
    confs = sorted(c for c, _ in desc if c > 0)
    print("   description confidence quantiles 5/25/50/75:", [round(confs[int(len(confs) * q)], 1) for q in (0.05, 0.25, 0.5, 0.75)])
    for cut in (CUTS or (80, 85, 88, 90, 92, 94, 95, 96)):
        sel = [w for c, w in desc if 0 < c < cut]
        print(f"   desc conf < {cut}: {len(sel):3d} cells ({100 * len(sel) / len(desc):4.1f}%), wrong {sum(sel):3d} ({100 * sum(sel) / max(len(sel), 1):4.1f}%), catches {100 * sum(sel) / max(sum(w for _, w in desc), 1):4.1f}% of all wrong")
    for cut in (60, 70, 80, 85, 90):
        sel = [w for c, w in num if 0 < c < cut]
        print(f"   num conf < {cut}: {len(sel):3d} cells, wrong {sum(sel):3d} ({100 * sum(sel) / max(len(sel), 1):4.1f}%), catches {100 * sum(sel) / max(sum(w for _, w in num), 1):4.1f}% of all wrong")
