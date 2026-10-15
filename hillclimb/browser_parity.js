(async () => {
  if (!onnxReady) { const ok = await initOnnxOCR(m => {}); if (!ok) return JSON.stringify({error: 'init failed'}); }
  const meta = await (await fetch('/hillclimb/cells_sample/meta.json')).json();
  const out = [];
  for (const m of meta) {
    const img = new Image(); img.src = '/hillclimb/cells_sample/' + m.file; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    const t = performance.now();
    const r = await _recognizeBox(c, {x0: 0, y0: 0, x1: img.width, y1: img.height});
    out.push({stt: m.stt, text: _postProcess(r.text), conf: r.confidence, ms: Math.round(performance.now() - t)});
    window._parity = out;
  }
  window._parityDone = true;
  return 'done';
})()
