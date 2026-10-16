import copy, json, sys
sys.path.insert(0, ".")
import evalkit as E, quant as Q
teacher, vocab = E.load_teacher()
total = sum(p.numel() for p in teacher.parameters())
rows = []
for bits in (8, 6, 4, 3):
    for g in Q.GROUPS:
        m = copy.deepcopy(teacher)
        rep = {}
        Q.apply_plan(m, {g: (bits, 0)}, report=rep)
        r, _ = E.evaluate(m, vocab, f"{g}@int{bits}")
        bpw = sum(n * b for n, b, _ in rep.values()) / sum(n for n, _, _ in rep.values())
        line = {"group": g, "bits": bits, "entropy_bpw": round(bpw, 2), "agree": r["agree_err"], "cer_all": r["all"]["cer"], "all3": r["all"]["all3"], "rough": r["bench"]["rough"]}
        print(json.dumps(line), flush=True)
