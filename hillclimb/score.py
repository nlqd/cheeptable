#!/usr/bin/env python3
"""Score an extracted-rows JSON (from the real app, see fe_e2e.py) against a golden xlsx.

  score.py ROWS.json [--gt golden_v2.xlsx] [--json]
Reports three slices so tuning cannot quietly overfit this one contract:
  dev    rows whose distinct description text hashes into the tuning part (use these to choose changes)
  test   rows with the other descriptions (look only when reporting; never tune on them)
  all    everything
The split is by distinct description, not by page, because the same item descriptions repeat in every
section of the document. Numbers use compare_vs_gt's tolerant matching; text uses character error rate.
"""
import hashlib
import json
import re
import sys
import unicodedata

sys.path.insert(0, "..")
import compare_vs_gt as cg  # noqa: E402  (main() is guarded, import is side-effect free)


def norm(s):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", s or "")).strip()


def strip_marks(s):
    s = "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")
    return s.replace("đ", "d").replace("Đ", "D")


def lev(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def split_of(desc):
    return "dev" if int(hashlib.md5(norm(desc).lower().encode()).hexdigest(), 16) % 10 < 6 else "test"


def align(gt_rows, rows_path):
    by_stt, all_rows = cg.load_ocr_rows(rows_path)
    max_stt = max(r["stt"] for r in gt_rows)
    pt = cg.build_price_total_index(all_rows, max_stt)
    pairs = []
    for g in gt_rows:
        o = by_stt.get(g["stt"])
        if o is None and g["price"] and g["total"]:
            c = pt.get((g["price"], g["total"]), [])
            o = c[0]["row"] if len(c) == 1 else None
        pairs.append((g, o))
    return pairs


def metrics(pairs):
    n = len(pairs)
    found = [(g, o) for g, o in pairs if o is not None]
    m = {"rows": n, "found": len(found)}
    if not n:
        return m
    ok = lambda text, val: cg.num_match(text, val)
    m["qty"] = sum(ok(o[3], g["qty"]) for g, o in found) / n
    m["price"] = sum(ok(o[4], g["price"]) for g, o in found) / n
    m["total"] = sum(ok(o[5], g["total"]) for g, o in found) / n
    m["all3"] = sum(ok(o[3], g["qty"]) and ok(o[4], g["price"]) and ok(o[5], g["total"]) for g, o in found) / n
    errs = chars = exact = tone_only = 0
    for g, o in pairs:
        ref = norm(g["desc"])
        hyp = norm(o[1]) if o else ""
        chars += len(ref)
        errs += lev(ref, hyp)
        exact += ref == hyp
        tone_only += ref != hyp and strip_marks(ref).lower() == strip_marks(hyp).lower()
    m["cer"] = errs / max(chars, 1)
    m["desc_exact"] = exact / n
    m["tone_only_err"] = tone_only / n   # right letters, wrong marks: the error VietOCR is meant to fix
    m["unit"] = sum(norm(o[2]).lower() == norm(g["unit"]).lower() for g, o in found) / n
    return m


def report(rows_path, gt_path):
    cg.GT_PATH = gt_path
    pairs = align(cg.load_gt(), rows_path)
    out = {"all": metrics(pairs)}
    for part in ("dev", "test"):
        out[part] = metrics([(g, o) for g, o in pairs if split_of(g["desc"]) == part])
    return out


if __name__ == "__main__":
    gt = sys.argv[sys.argv.index("--gt") + 1] if "--gt" in sys.argv else "golden_v2.xlsx"
    r = report(sys.argv[1], gt)
    if "--json" in sys.argv:
        print(json.dumps(r))
    else:
        cols = ["rows", "found", "all3", "qty", "price", "total", "unit", "desc_exact", "tone_only_err", "cer"]
        print("%-5s" % "" + "".join("%13s" % c for c in cols))
        for part in ("dev", "test", "all"):
            print("%-5s" % part + "".join("%13s" % ("%.3f" % r[part][c] if isinstance(r[part].get(c), float) else r[part].get(c, "")) for c in cols))
