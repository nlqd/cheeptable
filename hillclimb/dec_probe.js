// Time the same four lines with different decoder models (WASM): window.__decs = {name: url}
(async () => { try {
  if (!onnxReady) await initOnnxOCR(() => {});
  const texts = ['Khuỷu 1/8 MJ P40 FF', '9.500.000', 'Họng ổ khóa bê tông (trọng lượng >50kg)', 'Vận chuyển đất cấp III ra khỏi công trường 4 km tiếp theo bằng xe ôtô tự đổ 7 tấn'];
  const mk = (t) => { const c = document.createElement('canvas'); c.width = 900; c.height = 40; const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 900, 40); x.fillStyle = '#000'; x.font = '19px Times New Roman, serif'; x.fillText(t, 8, 28);
    return { c, box: { x0: 0, y0: 6, x1: Math.min(Math.ceil(x.measureText(t).width) + 16, 890), y1: 38 } }; };
  const run = async () => { const o = []; for (const t of texts) { const { c, box } = mk(t); const t0 = performance.now(); const r = await _recognizeBox(c, box); o.push([r.text, Math.round(performance.now() - t0)]); } return o; };
  const res = { fp16: await run() };
  for (const [name, url] of Object.entries(window.__decs)) {
    _decSession = await ort.InferenceSession.create(url, { executionProviders: ['wasm'] });
    res[name] = await run();
  }
  return JSON.stringify(res);
} catch (e) { return 'ERR ' + e + ' ' + (e.stack || '').slice(0, 300); } })()
