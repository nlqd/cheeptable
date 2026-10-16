import pickle, sys, torch
sys.path.insert(0, ".")
import evalkit as E
import compare_vs_gt as cg
t, v = E.load_teacher()
m = E.load_teacher()[0]
m.load_state_dict(torch.load(sys.argv[1], map_location="cpu", weights_only=True))
res, reads = E.evaluate(m, v)
d = pickle.load(open("eval.pkl", "rb"))
gt = {r["stt"]: r["gt"] for r in d["contract"]}
teach = pickle.load(open("teacher.pkl", "rb"))
for col in ("qty", "price", "total"):
    for stt, g in gt.items():
        k = ("c", stt, col)
        okt, oks = cg.num_match(teach[k], g[col]), cg.num_match(reads[k], g[col])
        if okt != oks:
            print(col, stt, "truth", g[col], "teacher", repr(teach[k]), "student", repr(reads[k]), "TEACHER-OK" if okt else "STUDENT-OK")
