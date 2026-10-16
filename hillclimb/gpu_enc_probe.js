// Encoder on WebGPU (fp16 storage, fp32 compute) versus the int8 encoder on WASM: speed and agreement.
(async () => { try {
  const adapter = await navigator.gpu.requestAdapter();
  const info = { adapter: !!adapter, f16: adapter ? adapter.features.has('shader-f16') : null };
  if (!adapter) return JSON.stringify(info);
  const gpu = await ort.InferenceSession.create(window.__gpuEnc, { executionProviders: ['webgpu'] });
  const cpu = await ort.InferenceSession.create(window.__cpuEnc, { executionProviders: ['wasm'] });
  const res = { info };
  for (const w of [110, 220, 500]) {
    const data = new Float32Array(3 * 32 * w).map((_, i) => 0.5 + 0.4 * Math.sin(i / 7) * Math.cos(i / 131));
    const t = new ort.Tensor('float32', data, [1, 3, 32, w]);
    const a = (await gpu.run({ image: t })).memory;                 // warm up + compile shaders
    const t0 = performance.now(); for (let k = 0; k < 5; k++) await gpu.run({ image: t });
    const gpuMs = (performance.now() - t0) / 5;
    const b = (await cpu.run({ image: t })).memory;
    const av = await a.getData(), bv = b.data;
    let worst = 0, scale = 0;
    for (let i = 0; i < av.length; i++) { worst = Math.max(worst, Math.abs(av[i] - bv[i])); scale = Math.max(scale, Math.abs(bv[i])); }
    res[w] = { gpuMs: Math.round(gpuMs * 10) / 10, maxDiff: +worst.toFixed(3), maxAbs: +scale.toFixed(2), dims: a.dims };
  }
  return JSON.stringify(res);
} catch (e) { return 'ERR ' + e + ' ' + (e.stack || '').slice(0, 300); } })()
