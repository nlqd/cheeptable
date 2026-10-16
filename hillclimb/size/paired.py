"""Paired bootstrap over contract rows: is the student's description error different from the teacher's?   paired.py STATE.pt [--ffn N]"""
import pickle, sys
import numpy as np, torch
sys.path.insert(0, ".")
import evalkit as E, kd, score
a = sys.argv
t, v = E.load_teacher()
kd.prune(t, int(a[a.index("--ffn") + 1]) if "--ffn" in a else 2048, 6, 6)
t.load_state_dict(torch.load(a[1], map_location="cpu", weights_only=True))
_, reads = E.evaluate(t, v)
teach = pickle.load(open("teacher.pkl", "rb"))
d = pickle.load(open("eval.pkl", "rb"))
ref = [E.norm(r["gt"]["desc"]) for r in d["contract"]]
et = np.array([score.lev(x, teach[("c", r["stt"], "desc")]) for x, r in zip(ref, d["contract"])])
es = np.array([score.lev(x, reads[("c", r["stt"], "desc")]) for x, r in zip(ref, d["contract"])])
n = np.array([len(x) for x in ref])
rng = np.random.default_rng(0)
diff = []
for _ in range(5000):
    i = rng.integers(0, len(ref), len(ref))
    diff.append(es[i].sum() / n[i].sum() - et[i].sum() / n[i].sum())
print("description CER teacher %.4f student %.4f; student minus teacher %.4f, 95%% interval [%.4f, %.4f] over %d rows" % (et.sum() / n.sum(), es.sum() / n.sum(), es.sum() / n.sum() - et.sum() / n.sum(), *np.percentile(diff, [2.5, 97.5]), len(ref)))
b = d["bench"]; ids = {}
for i, x in enumerate(b): ids.setdefault(x["doc"], []).append(i)
tb = np.array([score.lev(E.norm(x["ref"]), teach[("b", i)]) for i, x in enumerate(b)])
sb = np.array([score.lev(E.norm(x["ref"]), reads[("b", i)]) for i, x in enumerate(b)])
nb = np.array([len(E.norm(x["ref"])) for x in b])
docs = list(ids)
diff = []
for _ in range(5000):
    pick = rng.choice(len(docs), len(docs))
    idx = np.concatenate([ids[docs[k]] for k in pick])
    diff.append(sb[idx].sum() / nb[idx].sum() - tb[idx].sum() / nb[idx].sum())
print("benchmark lines (resampling the %d documents): teacher %.4f student %.4f; difference %.4f, 95%% interval [%.4f, %.4f]" % (len(docs), tb.sum() / nb.sum(), sb.sum() / nb.sum(), sb.sum() / nb.sum() - tb.sum() / nb.sum(), *np.percentile(diff, [2.5, 97.5])))
