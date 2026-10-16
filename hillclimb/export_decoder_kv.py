#!/usr/bin/env python3
"""Export VietOCR's decoder with a key/value cache as two ONNX graphs.   export_decoder_kv.py OUTDIR

  dec_init.onnx  memory [T,1,256]                          -> cross_k, cross_v [6,8,T,32]   (once per line)
  dec_step.onnx  token [1], pos [1], past_k, past_v [6,8,P,32], cross_k, cross_v
                                                           -> logits [vocab], new_k, new_v [6,8,P+1,32]

The original decoder recomputes the cross-attention projection of the whole encoder output and every earlier token at
every step. Here the cross projection happens once and each step handles one token. Weights are rounded to fp16 first so
the numbers match the hosted fp16 model, and the output is checked against the original decoder step by step.
Run with ../venv_onnx_export/bin/python."""
import math
import sys
from pathlib import Path

import numpy as np
import torch
from torch import nn

import recog

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)

model = recog.predictor().model.eval()
for p in model.parameters():
    p.data = p.data.half().float()          # the hosted model stores fp16 weights; match it exactly
    p.requires_grad_(False)
tr = model.transformer
layers = list(tr.transformer.decoder.layers)
final_norm = tr.transformer.decoder.norm
E, H = tr.d_model, layers[0].self_attn.num_heads
HD = E // H
L = len(layers)


def heads(x):                                # [n, E] -> [H, n, HD]
    return x.reshape(x.shape[0], H, HD).permute(1, 0, 2)


class Init(nn.Module):
    def forward(self, memory):               # memory [T,1,E]
        m = memory[:, 0, :]
        ks, vs = [], []
        for layer in layers:
            w, b = layer.multihead_attn.in_proj_weight, layer.multihead_attn.in_proj_bias
            ks.append(heads(m @ w[E:2 * E].T + b[E:2 * E]))
            vs.append(heads(m @ w[2 * E:].T + b[2 * E:]))
        return torch.stack(ks), torch.stack(vs)


def attend(q, k, v):                         # q [H,1,HD], k/v [H,n,HD] -> [1,E]
    scores = torch.softmax(q @ k.transpose(1, 2) / math.sqrt(HD), dim=-1)
    return (scores @ v).permute(1, 0, 2).reshape(1, E)


class Step(nn.Module):
    def forward(self, token, pos, past_k, past_v, cross_k, cross_v):
        x = tr.embed_tgt(token) * math.sqrt(E) + tr.pos_enc.pe[pos, 0, :]       # [1,E]
        new_k, new_v = [], []
        for i, layer in enumerate(layers):
            sa = layer.self_attn
            q = heads(x @ sa.in_proj_weight[:E].T + sa.in_proj_bias[:E])
            k = torch.cat([past_k[i], heads(x @ sa.in_proj_weight[E:2 * E].T + sa.in_proj_bias[E:2 * E])], dim=1)
            v = torch.cat([past_v[i], heads(x @ sa.in_proj_weight[2 * E:].T + sa.in_proj_bias[2 * E:])], dim=1)
            new_k.append(k)
            new_v.append(v)
            x = layer.norm1(x + sa.out_proj(attend(q, k, v)))

            ca = layer.multihead_attn
            q = heads(x @ ca.in_proj_weight[:E].T + ca.in_proj_bias[:E])
            x = layer.norm2(x + ca.out_proj(attend(q, cross_k[i], cross_v[i])))

            x = layer.norm3(x + layer.linear2(torch.relu(layer.linear1(x))))
        return tr.fc(final_norm(x))[0], torch.stack(new_k), torch.stack(new_v)


# ── check against the original decoder ──
torch.manual_seed(0)
T = 37
memory = torch.randn(T, 1, E)
init, step = Init().eval(), Step().eval()
with torch.no_grad():
    ck, cv = init(memory)
    pk = torch.zeros(L, H, 0, HD)
    pv = torch.zeros(L, H, 0, HD)
    toks = [1]
    worst = 0.0
    for t in range(25):
        ref = tr.forward_decoder(torch.tensor(toks).unsqueeze(1), memory)[0][0, -1]
        logits, pk, pv = step(torch.tensor([toks[-1]]), torch.tensor([t]), pk, pv, ck, cv)
        worst = max(worst, float((ref - logits).abs().max()))
        toks.append(int(ref.argmax()) if t % 2 else 5 + t)
print("max |logit difference| over 25 steps vs the original decoder: %.2e" % worst)
assert worst < 1e-3, "incremental decoder does not match the original"

# ── export ──
torch.onnx.export(init, (memory,), str(out / "dec_init.onnx"), input_names=["memory"], output_names=["cross_k", "cross_v"],
                  dynamic_axes={"memory": {0: "T"}, "cross_k": {2: "T"}, "cross_v": {2: "T"}}, opset_version=17, dynamo=False)
args = (torch.tensor([7]), torch.tensor([3]), torch.randn(L, H, 3, HD), torch.randn(L, H, 3, HD), ck, cv)
torch.onnx.export(step, args, str(out / "dec_step.onnx"),
                  input_names=["token", "pos", "past_k", "past_v", "cross_k", "cross_v"], output_names=["logits", "new_k", "new_v"],
                  dynamic_axes={"past_k": {2: "P"}, "past_v": {2: "P"}, "cross_k": {2: "T"}, "cross_v": {2: "T"},
                                "new_k": {2: "P1"}, "new_v": {2: "P1"}}, opset_version=17, dynamo=False)
for f in ("dec_init.onnx", "dec_step.onnx"):
    print(f, round((out / f).stat().st_size / 1e6, 1), "MB")
