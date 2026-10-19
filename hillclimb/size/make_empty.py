#!/usr/bin/env python3
"""Training shard of crops that hold no text, with the empty string as the target: paper texture, scanner specks, ruling remnants,
underlines, fold marks, shaded cells. The recogniser is a decoder that must emit something; shown only text during training it invents
digit strings for these crops (the grid reader hands it ruling stubs and shaded header cells).
  make_empty.py OUTDIR [N]     run from hillclimb/ with ../venv_train/bin/python"""
import pickle
import random
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, ".")
sys.path.insert(0, "size")
import robust_sweep_lib as D  # noqa: E402

out = sys.argv[1]
n = int(sys.argv[2]) if len(sys.argv) > 2 else 12000
rng = random.Random(23)
nrng = np.random.default_rng(23)
D.seed(23)


def paper(h, w):
    base = rng.randint(215, 255)
    a = np.full((h, w), base, np.float32)
    a += nrng.normal(0, rng.uniform(2, 12), (h, w))
    if rng.random() < 0.6:                                         # low-frequency blotches
        blot = cv2.resize(nrng.normal(0, rng.uniform(4, 14), (max(2, h // 8), max(2, w // 8))).astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
        a += blot
    return a


def specks(a):
    h, w = a.shape
    k = int(h * w * rng.uniform(0.0003, 0.004))
    for _ in range(k):
        y, x = rng.randrange(h), rng.randrange(w)
        a[y:y + rng.choice([1, 1, 2]), x:x + rng.choice([1, 1, 2, 3])] = rng.randint(40, 150)


def remnants(a):
    h, w = a.shape
    ink = rng.randint(0, 90)
    for side, p in (("l", 0.5), ("r", 0.5), ("t", 0.45), ("b", 0.45)):
        if rng.random() < p:
            wd = rng.randint(1, 3)
            if side == "l": a[:, :wd] = ink
            if side == "r": a[:, w - wd:] = ink
            if side == "t": a[:wd, :] = ink
            if side == "b": a[h - wd:, :] = ink


def shape(a):
    h, w = a.shape
    ink = rng.randint(0, 100)
    k = rng.random()
    if k < 0.4:                                                     # an underline or a short rule
        ln, th = rng.randint(max(10, w // 8), max(12, w * 3 // 4)), rng.randint(1, 4)
        x, y = rng.randint(0, max(0, w - ln)), rng.randint(0, h - th)
        a[y:y + th, x:x + ln] = ink
    elif k < 0.75:                                                  # a fold mark, a hole, a staple: narrow and tall
        th, ln = rng.randint(2, 9), rng.randint(max(8, h // 2), h)
        x, y = rng.randint(0, max(0, w - th)), rng.randint(0, h - ln)
        a[y:y + ln, x:x + th] = ink
    else:                                                           # dust blob
        cv2.circle(a, (rng.randrange(w), rng.randrange(h)), rng.randint(2, 6), float(ink), -1)


def degrade(img):
    fns = []
    if rng.random() < 0.4: fns.append(D.rotate(rng.uniform(-1.2, 1.2)))
    if rng.random() < 0.4: fns.append(D.blur(rng.uniform(0.4, 1.1)))
    if rng.random() < 0.5: fns.append(D.noise(rng.uniform(3, 14)))
    if rng.random() < 0.7: fns.append(D.jpeg(rng.randint(30, 85)))
    return D.chain(*fns)(img) if fns else img


items = []
while len(items) < n:
    h, w = rng.randint(18, 70), rng.randint(40, 700)
    a = paper(h, w)
    kind = rng.choice(["paper", "specks", "remnants", "shape", "shaded", "mixed"])
    if kind == "shaded":
        a = a * rng.uniform(0.75, 0.92)
    if kind in ("specks", "shaded", "mixed"):
        specks(a)
    if kind in ("remnants", "mixed"):
        remnants(a)
    if kind in ("shape", "mixed"):
        shape(a)
    g = degrade(np.clip(a, 0, 255).astype(np.uint8))
    items.append({"crop": g, "ref": "", "src": "empty"})
out_dir = Path(out)
out_dir.mkdir(parents=True, exist_ok=True)
for s in range(0, len(items), 10000):
    pickle.dump(items[s:s + 10000], open(out_dir / f"shard{s // 10000:02d}.pkl", "wb"))
print("wrote", len(items))
