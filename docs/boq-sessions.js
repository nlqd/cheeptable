// boq-sessions.js — opens the recogniser sessions from the compact model files. Used by the page and by the OCR workers.
// The weights come out of boq-wire.js as plain arrays and are handed to ONNX Runtime as the external data of weightless graphs.
'use strict';

const CTSessions = {
  files: (base) => ({ bin: `${base}/model.bin`, enc: `${base}/enc.skel.onnx`, encq: `${base}/encq.skel.onnx`, init: `${base}/init.skel.onnx`, step: `${base}/step.skel.onnx` }),

  async _bytes(url) {
    let resp = await CTStore.get(url);                      // the page filled the store before anything opens a session
    if (!resp) {
      resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    }
    return resp.arrayBuffer();
  },

  // which: any of 'enc' (float32 encoder, for WebGPU), 'encq' (the same with int8 convolutions, for the CPU), 'init', 'step'. Sessions are made one after the other so that the peak memory stays low.
  async open(files, opts, which = ['enc', 'init', 'step']) {
    const [bin, ...graphs] = await Promise.all([files.bin, ...which.map(n => files[n])].map(u => this._bytes(u)));
    const { blobs, ext } = CTWire.unpack(bin, which);
    const out = {};
    for (const [i, name] of which.entries()) {
      out[name] = await ort.InferenceSession.create(graphs[i], { ...opts, externalData: ext[name].map(f => ({ path: `${f}.bin`, data: blobs[f] })) });
    }
    return out;
  },
};
