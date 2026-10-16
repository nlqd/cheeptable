"""Weight quantisation experiments in torch. A "plan" maps parameter names to (bits, group); group 0 = one scale per output row."""
import re
import numpy as np
import torch

GROUPS = {
    "cnn_a": r"cnn\.model\.features\.(0|3|7|10|14|17|20|23)\.weight",
    "cnn_b": r"cnn\.model\.features\.(27|30|33|36)\.weight",
    "cnn_c": r"cnn\.model\.features\.(40|43|46|49)\.weight",
    "cnn_1x1": r"last_conv_1x1",
    "enc_attn": r"encoder\.layers\.\d\.self_attn\.(in_proj|out_proj)",
    "enc_ffn": r"encoder\.layers\.\d\.linear[12]\.weight",
    "dec_self": r"decoder\.layers\.\d\.self_attn\.(in_proj|out_proj)",
    "dec_cross": r"decoder\.layers\.\d\.multihead_attn\.(in_proj|out_proj)",
    "dec_ffn": r"decoder\.layers\.\d\.linear[12]\.weight",
    "emb_fc": r"(embed_tgt|transformer\.fc)\.weight",
}


def group_of(name):
    for g, pat in GROUPS.items():
        if re.search(pat, name):
            return g
    return None


def rtn(w, bits, group=0, clip_search=False):
    """Symmetric round-to-nearest. Returns (dequantised weight, integer codes, number of scales)."""
    shape = w.shape
    flat = w.reshape(shape[0], -1).float()
    if group and flat.shape[1] % group == 0:
        flat = flat.reshape(shape[0], -1, group)
    qmax = 2 ** (bits - 1) - 1
    amax = flat.abs().amax(dim=-1, keepdim=True)
    best = None
    ratios = [1.0] if not clip_search else [1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5]
    for r in ratios:
        scale = (amax * r / qmax).clamp_min(1e-12)
        q = torch.clamp(torch.round(flat / scale), -qmax - 1 if clip_search else -qmax, qmax)
        err = ((q * scale - flat) ** 2).sum(dim=-1, keepdim=True)
        if best is None:
            best = [err, scale, q]
        else:
            better = err < best[0]
            best = [torch.where(better, err, best[0]), torch.where(better, scale, best[1]), torch.where(better, q, best[2])]
    _, scale, q = best
    return (q * scale).reshape(shape).to(w.dtype), q.reshape(shape).to(torch.int16), scale.numel()


def entropy_bits(q):
    """Order-0 entropy in bits per weight of integer codes: what an entropy coder would reach on this tensor."""
    v, c = np.unique(q.cpu().numpy().ravel(), return_counts=True)
    p = c / c.sum()
    return float(-(p * np.log2(p)).sum())


def apply_plan(model, plan, clip_search=False, report=None):
    """plan: {group_name: (bits, group)}. Replaces the weights in place; fills report[name] = (numel, bits_per_weight_entropy, scales)."""
    with torch.no_grad():
        for n, p in model.named_parameters():
            g = group_of(n)
            if g in plan and plan[g] is not None:
                bits, gs = plan[g]
                deq, q, ns = rtn(p.data, bits, gs, clip_search)
                p.data.copy_(deq)
                if report is not None:
                    report[n] = (p.numel(), entropy_bits(q), ns)
    return model


def size_mb(report, all_params, scale_bytes=2):
    """Bytes if every quantised tensor is entropy coded (order 0) + fp16 scales, other params kept fp16."""
    q = sum(n * b / 8 + s * scale_bytes for n, b, s in report.values())
    qn = sum(n for n, _, _ in report.values())
    other = (all_params - qn) * 2
    return (q + other) / 1e6
