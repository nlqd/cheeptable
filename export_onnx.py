#!/usr/bin/env python3
"""
Export VietOCR vgg_transformer to ONNX as two models:
  1. encoder.onnx  — VGG19-BN backbone + Transformer encoder
  2. decoder.onnx  — Single-step Transformer decoder

This split allows autoregressive decoding to be driven from JS in the browser.
"""

import os
import math
import torch
import torch.nn as nn
import numpy as np

from vietocr.tool.config import Cfg
from vietocr.tool.predictor import Predictor

OUT_DIR = "browser_ocr/models/vietocr"
os.makedirs(OUT_DIR, exist_ok=True)


# ── Load the model ──────────────────────────────────────────────────────────

cfg = Cfg.load_config_from_name('vgg_transformer')
cfg['cnn']['pretrained'] = False
cfg['device'] = 'cpu'
cfg['predictor']['beamsearch'] = False

predictor = Predictor(cfg)
model = predictor.model
model.eval()

vocab = cfg['vocab']
print(f"Vocab: {len(vocab)} chars + 4 special = {len(vocab)+4} total")


# ── Wrapper: Encoder (CNN + Transformer Encoder) ───────────────────────────

class VietOCREncoder(nn.Module):
    """VGG19-BN features → 1x1 conv → reshape → positional encoding → transformer encoder."""

    def __init__(self, cnn, transformer):
        super().__init__()
        # Copy CNN submodules (we'll re-implement forward to avoid negative indices)
        # CNN wraps a Vgg object in .model
        self.features = cnn.model.features
        self.dropout = cnn.model.dropout
        self.last_conv_1x1 = cnn.model.last_conv_1x1
        # Extract encoder components from the transformer
        self.d_model = transformer.d_model
        self.pos_enc = transformer.pos_enc
        self.encoder = transformer.transformer.encoder

    def forward(self, img):
        # CNN forward with explicit (positive) transpose indices for ONNX compat
        # img: (N, 3, 32, W)
        conv = self.features(img)      # (N, 512, H', W')
        conv = self.dropout(conv)
        conv = self.last_conv_1x1(conv) # (N, 256, H', W')
        conv = conv.transpose(2, 3)     # (N, 256, W', H')  — was transpose(-1,-2)
        conv = conv.flatten(2)          # (N, 256, W'*H')
        conv = conv.permute(2, 0, 1)   # (W'*H', N, 256)   — was permute(-1,0,1)

        # Positional encoding + encoder
        src = self.pos_enc(conv * math.sqrt(self.d_model))
        memory = self.encoder(src)
        return memory


# ── Wrapper: Decoder (single step, returns logits for last position) ───────

class VietOCRDecoder(nn.Module):
    """Single-step decoder: takes all tokens so far + encoder memory → logits."""

    def __init__(self, transformer):
        super().__init__()
        self.d_model = transformer.d_model
        self.embed_tgt = transformer.embed_tgt
        self.pos_enc = transformer.pos_enc
        self.decoder = transformer.transformer.decoder
        self.fc = transformer.fc

    def forward(self, tgt, memory):
        """
        Args:
            tgt:    (T, N) int64 — token indices for all positions so far
            memory: (S, N, 256) — encoder output
        Returns:
            logits: (N, vocab_size) — logits for the LAST position only
        """
        T = tgt.shape[0]
        # Causal mask
        tgt_mask = torch.triu(torch.full((T, T), float('-inf')), diagonal=1)

        # Embed + pos encode
        tgt_emb = self.pos_enc(self.embed_tgt(tgt) * math.sqrt(self.d_model))

        # Decoder
        output = self.decoder(tgt_emb, memory, tgt_mask=tgt_mask)

        # Only return last position logits: (N, vocab_size)
        output = output[-1]  # (N, 256)
        logits = self.fc(output)  # (N, vocab_size)
        return logits


# ── Build wrapper models ───────────────────────────────────────────────────

encoder = VietOCREncoder(model.cnn, model.transformer)
decoder = VietOCRDecoder(model.transformer)
encoder.eval()
decoder.eval()


# ── Export Encoder ─────────────────────────────────────────────────────────

print("\n=== Exporting encoder.onnx ===")
# Dummy input: batch=1, channels=3, height=32, width=256
dummy_img = torch.randn(1, 3, 32, 256)

with torch.no_grad():
    memory_test = encoder(dummy_img)
    print(f"  Encoder output shape: {memory_test.shape}")  # (seq_len, 1, 256)

torch.onnx.export(
    encoder,
    dummy_img,
    os.path.join(OUT_DIR, "encoder.onnx"),
    input_names=["image"],
    output_names=["memory"],
    dynamic_axes={
        "image": {0: "batch", 3: "width"},
        "memory": {0: "seq_len", 1: "batch"},
    },
    opset_version=17,
    do_constant_folding=True,
    dynamo=False,
)
enc_size = os.path.getsize(os.path.join(OUT_DIR, "encoder.onnx")) / 1024 / 1024
print(f"  encoder.onnx: {enc_size:.1f} MB")


# ── Export Decoder ─────────────────────────────────────────────────────────

print("\n=== Exporting decoder.onnx ===")
# Dummy inputs: 5 tokens decoded so far, encoder memory from above
dummy_tgt = torch.tensor([[1], [42], [10], [5], [88]], dtype=torch.long)  # (T=5, N=1)
dummy_memory = memory_test.detach()  # (seq_len, 1, 256)

with torch.no_grad():
    logits_test = decoder(dummy_tgt, dummy_memory)
    print(f"  Decoder output shape: {logits_test.shape}")  # (1, vocab_size)

torch.onnx.export(
    decoder,
    (dummy_tgt, dummy_memory),
    os.path.join(OUT_DIR, "decoder.onnx"),
    input_names=["tokens", "memory"],
    output_names=["logits"],
    dynamic_axes={
        "tokens": {0: "seq_len_tgt", 1: "batch"},
        "memory": {0: "seq_len_src", 1: "batch"},
        "logits": {0: "batch"},
    },
    opset_version=17,
    do_constant_folding=True,
    dynamo=False,
)
dec_size = os.path.getsize(os.path.join(OUT_DIR, "decoder.onnx")) / 1024 / 1024
print(f"  decoder.onnx: {dec_size:.1f} MB")


# ── Save vocab mapping ────────────────────────────────────────────────────

vocab_path = os.path.join(OUT_DIR, "vocab.txt")
with open(vocab_path, "w", encoding="utf-8") as f:
    # Special tokens first (indices 0-3)
    f.write("<pad>\n<sos>\n<eos>\n<mask>\n")
    for ch in vocab:
        f.write(ch + "\n")
print(f"\n  vocab.txt: {len(vocab)+4} entries")


# ── Validate with ONNX Runtime ────────────────────────────────────────────

print("\n=== Validating with ONNX Runtime ===")
import onnxruntime as ort

# Test encoder
enc_sess = ort.InferenceSession(os.path.join(OUT_DIR, "encoder.onnx"))
enc_out = enc_sess.run(None, {"image": dummy_img.numpy()})
memory_ort = enc_out[0]
print(f"  ORT encoder output: {memory_ort.shape}, dtype={memory_ort.dtype}")

# Compare with PyTorch
diff_enc = np.abs(memory_test.numpy() - memory_ort).max()
print(f"  Encoder max diff: {diff_enc:.6f}")

# Test decoder
dec_sess = ort.InferenceSession(os.path.join(OUT_DIR, "decoder.onnx"))
dec_out = dec_sess.run(None, {
    "tokens": dummy_tgt.numpy(),
    "memory": memory_ort,
})
logits_ort = dec_out[0]
print(f"  ORT decoder output: {logits_ort.shape}, dtype={logits_ort.dtype}")

diff_dec = np.abs(logits_test.numpy() - logits_ort).max()
print(f"  Decoder max diff: {diff_dec:.6f}")


# ── End-to-end test: greedy decode on a real-ish image ────────────────────

print("\n=== End-to-end greedy decode test ===")
# Load vocab for decoding
idx2char = ['<pad>', '<sos>', '<eos>', '<mask>'] + list(vocab)

SOS = 1
EOS = 2

# NOTE: The encoder was traced with width=256, so we must use the same width.
# For browser deployment, crops should be resized/padded to match the export width.
# We can export multiple encoder variants for common widths if needed.
test_img = torch.randn(1, 3, 32, 256).numpy()
memory = enc_sess.run(None, {"image": test_img})[0]

# Greedy decode
tokens = [[SOS]]
max_len = 20
for step in range(max_len):
    tgt = np.array(tokens, dtype=np.int64)  # (T, 1)
    logits = dec_sess.run(None, {"tokens": tgt, "memory": memory})[0]  # (1, vocab)
    next_token = int(np.argmax(logits[0]))
    if next_token == EOS:
        break
    tokens.append([next_token])

decoded = ''.join(idx2char[t[0]] for t in tokens[1:])  # skip SOS
print(f"  Decoded from noise: '{decoded}' ({len(tokens)-1} tokens)")

print("\n=== DONE ===")
total_mb = enc_size + dec_size
print(f"Total ONNX size: {total_mb:.1f} MB (float32)")
print(f"Estimated int8: {total_mb/4:.1f} MB")
print(f"Estimated float16: {total_mb/2:.1f} MB")
print(f"Files in {OUT_DIR}/")
