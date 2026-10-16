// Where does recognition time go in the browser?  Runs in the app page (WASM, local int8 encoder).
(async () => { try {
  if (!onnxReady) await initOnnxOCR(() => {});
  const info = { isolated: crossOriginIsolated, threads: ort.env.wasm.numThreads, cores: navigator.hardwareConcurrency, simd: ort.env.wasm.simd };
  const mk = (t, w) => { const c = document.createElement('canvas'); c.width = w; c.height = 40; const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, w, 40); x.fillStyle = '#000'; x.font = '19px Times New Roman, serif'; x.fillText(t, 8, 28); return c; };
  const texts = ['Khuỷu 1/8 MJ P40 FF', '9.500.000', 'Họng ổ khóa bê tông (trọng lượng >50kg)', 'Vận chuyển đất cấp III ra khỏi công trường 4 km tiếp theo bằng xe ôtô tự đổ 7 tấn'];
  const out = [];
  for (const t of texts) {
    const c = mk(t, 900); const w = Math.ceil(c.getContext('2d').measureText(t).width) + 16;
    const box = { x0: 0, y0: 6, x1: Math.min(w, 890), y1: 38 };
    const tensor = _preprocessVietOCR(c, box.x0, box.y0, box.x1, box.y1);
    let t0 = performance.now();
    const enc = await _encSession.run({ image: tensor });
    const encMs = performance.now() - t0;
    t0 = performance.now();
    const r = await _recognizeBox(c, box);
    const totalMs = performance.now() - t0;
    out.push({ chars: t.length, tokens: r.text.length, width: tensor.dims[3], encMs: Math.round(encMs), totalMs: Math.round(totalMs), decMsPerToken: Math.round((totalMs - encMs) / Math.max(r.text.length, 1)) });
  }
  return JSON.stringify({ info, out });
} catch (e) { return 'ERR ' + e + ' ' + (e.stack || '').slice(0, 300); } })()
