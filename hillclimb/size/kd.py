#!/usr/bin/env python3
# The pickles read here were written by make_train.py / label.py on this machine, not downloaded.
"""Distil the VietOCR teacher into a smaller / quantised student.
  kd.py NAME --plan PLAN.json [--steps 6000] [--lr 3e-5] [--bs 48] [--ffn 2048] [--enc 6] [--dec 6] [--init CKPT]
Run from hillclimb/size with ../../venv_train/bin/python. Needs train/shard*.pkl and train/labels.pkl (make_train.py, label.py).
The student starts as a copy of the teacher (pruned if asked), learns from the teacher's logits on teacher-chosen
prefixes plus the teacher's encoder output, with weights passed through learned-step fake quantisation (LSQ) per the plan.
PLAN.json: {"cnn_a": [bits, group], ...} (group names from quant.py); a missing group stays fp16. Output: runs/NAME.json + runs/NAME.pt"""
import copy
import json
import math
import re
import pickle
import random
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
import torch.nn.utils.parametrize as P

sys.path.insert(0, str(Path(__file__).parent))
import evalkit as E  # noqa: E402
import quant as Q  # noqa: E402
from vietocr.tool.translate import process_input  # noqa: E402
from PIL import Image  # noqa: E402
import cv2  # noqa: E402

HERE = Path(__file__).parent
(HERE / "runs").mkdir(exist_ok=True)


CODES = {}   # filled by materialise(): integer codes and fp16 scales of every quantised tensor


# ---------- learned-step fake quantisation ----------
class FakeQ(nn.Module):
    """Symmetric uniform quantiser, one learned step per row (or per group of `group` weights inside a row)."""

    def __init__(self, w, bits, group):
        super().__init__()
        self.bits, self.group = bits, group
        self.shape = w.shape
        _, q, _ = Q.rtn(w, bits, group, clip_search=True)
        flat = self._split(w)
        qf = self._split(q.float())
        # least-squares step for the codes the clip search chose: s = <w, q> / <q, q>
        num = (flat * qf).sum(-1, keepdim=True)
        den = (qf * qf).sum(-1, keepdim=True).clamp_min(1e-9)
        s = (num / den).clamp_min(1e-4)
        self.log_s = nn.Parameter(s.log())

    def _split(self, w):
        flat = w.reshape(self.shape[0], -1)
        if self.group and flat.shape[1] % self.group == 0:
            flat = flat.reshape(self.shape[0], -1, self.group)
        return flat

    def codes(self, w):
        flat = self._split(w)
        s = self.log_s.exp().clamp_min(1e-4)
        s = s + (s.half().float() - s).detach()        # the wire format stores scales as fp16; train and test with exactly those
        lo, hi = -(2 ** (self.bits - 1)), 2 ** (self.bits - 1) - 1
        x = torch.clamp(flat / s, lo, hi)
        return x + (torch.round(x) - x).detach(), s

    def forward(self, w):
        q, s = self.codes(w)
        # rate proxy: bits a Laplace-like code would need, summed over the tensor (differentiable in the weights and the step)
        self.rate = torch.log2(1 + (w.reshape(q.shape) / s).abs()).sum()
        return (q * s).reshape(self.shape)


def attach_quant(model, plan):
    """plan: group -> [bits, group_size]. Wraps matching weights with FakeQ; returns the number of wrapped tensors."""
    n = 0
    for mod_name, mod in list(model.named_modules()):
        for pname, p in list(mod.named_parameters(recurse=False)):
            full = (mod_name + "." + pname).lstrip(".")
            g = Q.group_of(full)
            if g in plan and plan[g] is not None and p.dim() >= 2:
                bits, gs = plan[g]
                P.register_parametrization(mod, pname, FakeQ(p.data, bits, gs))
                n += 1
    return n


def total_rate(model):
    r = 0.0
    for mod in model.modules():
        if P.is_parametrized(mod):
            for name in mod.parametrizations.keys():
                r = r + mod.parametrizations[name][0].rate
    return r


def materialise(model, plan):
    """Bake the learned quantisers into plain weights; returns (plain model, size report)."""
    report = {}
    with torch.no_grad():
        for mod_name, mod in list(model.named_modules()):
            if not P.is_parametrized(mod):
                continue
            for pname in list(mod.parametrizations.keys()):
                fq = mod.parametrizations[pname][0]
                w = mod.parametrizations[pname].original
                q, s = fq.codes(w)
                q = torch.round(q)
                key = (mod_name + "." + pname).lstrip(".")
                report[key] = (w.numel(), Q.entropy_bits(q), s.numel())
                CODES[key] = {"codes": q.to(torch.int8).cpu().numpy(), "scales": s.half().cpu().numpy(), "bits": fq.bits, "group": fq.group, "shape": tuple(w.shape)}
                P.remove_parametrizations(mod, pname, leave_parametrized=True)
    return model, report


# ---------- data ----------
class Lines(torch.utils.data.Dataset):
    def __init__(self, dirs, vocab=None, truth=False, numbers_from_teacher=False):
        self.items = []
        for spec in dirs:
            d, _, only = str(spec).partition('@')              # 'train@real+short': only those sources of that folder
            d = Path(d); only = set(only.split('+')) if only else None
            lp = d / "labels.pkl"
            labels = pickle.load(open(lp, "rb")) if lp.exists() else {}
            for shard in sorted(d.glob("shard*.pkl")):
                for i, it in enumerate(pickle.load(open(shard, "rb"))):
                    if only and it.get("src") not in only:
                        continue
                    g = cv2.copyMakeBorder(E.tight(it["crop"]), 0, 0, 10, 10, cv2.BORDER_CONSTANT, value=255)
                    lab = labels.get((shard.name, i))
                    if truth:                                   # what the picture really says, not what the teacher read
                        ref = E.norm(it["ref"])
                        numeric = re.fullmatch(r"[\d.,\s()\-/%]+", ref or "") is not None
                        if numeric and lab and numbers_from_teacher:   # the teacher's reading of numbers (dot or comma) is what the pages need
                            pass
                        else:
                            lab = [1] + [vocab.c2i[c] for c in ref] + [2] if ref and all(c in vocab.c2i for c in ref) else None
                    if lab and 3 <= len(lab) <= 120:
                        self.items.append((g, lab))
        c = E.cfg()["dataset"]
        self.widths = []
        for g, _ in self.items:
            h, w = g.shape
            nw = math.ceil(int(c["image_height"] * w / h) / 10) * 10
            self.widths.append(min(max(nw, c["image_min_width"]), c["image_max_width"]))

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        c = E.cfg()["dataset"]
        g, lab = self.items[i]
        t = process_input(Image.fromarray(g).convert("RGB"), c["image_height"], c["image_min_width"], c["image_max_width"])[0]
        return t, torch.tensor(lab)


def bucket_batches(widths, bs, seed):
    rng = random.Random(seed)
    by = {}
    for i, w in enumerate(widths):
        by.setdefault(w, []).append(i)
    batches = []
    for w, idx in by.items():
        rng.shuffle(idx)
        batches += [idx[s:s + bs] for s in range(0, len(idx), bs)]
    rng.shuffle(batches)
    return batches


def collate(b):
    x = torch.stack([t for t, _ in b])
    T = max(len(l) for _, l in b)
    y = torch.zeros(len(b), T, dtype=torch.long)
    for i, (_, l) in enumerate(b):
        y[i, :len(l)] = l
    return x, y


# ---------- pruning ----------
def prune(model, ffn, enc, dec):
    """Shrink the transformer: FFN width by weight-norm importance, layer count by keeping evenly spaced layers."""
    tr = model.transformer.transformer
    with torch.no_grad():
        for stack in (tr.encoder.layers, tr.decoder.layers):
            for lay in stack:
                if ffn < lay.linear1.out_features:
                    imp = lay.linear1.weight.norm(dim=1) * lay.linear2.weight.norm(dim=0)
                    keep = imp.topk(ffn).indices.sort().values
                    l1 = nn.Linear(256, ffn); l2 = nn.Linear(ffn, 256)
                    l1.weight.copy_(lay.linear1.weight[keep]); l1.bias.copy_(lay.linear1.bias[keep])
                    l2.weight.copy_(lay.linear2.weight[:, keep]); l2.bias.copy_(lay.linear2.bias)
                    lay.linear1, lay.linear2 = l1, l2
    for name, stack, n in (("encoder", tr.encoder, enc), ("decoder", tr.decoder, dec)):
        L = len(stack.layers)
        if n < L:
            keep = sorted({round(i * (L - 1) / (n - 1)) for i in range(n)}) if n > 1 else [0]
            stack.layers = nn.ModuleList([stack.layers[i] for i in keep])
            stack.num_layers = len(keep)
    return model


def prune_cnn(model, width, drop):
    """Channel-prune the 512-wide convs (features 27..49) to `width`, and remove whole conv blocks listed in `drop`."""
    feats = model.cnn.model.features
    layers = list(feats)
    convs = [i for i, m in enumerate(layers) if isinstance(m, nn.Conv2d)]
    for i in drop:                                   # a conv, its batch-norm and its ReLU; channel counts must match
        assert layers[i].in_channels == layers[i].out_channels, f"conv {i} changes the channel count"
    layers = [m for j, m in enumerate(layers) if not any(j in (i, i + 1, i + 2) for i in drop)]
    convs = [i for i, m in enumerate(layers) if isinstance(m, nn.Conv2d)]
    wide = [i for i in convs if layers[i].out_channels == 512]
    prev_keep = None
    with torch.no_grad():
        for i in convs:
            conv, bn = layers[i], layers[i + 1]
            if prev_keep is not None:
                conv.weight = nn.Parameter(conv.weight[:, prev_keep].clone()); conv.in_channels = len(prev_keep)
                prev_keep = None
            if i in wide and width < 512:
                imp = conv.weight.flatten(1).norm(dim=1) * (bn.weight.abs() / (bn.running_var + bn.eps).sqrt())
                keep = imp.topk(width).indices.sort().values
                conv.weight = nn.Parameter(conv.weight[keep].clone()); conv.out_channels = width
                if conv.bias is not None:
                    conv.bias = nn.Parameter(conv.bias[keep].clone())
                for k in ("weight", "bias"):
                    setattr(bn, k, nn.Parameter(getattr(bn, k)[keep].clone()))
                bn.running_mean = bn.running_mean[keep].clone(); bn.running_var = bn.running_var[keep].clone(); bn.num_features = width
                prev_keep = keep
        if prev_keep is not None:                    # the 1x1 projection after the last conv
            c1 = model.cnn.model.last_conv_1x1
            c1.weight = nn.Parameter(c1.weight[:, prev_keep].clone()); c1.in_channels = len(prev_keep)
    model.cnn.model.features = nn.Sequential(*layers)
    return model


def logits_for(model, x, tgt_in):
    mem = model.transformer.forward_encoder(model.cnn(x))
    out, _ = model.transformer.forward_decoder(tgt_in, mem)
    return out, mem


def main():
    a = sys.argv
    name = a[1]
    opt = lambda k, d: type(d)(a[a.index(k) + 1]) if k in a else d
    steps, lr, bs = opt("--steps", 6000), opt("--lr", 3e-5), opt("--bs", 48)
    ffn, enc, dec = opt("--ffn", 2048), opt("--enc", 6), opt("--dec", 6)
    plan = json.load(open(a[a.index("--plan") + 1])) if "--plan" in a else {}
    lam_mem = opt("--mem", 0.5)
    lam = opt("--lam", 0.0)
    w_ce, w_kl = opt("--ce", 0.3), opt("--kl", 1.0)

    teacher, vocab = E.load_teacher()
    teacher = teacher.to(E.DEV).eval()
    student = copy.deepcopy(teacher).cpu()
    prune(student, ffn, enc, dec)
    cw = opt("--cw", 512)
    cdrop = [int(x) for x in opt("--cdrop", "").split(",") if x]
    if cw < 512 or cdrop:
        prune_cnn(student, cw, cdrop)
    if "--init" in a:
        student.load_state_dict(torch.load(a[a.index("--init") + 1], map_location="cpu", weights_only=True))
    attach_quant(student, plan)
    student = student.to(E.DEV).train()
    for m in student.modules():                     # no dropout: the teacher is a fixed target
        if isinstance(m, nn.Dropout):
            m.p = 0.0
    for m in student.modules():                     # batch-norm statistics stay those of the teacher
        if isinstance(m, nn.BatchNorm2d):
            m.eval()
    n_quant = sum(m.parametrizations[n].original.numel() for m in student.modules() if P.is_parametrized(m) for n in m.parametrizations.keys())
    truth = opt("--truth", 0) == 1
    ds = Lines(([str(HERE / d.split("@")[0]) + ("@" + d.split("@")[1] if "@" in d else "") for d in opt("--data", "train").split(",")]), vocab, truth, opt("--numbers-teacher", 0) == 1)
    print("train lines", len(ds), "student params", sum(p.numel() for n, p in student.named_parameters() if "log_s" not in n and "original" not in n) / 1e6, flush=True)
    scales = [p for n, p in student.named_parameters() if "log_s" in n]
    rest = [p for n, p in student.named_parameters() if "log_s" not in n]
    optim = torch.optim.AdamW([{"params": rest, "lr": lr}, {"params": scales, "lr": lr * 10}], weight_decay=0.0)
    sched = torch.optim.lr_scheduler.LambdaLR(optim, lambda s: min(1, (s + 1) / 150) * 0.5 * (1 + math.cos(math.pi * min(s / steps, 1))))
    log = []
    step, t0, epoch = 0, time.time(), 0
    while step < steps:
        batches = bucket_batches(ds.widths, bs, epoch)
        loader = torch.utils.data.DataLoader(ds, batch_sampler=batches, collate_fn=collate, num_workers=10, prefetch_factor=4)
        for x, y in loader:
            x, y = x.to(E.DEV), y.to(E.DEV)
            tgt_in = y[:, :-1].T.contiguous()
            valid = (y[:, 1:] != 0).float()
            with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
                t_logits, t_mem = logits_for(teacher, x, tgt_in)
            with torch.autocast("cuda", dtype=torch.bfloat16):
                s_logits, s_mem = logits_for(student, x, tgt_in)
            kl = (F.softmax(t_logits.float(), -1) * (F.log_softmax(t_logits.float(), -1) - F.log_softmax(s_logits.float(), -1))).sum(-1)
            kl = (kl * valid).sum() / valid.sum()
            ce = (F.cross_entropy(s_logits.float().transpose(1, 2), y[:, 1:], reduction="none") * valid).sum() / valid.sum()
            mem = F.mse_loss(s_mem.float(), t_mem.float()) / t_mem.float().pow(2).mean().clamp_min(1e-6)
            loss = w_kl * kl + w_ce * ce + lam_mem * mem
            if lam > 0:
                loss = loss + lam * total_rate(student) / n_quant
            optim.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(student.parameters(), 1.0)
            optim.step(); sched.step(); step += 1
            if step % 100 == 0:
                print(f"step {step} loss {loss.item():.4f} kl {kl.item():.4f} mem {mem.item():.4f} {time.time() - t0:.0f}s", flush=True)
            if step >= steps:
                break
        epoch += 1
    student.eval()
    plain, rep = materialise(student, plan)
    total = sum(p.numel() for p in plain.parameters())
    res, _ = E.evaluate(plain, vocab, name)
    res["bench2"] = E.bench2(plain, vocab)
    res["size_mb"] = round(Q.size_mb(rep, total), 2)
    by = {}
    for n, (cnt, b, sc) in rep.items():
        g = Q.group_of(n) or "other"
        e = by.setdefault(g, [0, 0.0, 0])
        e[0] += cnt; e[1] += cnt * b / 8 + sc * 2; e[2] += 1
    res["by_group_mb"] = {g: [round(c / 1e6, 2), round(by_b / 1e6, 2), round(by_b * 8 / c, 2)] for g, (c, by_b, _) in by.items()}
    res["unquantised_mb"] = round((total - sum(c for c, _, _ in rep.values())) * 2 / 1e6, 2)
    res["params_m"] = round(total / 1e6, 2)
    res["args"] = {"truth": truth, "ce": w_ce, "kl": w_kl, "cw": cw, "cdrop": cdrop, "steps": steps, "lam": lam, "lr": lr, "ffn": ffn, "enc": enc, "dec": dec, "plan": plan}
    print(json.dumps(res), flush=True)
    json.dump(res, open(HERE / "runs" / f"{name}.json", "w"))
    torch.save(plain.state_dict(), HERE / "runs" / f"{name}.pt")
    pickle.dump(CODES, open(HERE / "runs" / f"{name}.codes.pkl", "wb"))


if __name__ == "__main__":
    main()
