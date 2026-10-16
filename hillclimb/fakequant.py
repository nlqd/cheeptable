#!/usr/bin/env python3
"""Simulate weight-only quantization.   fakequant.py IN_f16w.onnx OUT.onnx BITS [GROUP]
Every large weight stored as fp16 (+ Cast) in IN is replaced by its quantise-then-dequantise round trip, held in fp32:
symmetric, per output row (axis 0), or per group of GROUP consecutive values within a row when GROUP > 0.
The output model has the same accuracy as a real int-BITS weight store would have; it is NOT smaller. Used to choose BITS/GROUP."""
import sys

import numpy as np
import onnx
from onnx import numpy_helper


def roundtrip(w, bits, group):
    rows = w.shape[0]
    flat = w.reshape(rows, -1)
    if group and flat.shape[1] % group == 0:
        flat = flat.reshape(rows, -1, group)
    qmax = 2 ** (bits - 1) - 1
    scale = np.abs(flat).max(axis=-1, keepdims=True) / qmax
    scale[scale == 0] = 1.0
    q = np.clip(np.round(flat / scale), -qmax, qmax)
    return (q * scale).reshape(w.shape).astype(np.float32)


def main():
    src, dst, bits = sys.argv[1], sys.argv[2], int(sys.argv[3])
    group = int(sys.argv[4]) if len(sys.argv) > 4 else 0
    m = onnx.load(src)
    inits = {i.name: i for i in m.graph.initializer}
    keep, gone = [], set()
    for node in m.graph.node:
        if node.op_type == "Cast" and node.input[0] in inits and node.input[0].endswith("__f16"):
            w = numpy_helper.to_array(inits[node.input[0]]).astype(np.float32)
            m.graph.initializer.append(numpy_helper.from_array(roundtrip(w, bits, group), node.output[0]))
            gone.add(node.input[0])
            continue
        keep.append(node)
    del m.graph.node[:]
    m.graph.node.extend(keep)
    rest = [i for i in m.graph.initializer if i.name not in gone]
    del m.graph.initializer[:]
    m.graph.initializer.extend(rest)
    onnx.save(m, dst)


if __name__ == "__main__":
    main()
