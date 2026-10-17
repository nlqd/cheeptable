"""Student against the original model, in the whole app, document by document.   ab_report.py   (after ab.sh; run in hillclimb/size)"""
import json, os, re, sys, unicodedata
sys.path.insert(0, "../.."); sys.path.insert(0, "..")
import score
man = {e["id"]: e for e in json.load(open("../../benchmark/manifest2.json"))}
cellsof = lambda r: [str(c.get("value") if isinstance(c, dict) else c).strip() for c in r.get("cells", [])]
norm = lambda s: re.sub(r"\s+", "", unicodedata.normalize("NFC", s)).lower()
same, diff, none = [], [], []
for id_ in man:
    ps, pt = f"corpus_rows_student/{id_}.json", f"corpus_rows_teacher/{id_}.json"
    if not (os.path.exists(ps) and os.path.exists(pt)):
        none.append(id_); continue
    S = [cellsof(r) for r in json.load(open(ps))]; T = [cellsof(r) for r in json.load(open(pt))]
    s = norm("".join("".join(r) for r in S)); t = norm("".join("".join(r) for r in T))
    if s == t:
        same.append(id_)
    else:
        diff.append((id_, score.lev(t[:60000], s[:60000]) / max(len(t[:60000]), 1), len(S), len(T), len(t)))
print("identical output:", len(same), "| different:", len(diff), "| no table from one or both models:", len(none))
tot = sum(d[4] for d in diff)
print("character disagreement over the differing documents (weighted by size): %.4f" % (sum(d[1] * d[4] for d in diff) / max(tot, 1)))
for d in sorted(diff, key=lambda d: -d[1]):
    print("  %-40s %.4f   rows student %3d teacher %3d   %s" % (d[0], d[1], d[2], d[3], man[d[0]]["category"]))
print("no table:", none)
