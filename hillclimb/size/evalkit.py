# The pickles read here are written by make_data.py and this script on this machine; they are not external input.
"""Evaluate any VietOCR torch model on the fixed set from make_data.py.   (import from hillclimb/size, run with a venv that has torch + vietocr)
evaluate(model) -> dict of numbers.  The teacher's own reads are cached in size/teacher.pkl, so every candidate also gets
`agree`: character error against the teacher (what compression changed), next to `cer` against the truth."""
import pickle
import re
import sys
import unicodedata
from pathlib import Path

import numpy as np
import torch
from vietocr.tool.config import Cfg
from vietocr.tool.translate import build_model, process_input, translate
from vietocr.tool.utils import download_weights
from vietocr.tool.translate import Vocab
from PIL import Image
import cv2

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent.parent))
import compare_vs_gt as cg  # noqa: E402
import score  # noqa: E402

DEV = "cuda" if torch.cuda.is_available() else "cpu"
_cfg = None


def cfg():
    global _cfg
    if _cfg is None:
        _cfg = Cfg.load_config_from_name("vgg_transformer")
        _cfg["device"] = "cpu"
        _cfg["cnn"]["pretrained"] = False
    return _cfg


def load_teacher():
    c = cfg()
    model, vocab = build_model(c)
    model.load_state_dict(torch.load(download_weights(c["weights"]), map_location="cpu", weights_only=True))
    return model.eval(), vocab


def norm(s):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", s)).strip()


def tight(gray, margin=3):
    ys, xs = np.where(gray < 170)
    if len(xs) == 0:
        return gray
    y0, y1 = max(ys.min() - margin, 0), min(ys.max() + margin + 1, gray.shape[0])
    x0, x1 = max(xs.min() - margin, 0), min(xs.max() + margin + 1, gray.shape[1])
    return gray[y0:y1, x0:x1]


def tensor_for(gray):
    c = cfg()["dataset"]
    g = cv2.copyMakeBorder(tight(gray), 0, 0, 10, 10, cv2.BORDER_CONSTANT, value=255)
    return process_input(Image.fromarray(g).convert("RGB"), c["image_height"], c["image_min_width"], c["image_max_width"])[0]


def all_items():
    d = pickle.load(open(HERE / "eval.pkl", "rb"))
    items = []   # (key, crop)
    for r in d["contract"]:
        for k, crop in r["crops"].items():
            items.append((("c", r["stt"], k), crop))
    for i, b in enumerate(d["bench"]):
        items.append((("b", i), b["crop"]))
    return d, items


@torch.no_grad()
def read_all(model, vocab, tensors, bs=64):
    """Greedy reads for a list of CHW tensors, batched by width. Returns texts in input order."""
    out = [None] * len(tensors)
    order = {}
    for i, t in enumerate(tensors):
        order.setdefault(t.shape[-1], []).append(i)
    for w, idx in order.items():
        for s in range(0, len(idx), bs):
            part = idx[s:s + bs]
            x = torch.stack([tensors[i] for i in part]).to(DEV)
            seqs, _ = translate(x, model, 128, 1, 2)
            for i, sq in zip(part, seqs):
                out[i] = vocab.decode(sq.tolist())
    return [norm(t) for t in out]


def lev(a, b):
    return score.lev(a, b)


_cache = {}


def evaluate(model, vocab, tag="model"):
    model = model.to(DEV).eval()
    d, items = all_items()
    if "t" not in _cache:
        _cache["t"] = [tensor_for(c) for _, c in items]
    texts = read_all(model, vocab, _cache["t"])
    return metrics_from_texts(texts, tag)


def metrics_from_texts(texts, tag="model"):
    """texts: reads for all_items() in order (contract cells first, then bench lines)."""
    d, items = all_items()
    reads = {k: t for (k, _), t in zip(items, texts)}
    tp = HERE / "teacher.pkl"
    teacher = pickle.load(open(tp, "rb")) if tp.exists() else None
    res = {"tag": tag}
    pairs = {"dev": [], "test": []}
    for r in d["contract"]:
        g = r["gt"]
        row = [str(g["stt"])] + [reads[("c", r["stt"], k)] for k in ("desc", "unit", "qty", "price", "total")]
        pairs[r["split"]].append((g, row))
    for part in ("dev", "test"):
        m = score.metrics(pairs[part])
        res[part] = {k: round(m[k], 4) for k in ("cer", "all3", "qty", "price", "total", "unit", "desc_exact")}
    m = score.metrics(pairs["dev"] + pairs["test"])
    res["all"] = {k: round(m[k], 4) for k in ("cer", "all3", "qty", "price", "total", "unit", "desc_exact")}
    bench = {}
    for i, b in enumerate(d["bench"]):
        h = reads[("b", i)]
        e = bench.setdefault(b["cond"], [0, 0])
        e[0] += lev(norm(b["ref"]), h)
        e[1] += len(norm(b["ref"]))
    res["bench"] = {k: round(e[0] / e[1], 4) for k, e in bench.items()}
    if teacher is not None:
        e = n = 0
        for k, t in reads.items():
            e += lev(teacher[k], t)
            n += max(len(teacher[k]), 1)
        res["agree_err"] = round(e / n, 5)
    else:
        pickle.dump(reads, open(tp, "wb"))
        res["agree_err"] = 0.0
    return res, reads
