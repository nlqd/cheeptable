"""Swap VietOCR's CNN + transformer encoder for an ONNX Runtime session, keeping the torch decode loop.

install(path)            use that encoder model
install(None, capture)   keep torch, but append every encoder input (numpy, 1x3x32xW) to the list `capture`
"""
import numpy as np
import onnxruntime as ort
import torch

import recog


class _Pass(torch.nn.Module):
    def forward(self, x):
        return x


def install(path, capture=None):
    model = recog.predictor().model
    if path is None:
        orig_cnn, orig_enc = model.cnn, model.transformer.forward_encoder

        class Tap(torch.nn.Module):
            def forward(self, x):
                capture.append(x.numpy().copy())
                return orig_cnn(x)

        model.cnn = Tap()
        return
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    model.cnn = _Pass()
    model.transformer.forward_encoder = lambda x: torch.from_numpy(sess.run(None, {"image": x.numpy()})[0])
