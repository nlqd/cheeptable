#!/usr/bin/env python3
"""Keep weights as fp16 on disk (small download) but compute in fp32.  fp16_storage.py IN_fp32.onnx OUT.onnx
Every large float32 initializer becomes an fp16 initializer plus a Cast node; the runtime folds the Cast at load,
so the session is the same fp32 graph as IN. The weights come from an fp16 model, so the cast back is exact."""
import sys

import numpy as np
import onnx
from onnx import TensorProto as T, helper, numpy_helper

m = onnx.load(sys.argv[1])
casts, kept = [], []
for init in m.graph.initializer:
    a = numpy_helper.to_array(init) if init.data_type == T.FLOAT else None
    if a is not None and a.size >= 1024 and np.array_equal(a.astype(np.float16).astype(np.float32), a):
        half = init.name + "__f16"
        kept.append(numpy_helper.from_array(a.astype(np.float16), half))
        casts.append(helper.make_node("Cast", [half], [init.name], to=T.FLOAT, name=init.name + "__cast"))
    else:
        kept.append(init)
del m.graph.initializer[:]
m.graph.initializer.extend(kept)
# traced exports keep weights as Constant nodes instead of initializers
nodes = []
for node in m.graph.node:
    attr = next((a for a in node.attribute if a.name == "value"), None) if node.op_type == "Constant" else None
    if attr is not None and attr.t.data_type == T.FLOAT:
        a = numpy_helper.to_array(attr.t)
        if a.size >= 1024 and np.array_equal(a.astype(np.float16).astype(np.float32), a):
            half = node.output[0] + "__f16"
            m.graph.initializer.append(numpy_helper.from_array(a.astype(np.float16), half))
            casts.append(helper.make_node("Cast", [half], [node.output[0]], to=T.FLOAT, name=half + "__cast"))
            continue
    nodes.append(node)
del m.graph.node[:]
m.graph.node.extend(casts + nodes)
onnx.save(m, sys.argv[2])
print("weights stored as fp16:", len(casts))
