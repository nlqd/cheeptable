#!/usr/bin/env python3
"""Extra training shard of very short cells (one to a few characters: quantities, units, short numbers).
The first student runs read a lone digit as '1990002'; the first training set had almost none of these.
  make_short.py TRAINDIR/shard07.pkl [N]     run from hillclimb/ with ../venv_train/bin/python"""
import pickle
import random
import re
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, ".")
import robust_sweep_lib as D  # noqa: E402

out = sys.argv[1]
n = int(sys.argv[2]) if len(sys.argv) > 2 else 15000
rng = random.Random(7)
D.seed(7)
fonts = [l.split(":")[0] for l in subprocess.run(["fc-list", ":lang=vi", "file"], capture_output=True, text=True).stdout.splitlines()]
fonts = sorted({f for f in fonts if f.endswith((".ttf", ".otf")) and not re.search(r"Iosevka|Nerd|Mono|Symbols|Emoji|Thin|Black", f)})
units = ["m", "m2", "m3", "cái", "bộ", "kg", "tấn", "md", "cây", "tờ", "ca", "lít", "100 m", "1000 m2", "m²", "m³", "Bộ", "Cái", "ha", "km", "tháng", "ngày", "công", "lần", "chiếc", "gói", "hộp", "cuộn", "thùng", "đoạn"]


def short_text():
    k = rng.random()
    if k < 0.45:
        return str(rng.randint(0, 99)) if rng.random() < 0.7 else str(rng.randint(100, 999))
    if k < 0.6:
        return f"{rng.randint(0, 9)},{rng.randint(0, 99)}"
    if k < 0.9:
        return rng.choice(units)
    return rng.choice(["-", "x", "I", "II", "III", "IV", "V", "A", "B", "a", "b", "1.", "2.", "(1)", "(2)", "%"])


def degrade(img):
    fns = []
    if rng.random() < 0.7: fns.append(D.rotate(rng.uniform(-1.5, 1.5)))
    if rng.random() < 0.5: fns.append(D.lowres(rng.choice([0.5, 0.6, 0.75])))
    if rng.random() < 0.6: fns.append(D.blur(rng.uniform(0.4, 1.3)))
    if rng.random() < 0.6: fns.append(D.contrast(rng.uniform(0.6, 1.0)))
    if rng.random() < 0.6: fns.append(D.noise(rng.uniform(3, 16)))
    if rng.random() < 0.7: fns.append(D.jpeg(rng.randint(25, 85)))
    return D.chain(*fns)(img) if fns and rng.random() > 0.15 else img


items = []
while len(items) < n:
    text = short_text()
    f = ImageFont.truetype(rng.choice(fonts), rng.randint(16, 44))
    l, t, r, b = f.getbbox(text)
    if r - l < 2 or b - t < 2:
        continue
    pad = rng.randint(2, 12)
    im = Image.new("L", (r - l + 2 * pad, b - t + 2 * pad), 255)
    ImageDraw.Draw(im).text((pad - l, pad - t), text, font=f, fill=rng.randint(0, 70))
    g = degrade(np.array(im))
    if g.shape[0] >= 8 and g.shape[1] >= 8:
        items.append({"crop": g, "ref": text, "src": "short"})
pickle.dump(items, open(out, "wb"))
print("wrote", len(items))
