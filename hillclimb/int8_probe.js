// In the app page (WASM): swap the encoder for an int8 model and compare recognised text on rendered lines.
(async () => { try {
  if (!onnxReady) await initOnnxOCR(() => {});
  const lines = ['Manchon MJ P150 FF', 'Họng ổ khóa bê tông (trọng lượng >50kg)', 'Vận chuyển đất cấp III ra khỏi công trường 4 km tiếp theo bằng xe ôtô tự đổ 7 tấn', 'Khuỷu 1/4 ren trong đồng thau 3/4"x27 (TBC)', '9.500.000'];
  const render = (t) => { const c = document.createElement('canvas'); c.width = 900; c.height = 40; const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 900, 40); x.fillStyle = '#000'; x.font = '19px Times New Roman, serif'; x.fillText(t, 8, 28);
    const w = Math.ceil(x.measureText(t).width) + 16; return { c, box: { x0: 0, y0: 6, x1: w, y1: 38 } }; };
  const run = async () => { const out = []; for (const t of lines) { const { c, box } = render(t); const t0 = performance.now(); const r = await _recognizeBox(c, box); out.push([r.text, Math.round(performance.now() - t0)]); } return out; };
  const fp16 = await run();
  const sess = await ort.InferenceSession.create(window.__encUrl, { executionProviders: ['wasm'] });
  _encSession = sess;
  const int8 = await run();
  return JSON.stringify({ lines, fp16, int8 });
} catch (e) { return 'ERR ' + e + ' ' + (e.stack || '').slice(0, 300); } })()
