// boq-worker.js — one single-threaded VietOCR recogniser. The page starts several of these and hands them cell crops;
// every crop is independent, so throughput grows with the number of workers and needs no cross-origin isolation.
'use strict';

importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.js', 'boq-decode.js', 'boq-store.js', 'boq-wire.js', 'boq-sessions.js');

let encSession = null, dec = null, vocab = null;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      ort.env.wasm.wasmPaths = data.wasmPaths;
      ort.env.wasm.numThreads = 1;
      const s = await CTSessions.open(data.files, { executionProviders: ['wasm'] }, data.onGpu ? ['init', 'step'] : ['encq', 'init', 'step']);
      encSession = s.encq || null;                          // null: the page encodes on the GPU
      dec = { init: s.init, step: s.step };
      vocab = data.vocab;
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'read') {
      const tensor = new ort.Tensor('float32', data.data, data.dims);
      const { text, confidence, ms } = data.kind === 'memory'
        ? await vietocrDecodeMemory(dec, tensor, vocab)
        : await vietocrDecode(encSession, dec, tensor, vocab);
      self.postMessage({ type: 'result', id: data.id, text, confidence, ms });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: data.id, message: String(e) });
  }
};
