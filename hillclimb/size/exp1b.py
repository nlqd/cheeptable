import copy, json, sys
sys.path.insert(0, ".")
import evalkit as E, quant as Q
teacher, vocab = E.load_teacher()
for bits, gs in ((4, ["dec_ffn", "emb_fc"]), (3, list(Q.GROUPS))):
    for g in gs:
        m = copy.deepcopy(teacher); rep = {}
        Q.apply_plan(m, {g: (bits, 0)}, report=rep)
        r, _ = E.evaluate(m, vocab)
        bpw = sum(n * b for n, b, _ in rep.values()) / sum(n for n, _, _ in rep.values())
        print(json.dumps({"group": g, "bits": bits, "entropy_bpw": round(bpw, 2), "agree": r["agree_err"], "cer_all": r["all"]["cer"], "all3": r["all"]["all3"], "rough": r["bench"]["rough"]}), flush=True)
