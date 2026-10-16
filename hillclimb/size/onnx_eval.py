#!/usr/bin/env python3
"""Evaluate ONNX graphs (encoder, dec_init, dec_step) on the fixed set.   onnx_eval.py DIR [TAG]
Greedy decoding exactly as the browser does it (cached decoder step). Run with ../../venv_train/bin/python."""
import json
import sys
from multiprocessing import Pool
from pathlib import Path

import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(Path(__file__).parent))
import evalkit as E  # noqa: E402

D = Path(sys.argv[1])
_s = {}


def sessions(d=None):
    d = d or D
    if "e" not in _s:
        o = ort.SessionOptions(); o.intra_op_num_threads = 3; o.log_severity_level = 3
        _s["e"] = [ort.InferenceSession(str(d / f), o, providers=["CPUExecutionProvider"]) for f in ((__import__("os").environ.get("ENC", "enc") + ".skel.onnx", "init.skel.onnx", "step.skel.onnx") if (d / "enc.skel.onnx").exists() else ("encoder.onnx", "dec_init.onnx", "dec_step.onnx"))]
        _s["v"] = E.load_teacher()[1]
    return _s["e"], _s["v"]


def read(args):
    lo, hi = args
    (enc, init, step), vocab = sessions()
    d, items = E.all_items()
    out = []
    for _, crop in items[lo:hi]:
        x = E.tensor_for(crop).numpy()[None]
        mem = enc.run(None, {"image": x})[0]
        ck, cv = init.run(None, {"memory": mem})
        L, H = ck.shape[0], ck.shape[1]
        pk = np.zeros((L, H, 0, 32), np.float32); pv = pk.copy()
        ids, tok = [1], 1
        for t in range(128):
            lg, pk, pv = step.run(None, {"token": np.array([tok], np.int64), "pos": np.array([t], np.int64), "past_k": pk, "past_v": pv, "cross_k": ck, "cross_v": cv})
            tok = int(lg.argmax())
            if tok == 2:
                break
            ids.append(tok)
        out.append(E.norm(vocab.decode(ids + [2])))
    return out


def run(d):
    global D
    D = Path(d)
    _, items = E.all_items()
    n = len(items)
    chunks = [(i, min(i + 120, n)) for i in range(0, n, 120)]
    with Pool(4) as p:
        texts = sum(p.map(read, chunks), [])
    return E.metrics_from_texts(texts, str(d))


if __name__ == "__main__":
    res, _ = run(sys.argv[1])
    print(json.dumps(res))
