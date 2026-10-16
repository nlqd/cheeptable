// Time each phase of one page on the page thread (GPU encoder, decode workers).
(async () => { try {
  window.__log = []; const lap = (() => { let t = performance.now(); return () => { const n = performance.now(); const d = Math.round(n - t); t = n; window.__log.push(d); return d; }; })();
  if (!onnxReady) await initOnnxOCR(() => {});
  await startOcrPool();
  const out = { init: lap() };
  const pdf = await pdfjsLib.getDocument('/7.%20Bi%E1%BB%83u%20gi%C3%A1%20H%C4%90.pdf').promise;
  const page = await pdf.getPage(3);
  lap();
  const canvas = await renderPageToCanvas(page, OCR_SCALE); out.render = lap();
  const grid = await findGrid(canvas); out.findGrid = lap();
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const cells = gridCells(grid.xs, grid.ys, grid.f); out.cells = cells.length;
  const items = [];
  for (const c of cells) for (const box of _cellLineBoxes(ctx, c, grid.f)) items.push(box);
  out.bandBoxes = lap(); out.reads = items.length;
  const tensors = items.map(b => _preprocessVietOCR(canvas, b.x0, b.y0, b.x1, b.y1)); out.preprocess = lap();
  const mem = [];
  for (const t of tensors) mem.push(await _gpuEncode(t)); out.gpuEncode = lap();
  const res = await Promise.all(mem.map(m => _pool.decodeMemory(new Float32Array(m.data), [...m.dims]))); out.decode = lap();
  stopOcrPool();
  const border = await detectTableBorders(canvas); out.legacyBorders = lap();
  return JSON.stringify(out);
} catch (e) { return 'ERR ' + e + ' ' + (e.stack || '').slice(0, 300); } })()
