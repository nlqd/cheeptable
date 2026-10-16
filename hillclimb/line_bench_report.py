#!/usr/bin/env python3
"""Summarise line_bench.json.   line_bench_report.py RESULTS.json
CER is summed edits over summed reference characters. The 95% interval resamples whole documents (lines of one document are
correlated, so resampling lines would make it too narrow). 'marks-free' CER strips tone and vowel marks from both sides; the gap
between the two CERs is the diacritic-only share."""
import collections
import difflib
import json
import random
import sys
import unicodedata

sys.path.insert(0, ".")
import score  # noqa: E402


def strip_marks(s):
    s = "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")
    return s.replace("đ", "d").replace("Đ", "D")


def no_space(s):
    return "".join(s.split())


def cer(rows, f=lambda s: s):
    chars = sum(len(f(r["ref"])) for r in rows)
    edits = sum(score.lev(f(r["ref"]), f(r["hyp"])) for r in rows)
    return edits / max(chars, 1)


def boot(by_doc, f=lambda s: s, reps=1000):
    docs = list(by_doc)
    cache = {d: (sum(len(f(r["ref"])) for r in by_doc[d]), sum(score.lev(f(r["ref"]), f(r["hyp"])) for r in by_doc[d])) for d in docs}
    rng = random.Random(1)
    vals = []
    for _ in range(reps):
        pick = [rng.choice(docs) for _ in docs]
        vals.append(sum(cache[d][1] for d in pick) / max(sum(cache[d][0] for d in pick), 1))
    vals.sort()
    return vals[int(0.025 * reps)], vals[int(0.975 * reps)]


def classes(rows):
    c = collections.Counter()
    for r in rows:
        for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, r["ref"], r["hyp"], autojunk=False).get_opcodes():
            if tag == "equal":
                continue
            a, b = r["ref"][i1:i2], r["hyp"][j1:j2]
            n = max(len(a), len(b))
            if tag == "replace" and strip_marks(a) == strip_marks(b):
                c["tone/diacritic only"] += n
            elif any(ch.isdigit() for ch in a + b):
                c["digit involved"] += n
            elif tag == "delete":
                c["missing"] += n
            elif tag == "insert":
                c["extra"] += n
            elif not a.strip() or not b.strip():
                c["spacing"] += n
            else:
                c["other"] += n
    return c


def main():
    res = json.load(open(sys.argv[1]))
    for cond in dict.fromkeys(r["cond"] for r in res):
        rows = [r for r in res if r["cond"] == cond]
        by_doc = collections.defaultdict(list)
        for r in rows:
            by_doc[r["doc"]].append(r)
        lo, hi = boot(by_doc)
        exact = sum(r["ref"] == r["hyp"] for r in rows) / len(rows)
        print("\n== %s: %d lines, %d documents" % (cond, len(rows), len(by_doc)))
        print("CER %.4f  (95%% CI over documents %.4f - %.4f) | marks-free CER %.4f | space-free CER %.4f | exact lines %.3f" % (
            cer(rows), lo, hi, cer(rows, strip_marks), cer(rows, no_space), exact))
        cl = classes(rows)
        tot = sum(cl.values())
        print("error mix:", ", ".join("%s %.0f%%" % (k, 100 * v / tot) for k, v in cl.most_common()))
        if cond == "clean":
            per = sorted(((cer(v), d, len(v)) for d, v in by_doc.items()), reverse=True)
            print("per document CER (worst first):")
            for c, d, n in per:
                print("   %.4f  %-36s (%d lines)" % (c, d, n))
            worst = sorted(rows, key=lambda r: -score.lev(r["ref"], r["hyp"]))[:6]
            print("worst lines:")
            for r in worst:
                print("   [%s] %r -> %r" % (r["doc"][:14], r["ref"][:60], r["hyp"][:60]))


if __name__ == "__main__":
    main()
