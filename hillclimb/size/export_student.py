#!/usr/bin/env python3
"""Export a distilled student to three fp32 ONNX graphs.   export_student.py STATE.pt OUTDIR [--ffn N] [--enc N] [--dec N]
  encoder.onnx   image [1,3,32,W] -> memory [T,1,256]
  dec_init.onnx  memory -> cross_k, cross_v           dec_step.onnx  one cached decoder step (same I/O as the hosted ones)
Run with ../../venv_train/bin/python. Checks each graph against torch before it is written."""
import math
import sys
from pathlib import Path

import numpy as np
import torch
from torch import nn

sys.path.insert(0, str(Path(__file__).parent))
import evalkit as E  # noqa: E402
import kd  # noqa: E402

a = sys.argv
opt = lambda k, d: int(a[a.index(k) + 1]) if k in a else d
out = Path(a[2])
out.mkdir(parents=True, exist_ok=True)
model, _ = E.load_teacher()
kd.prune(model, opt("--ffn", 2048), opt("--enc", 6), opt("--dec", 6))
if opt("--cw", 512) < 512:
    kd.prune_cnn(model, opt("--cw", 512), [])
model.load_state_dict(torch.load(a[1], map_location="cpu", weights_only=True))
model = model.eval()
for p in model.parameters():
    p.requires_grad_(False)
tr = model.transformer
tr.pos_enc.pe = tr.pos_enc.pe[:400].clone()     # widths up to 512 px give 256 positions; decoding stops at 128 tokens
Em = tr.d_model


enc_layers = list(tr.transformer.encoder.layers)
enc_norm = tr.transformer.encoder.norm
EH = enc_layers[0].self_attn.num_heads


class Encoder(nn.Module):
    """Written out by hand: torch's attention bakes the traced sequence length into the graph."""

    def forward(self, img):
        conv = model.cnn.model.features(img)
        conv = model.cnn.model.last_conv_1x1(conv)
        x = conv.transpose(2, 3).flatten(2).permute(2, 0, 1).reshape(-1, Em) * math.sqrt(Em)      # [T, E]
        pos = torch.cumsum(torch.ones_like(x[:, 0]), 0).long() - 1
        x = x + tr.pos_enc.pe[:, 0, :][pos]
        for layer in enc_layers:
            sa = layer.self_attn
            q = (x @ sa.in_proj_weight[:Em].T + sa.in_proj_bias[:Em]).reshape(-1, EH, Em // EH).permute(1, 0, 2)
            k = (x @ sa.in_proj_weight[Em:2 * Em].T + sa.in_proj_bias[Em:2 * Em]).reshape(-1, EH, Em // EH).permute(1, 0, 2)
            v = (x @ sa.in_proj_weight[2 * Em:].T + sa.in_proj_bias[2 * Em:]).reshape(-1, EH, Em // EH).permute(1, 0, 2)
            a = (torch.softmax(q @ k.transpose(1, 2) / math.sqrt(Em // EH), dim=-1) @ v).permute(1, 0, 2).reshape(-1, Em)
            x = layer.norm1(x + sa.out_proj(a))
            x = layer.norm2(x + layer.linear2(torch.relu(layer.linear1(x))))
        return enc_norm(x).unsqueeze(1)


layers = list(tr.transformer.decoder.layers)
final_norm = tr.transformer.decoder.norm
H = layers[0].self_attn.num_heads
HD = Em // H
L = len(layers)


def heads(x):
    return x.reshape(-1, H, HD).permute(1, 0, 2)


class Init(nn.Module):
    def forward(self, memory):
        m = memory.reshape(-1, Em)
        ks, vs = [], []
        for layer in layers:
            w, b = layer.multihead_attn.in_proj_weight, layer.multihead_attn.in_proj_bias
            ks.append(heads(m @ w[Em:2 * Em].T + b[Em:2 * Em]))
            vs.append(heads(m @ w[2 * Em:].T + b[2 * Em:]))
        return torch.stack(ks), torch.stack(vs)


def attend(q, k, v):
    return (torch.softmax(q @ k.transpose(1, 2) / math.sqrt(HD), dim=-1) @ v).permute(1, 0, 2).reshape(1, Em)


class Step(nn.Module):
    def forward(self, token, pos, past_k, past_v, cross_k, cross_v):
        x = tr.embed_tgt(token) * math.sqrt(Em) + tr.pos_enc.pe[pos, 0, :]
        nk, nv = [], []
        for i, layer in enumerate(layers):
            sa = layer.self_attn
            q = heads(x @ sa.in_proj_weight[:Em].T + sa.in_proj_bias[:Em])
            k = torch.cat([past_k[i], heads(x @ sa.in_proj_weight[Em:2 * Em].T + sa.in_proj_bias[Em:2 * Em])], dim=1)
            v = torch.cat([past_v[i], heads(x @ sa.in_proj_weight[2 * Em:].T + sa.in_proj_bias[2 * Em:])], dim=1)
            nk.append(k); nv.append(v)
            x = layer.norm1(x + sa.out_proj(attend(q, k, v)))
            ca = layer.multihead_attn
            q = heads(x @ ca.in_proj_weight[:Em].T + ca.in_proj_bias[:Em])
            x = layer.norm2(x + ca.out_proj(attend(q, cross_k[i], cross_v[i])))
            x = layer.norm3(x + layer.linear2(torch.relu(layer.linear1(x))))
        return tr.fc(final_norm(x))[0], torch.stack(nk), torch.stack(nv)


enc, init, step = Encoder().eval(), Init().eval(), Step().eval()
img = torch.randn(1, 3, 32, 256)
with torch.no_grad():
    ref = tr.forward_encoder(model.cnn(img))
    mem = enc(img)
    assert (ref - mem).abs().max() < 1e-4, "encoder wrapper differs from the model"
    ck, cv = init(mem)
    pk = torch.zeros(L, H, 0, HD); pv = pk.clone()
    toks, worst = [1], 0.0
    for t in range(20):
        r = tr.forward_decoder(torch.tensor(toks).unsqueeze(1), mem)[0][0, -1]
        lg, pk, pv = step(torch.tensor([toks[-1]]), torch.tensor([t]), pk, pv, ck, cv)
        worst = max(worst, float((r - lg).abs().max()))
        toks.append(int(r.argmax()) if t % 2 else 5 + t)
assert worst < 1e-3, f"decoder step differs from the model by {worst}"
torch.onnx.export(enc, (img,), str(out / "encoder.onnx"), input_names=["image"], output_names=["memory"],
                  dynamic_axes={"image": {3: "width"}, "memory": {0: "seq"}}, opset_version=17, dynamo=False)
torch.onnx.export(init, (mem,), str(out / "dec_init.onnx"), input_names=["memory"], output_names=["cross_k", "cross_v"],
                  dynamic_axes={"memory": {0: "T"}, "cross_k": {2: "T"}, "cross_v": {2: "T"}}, opset_version=17, dynamo=False)
args = (torch.tensor([7]), torch.tensor([3]), torch.randn(L, H, 3, HD), torch.randn(L, H, 3, HD), ck, cv)
torch.onnx.export(step, args, str(out / "dec_step.onnx"), input_names=["token", "pos", "past_k", "past_v", "cross_k", "cross_v"],
                  output_names=["logits", "new_k", "new_v"],
                  dynamic_axes={"past_k": {2: "P"}, "past_v": {2: "P"}, "cross_k": {2: "T"}, "cross_v": {2: "T"}, "new_k": {2: "P1"}, "new_v": {2: "P1"}},
                  opset_version=17, dynamo=False)
for f in ("encoder.onnx", "dec_init.onnx", "dec_step.onnx"):
    print(f, round((out / f).stat().st_size / 1e6, 1), "MB")
