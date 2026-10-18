#!/usr/bin/env python3
"""Training lines for distilling a smaller recogniser.   make_train.py OUTDIR [--real 25000] [--synth 40000]
Run from hillclimb/ with ../venv_train/bin/python. Labels are not needed (the teacher labels what it sees), but the PDF text
layer is kept for the real lines so the teacher's own error can be measured.
Held out from every training line: the pages and lines the evaluation set (make_data.py) uses, and the whole contract."""
import json
import pickle
import random
import re
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, "..")
sys.path.insert(0, ".")
import line_bench as L  # noqa: E402
import robust_sweep_lib as D  # noqa: E402

out = Path(sys.argv[1])
out.mkdir(exist_ok=True)
a = sys.argv
n_real = int(a[a.index("--real") + 1]) if "--real" in a else 25000
n_synth = int(a[a.index("--synth") + 1]) if "--synth" in a else 40000
seed = int(a[a.index("--seed") + 1]) if "--seed" in a else 1
rng = random.Random(seed)
nrng = np.random.default_rng(seed)

# ---- what the evaluation set uses (same sampling as variant_bench.build_crops) ----
eval_pages, eval_refs = set(), set()
erng = random.Random(0)
docs = [e for e in json.load(open(L.MANIFEST)) if e["born_digital"] is True]
for e in docs:
    pdf = pdfium.PdfDocument(e["local_path"])
    for p, lines in L.sample_pages(pdf, 4, 12, erng):
        eval_pages.add((e["id"], p))
        eval_refs.update(t for t, _ in lines)


def degrade_random(img):
    """One random scan-like degradation, milder to rougher than the benchmark's own conditions."""
    k = rng.random()
    fns = []
    if rng.random() < 0.7:
        fns.append(D.rotate(rng.uniform(-1.5, 1.5)))
    if rng.random() < 0.5:
        fns.append(D.lowres(rng.choice([0.5, 0.6, 0.75])))
    if rng.random() < 0.6:
        fns.append(D.blur(rng.uniform(0.4, 1.3)))
    if rng.random() < 0.6:
        fns.append(D.contrast(rng.uniform(0.6, 1.0)))
    if rng.random() < 0.6:
        fns.append(D.noise(rng.uniform(3, 16)))
    if rng.random() < 0.7:
        fns.append(D.jpeg(rng.randint(25, 85)))
    if k < 0.15:
        fns = []          # some lines stay clean
    return D.chain(*fns)(img) if fns else img


# ---- real lines ----
real, corpus = [], []
D.seed(seed)
for e in docs:
    pdf = pdfium.PdfDocument(e["local_path"])
    for p in range(len(pdf)):
        lines = L.page_lines(pdf[p])
        corpus += [t for t, _ in lines if t not in eval_refs]
        if len(lines) < 4 or (e["id"], p) in eval_pages:
            continue
        real.append((e, p, [x for x in lines if x[0] not in eval_refs]))
print("pages usable", len(real), "corpus lines", len(corpus), flush=True)
rng.shuffle(real)
per_page = max(3, n_real // max(len(real), 1))
real_out = []
for e, p, lines in real:
    page = pdfium.PdfDocument(e["local_path"])[p]
    base = np.array(page.render(scale=L.SCALE).to_pil().convert("L"))
    img = degrade_random(base)
    for text, box in rng.sample(lines, min(per_page, len(lines))):
        x0, y0, x1, y1 = L.box_px(box, page.get_height(), 0, img.shape)
        crop = img[y0:y1, x0:x1]
        if crop.size and crop.shape[0] >= 8 and crop.shape[1] >= 12:
            real_out.append({"crop": crop, "ref": text, "src": "real"})
    if len(real_out) >= n_real:
        break
print("real crops", len(real_out), flush=True)

# ---- synthetic lines ----
fonts = [l.split(":")[0] for l in subprocess.run(["fc-list", ":lang=vi", "file"], capture_output=True, text=True).stdout.splitlines()]
fonts = sorted({f for f in fonts if f.endswith((".ttf", ".otf")) and not re.search(r"Iosevka|Nerd|Mono|Symbols|Emoji|Thin|Black", f)})
print("fonts", len(fonts), flush=True)
words = [w for t in corpus for w in t.split()]


def number():
    kind = rng.random()
    if kind < 0.55:                                            # whole numbers with dots between thousands, the usual price or total
        v = rng.randint(1, 10 ** rng.randint(2, 10))
        s = f"{v:,}".replace(",", ".")
    elif kind < 0.80:                                          # a decimal comma with one or two digits, thousands with dots
        s = f"{rng.randint(0, 99999):,}".replace(",", ".") + "," + str(rng.randint(0, 99)).zfill(rng.randint(1, 2))
    elif kind < 0.97:
        s = str(rng.randint(1, 400))
    else:                                                      # three decimal digits are rare in real tables
        s = f"{rng.randint(0, 99):,}".replace(",", ".") + "," + str(rng.randint(0, 999)).zfill(3)
    return s


def text_line():
    k = rng.random()
    if k < 0.35:
        return number()
    if k < 0.7:
        return " ".join(rng.choices(words, k=rng.randint(1, 9)))
    if k < 0.9:
        return rng.choice(corpus)
    return rng.choice(corpus)[: rng.randint(6, 30)] + " " + number()


synth = []
for i in range(n_synth):
    text = text_line()
    if not text.strip() or len(text) > 90:
        continue
    f = ImageFont.truetype(rng.choice(fonts), rng.randint(16, 40))
    try:
        l, t, r, b = f.getbbox(text)
    except Exception:
        continue
    pad = rng.randint(2, 10)
    im = Image.new("L", (r - l + 2 * pad, b - t + 2 * pad), 255)
    ImageDraw.Draw(im).text((pad - l, pad - t), text, font=f, fill=rng.randint(0, 70))
    g = degrade_random(np.array(im))
    if g.shape[0] >= 8 and g.shape[1] >= 12:
        synth.append({"crop": g, "ref": text, "src": "synth"})
print("synthetic crops", len(synth), flush=True)

allc = real_out + synth
rng.shuffle(allc)
for s in range(0, len(allc), 10000):
    pickle.dump(allc[s:s + 10000], open(out / f"shard{s // 10000:02d}.pkl", "wb"))
print("wrote", len(allc), "crops in", (len(allc) + 9999) // 10000, "shards", flush=True)
