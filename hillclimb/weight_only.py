#!/usr/bin/env python3
"""Store weights as int8 with a per-row scale, compute in fp32.   weight_only.py IN_f16w.onnx OUT.onnx
Every large weight that IN keeps as fp16 (+ Cast) becomes an int8 initializer plus a per-row fp32 scale, with
Cast(int8->fp32) and Mul(scale) in front of its consumers. The runtime folds those constants when the session loads, so the
graph computes exactly like fp32 with int8-rounded weights (see fakequant.py for the accuracy check). About half the file size."""
import sys

import numpy as np
import onnx
from onnx import TensorProto as T, helper, numpy_helper


def main():
    src, dst = sys.argv[1], sys.argv[2]
    m = onnx.load(src)
    inits = {i.name: i for i in m.graph.initializer}
    nodes, gone, added = [], set(), 0
    for node in m.graph.node:
        if node.op_type == "Cast" and node.input[0] in inits and node.input[0].endswith("__f16"):
            w = numpy_helper.to_array(inits[node.input[0]]).astype(np.float32)
            flat = w.reshape(w.shape[0], -1)
            scale = np.abs(flat).max(axis=1) / 127.0
            scale[scale == 0] = 1.0
            q = np.clip(np.round(flat / scale[:, None]), -127, 127).astype(np.int8).reshape(w.shape)
            name = node.output[0]
            m.graph.initializer.append(numpy_helper.from_array(q, name + "__q8"))
            m.graph.initializer.append(numpy_helper.from_array(scale.reshape((-1,) + (1,) * (w.ndim - 1)).astype(np.float32), name + "__s8"))
            nodes.append(helper.make_node("Cast", [name + "__q8"], [name + "__f32"], to=T.FLOAT, name=name + "__cast8"))
            nodes.append(helper.make_node("Mul", [name + "__f32", name + "__s8"], [name], name=name + "__mul8"))
            gone.add(node.input[0])
            added += 1
            continue
        nodes.append(node)
    del m.graph.node[:]
    m.graph.node.extend(nodes)
    rest = [i for i in m.graph.initializer if i.name not in gone]
    del m.graph.initializer[:]
    m.graph.initializer.extend(rest)
    onnx.save(m, dst)
    print("weights stored as int8:", added)


if __name__ == "__main__":
    main()
