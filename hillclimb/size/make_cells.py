#!/usr/bin/env python3
"""Training shard of table-cell crops: text inside a wider cell with ruling-line remnants at the edges, which is what the grid
reader hands to the recogniser (the first students read a lone right-aligned '2' as '1990002').
  make_cells.py OUT.pkl [N]     run from hillclimb/ with ../venv_train/bin/python"""
import pickle
import random
import re
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, ".")
sys.path.insert(0, "size")
import robust_sweep_lib as D  # noqa: E402

out = sys.argv[1]
n = int(sys.argv[2]) if len(sys.argv) > 2 else 30000
rng = random.Random(11)
D.seed(11)
fonts = [l.split(":")[0] for l in subprocess.run(["fc-list", ":lang=vi", "file"], capture_output=True, text=True).stdout.splitlines()]
fonts = sorted({f for f in fonts if f.endswith((".ttf", ".otf")) and not re.search(r"Iosevka|Nerd|Mono|Symbols|Emoji|Thin|Black", f)})
units = ["m", "m2", "m3", "cái", "bộ", "kg", "tấn", "md", "cây", "tờ", "ca", "lít", "100 m", "1000 m2", "m²", "m³", "Bộ", "Cái", "ha", "km", "tháng", "ngày", "công", "lần", "chiếc", "gói", "hộp", "cuộn", "thùng", "đoạn", "10 cái", "100 cái", "1 bộ"]
corpus = [t for t in pickle.load(open("size/corpus.pkl", "rb"))]


def number():
    k = rng.random()
    if k < 0.35:
        return str(rng.randint(0, 99))
    if k < 0.6:
        return f"{rng.randint(1, 10 ** rng.randint(3, 10)):,}".replace(",", ".")
    if k < 0.8:
        return f"{rng.randint(0, 9999):,}".replace(",", ".") + "," + str(rng.randint(0, 999)).zfill(rng.randint(1, 3))
    return str(rng.randint(100, 9999))


def text_and_align():
    k = rng.random()
    if k < 0.4:
        return number(), "right"
    if k < 0.55:
        return rng.choice(units), rng.choice(["center", "left", "center"])
    if k < 0.62:
        return str(rng.randint(1, 400)), "center"
    t = rng.choice(corpus)
    return t[: rng.randint(8, 70)].strip() or t, "left"


def degrade(img):
    fns = []
    if rng.random() < 0.5: fns.append(D.rotate(rng.uniform(-1.2, 1.2)))
    if rng.random() < 0.4: fns.append(D.lowres(rng.choice([0.5, 0.6, 0.75])))
    if rng.random() < 0.5: fns.append(D.blur(rng.uniform(0.4, 1.1)))
    if rng.random() < 0.5: fns.append(D.contrast(rng.uniform(0.6, 1.0)))
    if rng.random() < 0.5: fns.append(D.noise(rng.uniform(3, 14)))
    if rng.random() < 0.7: fns.append(D.jpeg(rng.randint(30, 85)))
    return D.chain(*fns)(img) if fns and rng.random() > 0.1 else img


items = []
while len(items) < n:
    text, align = text_and_align()
    f = ImageFont.truetype(rng.choice(fonts), rng.randint(13, 24))
    l, t, r, b = f.getbbox(text)
    tw, th = r - l, b - t
    if tw < 2 or th < 2 or tw > 700:
        continue
    h = max(th + rng.randint(6, 22), 24)
    w = tw + rng.randint(10, 160) if align != "left" else tw + rng.randint(6, 80)
    im = Image.new("L", (w, h), 255)
    x = {"right": w - tw - rng.randint(3, 12), "center": (w - tw) // 2 + rng.randint(-4, 4), "left": rng.randint(3, 10)}[align]
    ImageDraw.Draw(im).text((x - l, (h - th) // 2 - t + rng.randint(-2, 2)), text, font=f, fill=rng.randint(0, 70))
    a = np.array(im)
    ink = rng.randint(0, 90)
    for side, p in (("l", 0.5), ("r", 0.5), ("t", 0.45), ("b", 0.45)):          # ruling-line remnants
        if rng.random() < p:
            wd = rng.randint(1, 3)
            if side == "l": a[:, :wd] = ink
            if side == "r": a[:, w - wd:] = ink
            if side == "t": a[:wd, :] = ink
            if side == "b": a[h - wd:, :] = ink
    g = degrade(a)
    items.append({"crop": g, "ref": text, "src": "cell"})
pickle.dump(items, open(out, "wb"))
print("wrote", len(items))
