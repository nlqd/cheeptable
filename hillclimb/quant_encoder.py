#!/usr/bin/env python3
"""Static (QDQ) int8 variants of the VietOCR encoder.  quant_encoder.py ENC_FP32.onnx CALIB.npz OUTDIR
Dynamic quantization is not offered: it emits ConvInteger, which onnxruntime-web (WASM) does not implement.
Variants: all    every calibration crop, min/max ranges
          conv   convolutions only; the transformer layers stay float
          excl   like all, but the first conv (raw pixels) stays float"""
import sys
from pathlib import Path

import numpy as np
from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static
from onnxruntime.quantization.shape_inference import quant_pre_process

src, calib, out = sys.argv[1], sys.argv[2], Path(sys.argv[3])
data = np.load(calib)
samples = [data[k] for k in data.files]


class Reader(CalibrationDataReader):
    def __init__(self):
        self.it = iter(samples)

    def get_next(self):
        x = next(self.it, None)
        return None if x is None else {"image": x.astype(np.float32)}


pre = out / "enc_pre.onnx"
if not pre.exists():
    quant_pre_process(src, str(pre), skip_symbolic_shape=True)
VARIANTS = {
    "all": dict(),
    "conv": dict(op_types_to_quantize=["Conv"]),
    "excl": dict(nodes_to_exclude=["/features/features.0/Conv"]),
}
for name in sys.argv[4:] or VARIANTS:
    dst = out / ("enc_s_%s.onnx" % name)
    quantize_static(str(pre), str(dst), Reader(), quant_format=QuantFormat.QDQ, per_channel=True,
                    weight_type=QuantType.QInt8, activation_type=QuantType.QUInt8, **VARIANTS[name])
    print(dst.name, round(dst.stat().st_size / 1e6, 1), "MB", flush=True)
