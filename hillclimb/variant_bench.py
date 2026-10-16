#!/usr/bin/env python3
"""Read the same sampled lines with different encoder / decoder models.
  variant_bench.py OUT.json --lines 12 --variant NAME ENC DEC_INIT DEC_STEP [--variant ...]
ENC is 'torch' or an .onnx path; DEC_INIT is 'torch' (then DEC_STEP is ignored) or an .onnx path.
Lines come from the public born-digital PDFs as in line_bench.py; conditions clean and rough. Run from hillclimb/ with
../venv_onnx_export/bin/python."""
import json
import random
import sys

import numpy as np
import onnxruntime as ort
import pypdfium2 as pdfium
import torch
from vietocr.tool.translate import process_input

sys.path.insert(0, ".")
import line_bench as L  # noqa: E402
import recog  # noqa: E402
import robust_sweep_lib as D  # noqa: E402

CONDS = {"clean": (0, lambda x: x), "rough": (1.5, D.chain(D.rotate(1.5), D.blur(1.2), D.noise(15), D.contrast(0.7), D.jpeg(30)))}


def build_crops(n_lines):
    rng = random.Random(0)
    crops = []
    for e in [e for e in json.load(open(L.MANIFEST)) if e["born_digital"] is True]:
        pdf = pdfium.PdfDocument(e["local_path"])
        for p, lines in L.sample_pages(pdf, 4, n_lines, rng):
            page = pdf[p]
            base = np.array(page.render(scale=L.SCALE).to_pil().convert("L"))
            for cond, (rot, fn) in CONDS.items():
                D.seed(0)
                img = fn(base)
                for text, box in lines:
                    x0, y0, x1, y1 = L.box_px(box, page.get_height(), rot, img.shape)
                    crop = img[y0:y1, x0:x1]
                    if crop.size:
                        crops.append({"cond": cond, "doc": e["id"], "ref": text, "crop": crop})
    return crops


def tensor_for(crop):
    pred = recog.predictor()
    c = pred.config["dataset"]
    return process_input(recog.to_pil(recog.pad(recog.tight(crop), 10)), c["image_height"], c["image_min_width"], c["image_max_width"])


def make_reader(enc, dec_init, dec_step):
    pred = recog.predictor()
    opts = ort.SessionOptions(); opts.log_severity_level = 3
    sess = lambda f: ort.InferenceSession(f, opts, providers=["CPUExecutionProvider"])
    if dec_init == "torch" and enc == "torch":
        return lambda crop: pred.predict(recog.to_pil(recog.pad(recog.tight(crop), 10)))
    enc_s = None if enc == "torch" else sess(enc)
    init_s, step_s = sess(dec_init), sess(dec_step)

    def read(crop):
        x = tensor_for(crop)
        with torch.no_grad():
            mem = pred.model.transformer.forward_encoder(pred.model.cnn(x)).numpy() if enc_s is None else enc_s.run(None, {"image": x.numpy()})[0]
        ck, cv = init_s.run(None, {"memory": mem.astype(np.float32)})
        pk = np.zeros((6, 8, 0, 32), np.float32); pv = pk.copy()
        ids, tok = [1], 1
        for t in range(128):
            logits, pk, pv = step_s.run(None, {"token": np.array([tok], np.int64), "pos": np.array([t], np.int64),
                                               "past_k": pk, "past_v": pv, "cross_k": ck, "cross_v": cv})
            tok = int(logits.argmax())
            if tok == 2:
                break
            ids.append(tok)
        return pred.vocab.decode(ids + [2])
    return read


def main():
    a = sys.argv
    n_lines = int(a[a.index("--lines") + 1]) if "--lines" in a else 12
    variants = [(a[i + 1], a[i + 2], a[i + 3], a[i + 4]) for i, x in enumerate(a) if x == "--variant"]
    crops = build_crops(n_lines)
    print("crops", len(crops), file=sys.stderr, flush=True)
    out = []
    for name, enc, di, ds in variants:
        read = make_reader(enc, di, ds)
        for c in crops:
            out.append({"cond": c["cond"] + "/" + name, "doc": c["doc"], "ref": c["ref"], "hyp": L.norm(read(c["crop"]))})
        print("done", name, file=sys.stderr, flush=True)
    json.dump(out, open(a[1], "w"), ensure_ascii=False)


if __name__ == "__main__":
    main()
