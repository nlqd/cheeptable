// Encoder-only timing, single thread WASM: window.__encs = {name: url}
(async () => { try {
  const widths = [110, 220, 500];
  const res = {};
  for (const [name, url] of Object.entries(window.__encs)) {
    const s = await ort.InferenceSession.create(url, { executionProviders: ['wasm'] });
    res[name] = {};
    for (const w of widths) {
      const data = new Float32Array(3 * 32 * w).map((_, i) => 0.5 + 0.4 * Math.sin(i / 7));
      const t = new ort.Tensor('float32', data, [1, 3, 32, w]);
      await s.run({ image: t });                       // warm up
      const t0 = performance.now(); for (let k = 0; k < 4; k++) await s.run({ image: t });
      res[name][w] = Math.round((performance.now() - t0) / 4);
    }
  }
  return JSON.stringify(res);
} catch (e) { return 'ERR ' + e; } })()
