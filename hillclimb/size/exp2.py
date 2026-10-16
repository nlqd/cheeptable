"""Per-tensor int4 sensitivity for the transformer weights and the big convs: which tensors fail, and does grouping/clipping rescue them."""
import copy, json, sys
sys.path.insert(0, ".")
import evalkit as E, quant as Q
teacher, vocab = E.load_teacher()
names = [n for n, p in teacher.named_parameters() if p.numel() > 100000]
for cfgname, gs, clip in (("rowclip", 0, True), ("g64clip", 64, True)):
    for n in names:
        m = copy.deepcopy(teacher)
        with __import__("torch").no_grad():
            p = dict(m.named_parameters())[n]
            deq, q, ns = Q.rtn(p.data, 4, gs, clip)
            p.data.copy_(deq)
        r, _ = E.evaluate(m, vocab)
        print(json.dumps({"cfg": cfgname, "tensor": n.replace("transformer.transformer.", "t.").replace("cnn.model.features.", "f."), "agree": r["agree_err"], "cer": r["all"]["cer"], "rough": r["bench"]["rough"]}), flush=True)
