#!/usr/bin/env python3
"""Teacher against student on the 52-document corpus (benchmark/manifest2.json), held out of all training.   size/size/bench2.py STATE.pt [--ffn N]
Lines come from the text layer of the born-digital documents (same rules as line_bench.py), read clean and degraded.
Reports error per category with a bootstrap over documents. Run from hillclimb/ with ../venv_train/bin/python."""
import json, random, sys
from pathlib import Path
import numpy as np, pypdfium2 as pdfium, torch
sys.path.insert(0, "."); sys.path.insert(0, ".."); sys.path.insert(0, "size")
import line_bench as L, robust_sweep_lib as D
import evalkit as E, kd, score

CONDS = {"clean": (0, lambda x: x), "rough": (1.5, D.chain(D.rotate(1.5), D.blur(1.2), D.noise(15), D.contrast(0.7), D.jpeg(30)))}
man = json.load(open("../benchmark/manifest2.json"))
rng = random.Random(0)
crops = []
for e in man:
    if e["born_digital"] is not True:
        continue
    try:
        pdf = pdfium.PdfDocument(e["local_path"])
        picks = L.sample_pages(pdf, 3, 25, rng)
    except Exception as ex:
        print("skip", e["id"], ex); continue
    for p, lines in picks:
        page = pdf[p]
        base = np.array(page.render(scale=L.SCALE).to_pil().convert("L"))
        for cond, (rot, fn) in CONDS.items():
            D.seed(0)
            img = fn(base)
            for text, box in lines:
                x0, y0, x1, y1 = L.box_px(box, page.get_height(), rot, img.shape)
                c = img[y0:y1, x0:x1]
                if c.size:
                    crops.append({"doc": e["id"], "cat": e["category"], "cond": cond, "ref": text, "crop": c})
print("documents with lines:", len({c["doc"] for c in crops}), "crops:", len(crops), flush=True)
tens = [E.tensor_for(c["crop"]) for c in crops]
teacher, vocab = E.load_teacher()
t_reads = E.read_all(teacher.to(E.DEV).eval(), vocab, tens)
a = sys.argv
student, _ = E.load_teacher()
kd.prune(student, int(a[a.index("--ffn") + 1]) if "--ffn" in a else 2048, 6, 6)
student.load_state_dict(torch.load(a[1], map_location="cpu", weights_only=True))
s_reads = E.read_all(student.to(E.DEV).eval(), vocab, tens)
et = np.array([score.lev(E.norm(c["ref"]), r) for c, r in zip(crops, t_reads)])
es = np.array([score.lev(E.norm(c["ref"]), r) for c, r in zip(crops, s_reads)])
n = np.array([len(E.norm(c["ref"])) for c in crops])
docs = sorted({c["doc"] for c in crops})
by = {d: [i for i, c in enumerate(crops) if c["doc"] == d] for d in docs}
def cer(e, idx): return e[idx].sum() / n[idx].sum()
brng = np.random.default_rng(0)
def boot(sel):
    ds = [d for d in docs if d in sel]; out = []
    for _ in range(4000):
        idx = np.concatenate([by[ds[k]] for k in brng.integers(0, len(ds), len(ds))])
        out.append(cer(es, idx) - cer(et, idx))
    return np.percentile(out, [2.5, 97.5])
print("%-22s %4s %8s %8s %9s   %s" % ("group", "docs", "teacher", "student", "diff", "95% interval over documents"))
groups = {"all": set(docs)}
for c in sorted({c["cat"] for c in crops}):
    groups[c] = {c2["doc"] for c2 in crops if c2["cat"] == c}
for cond in ("all", "clean", "rough"):
    for g, sel in groups.items():
        if cond != "all" and g != "all":
            continue
        idx = np.array([i for i, c in enumerate(crops) if c["doc"] in sel and (cond == "all" or c["cond"] == cond)])
        lo, hi = boot(sel) if cond == "all" else (float("nan"),) * 2
        print("%-22s %4d %8.4f %8.4f %+9.4f   [%+.4f, %+.4f]" % (g if cond == "all" else "all, " + cond, len(sel), cer(et, idx), cer(es, idx), cer(es, idx) - cer(et, idx), lo, hi))
worst = sorted(docs, key=lambda d: cer(es, by[d]) - cer(et, by[d]), reverse=True)[:5]
print("documents where the student is furthest behind:", [(d, round(cer(et, by[d]), 3), round(cer(es, by[d]), 3)) for d in worst])
json.dump({"crops": [{k: v for k, v in c.items() if k != "crop"} | {"teacher": t, "student": s} for c, t, s in zip(crops, t_reads, s_reads)]}, open("size/bench2_reads.json", "w"), ensure_ascii=False)
