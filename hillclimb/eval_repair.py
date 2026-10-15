#!/usr/bin/env python3
"""Score number repair tiers on the contract and the unseen synthetic doc, with harm counted explicitly.

  eval_repair.py DIR      DIR holds grid_full.json and grid_synth.json
Harm = a row whose three numbers were all right before repair and are not after.
"""
import subprocess
import sys

sys.path.insert(0, "..")
sys.path.insert(0, ".")
import arith_repair  # noqa: E402
import score  # noqa: E402

cg = score.cg
SETS = [("contract", "grid_full.json", "golden_v2.xlsx"), ("synthetic", "grid_synth.json", "synth_golden.xlsx")]


def row_ok(g, o):
    return o is not None and cg.num_match(o[3], g["qty"]) and cg.num_match(o[4], g["price"]) and cg.num_match(o[5], g["total"])


def run(d, tiers):
    for name, rows, gt in SETS:
        src, dst = "%s/%s" % (d, rows), "%s/rep_%s" % (d, rows)
        if JS:
            subprocess.run(["node", "js_repair.mjs", src, dst], check=True, capture_output=True)
            used = "js"
        else:
            used = arith_repair.main(src, dst, tiers)
        cg.GT_PATH = gt
        before = {g["stt"]: row_ok(g, o) for g, o in score.align(cg.load_gt(), src)}
        pairs = score.align(cg.load_gt(), dst)
        after = {g["stt"]: row_ok(g, o) for g, o in pairs}
        fixed = sum(after[k] and not before[k] for k in after)
        harmed = sum(before[k] and not after[k] for k in after)
        dev = [(g, o) for g, o in pairs if score.split_of(g["desc"]) == "dev"]
        test = [(g, o) for g, o in pairs if score.split_of(g["desc"]) == "test"]
        acc = lambda ps: sum(row_ok(g, o) for g, o in ps) / max(len(ps), 1)
        print("  %-9s tiers=%-5s all3 %.3f (dev %.3f test %.3f)  fixed %d harmed %d  %s" % (
            name, ",".join(map(str, tiers)) or "-", acc(pairs), acc(dev), acc(test), fixed, harmed, used))


JS = "--js" in sys.argv

if __name__ == "__main__":
    for tiers in (((1, 2),) if JS else ((), (1,), (1, 2))):
        run(sys.argv[1], tiers)
