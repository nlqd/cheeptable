// Detection-only probe: for each unit-column box, is there a description box on the same line?
// Run in the app page after initOnnxOCR; prints JSON per config.
(async () => { try {
  const S = OCR_SCALE;
  if (!window.__pdf) window.__pdf = await pdfjsLib.getDocument('/7.%20Bi%E1%BB%83u%20gi%C3%A1%20H%C4%90.pdf').promise;
  if (!onnxReady) await initOnnxOCR(() => {});
  const cfgs = window.__cfgs;
  const out = [];
  for (const cfg of cfgs) {
    Object.assign(window, {});
    DET_MAX_SIDE = cfg.side; DB_THRESH = cfg.th; DB_BOX_THRESH = cfg.box; DB_UNCLIP_RATIO = cfg.unclip;
    let units = 0, matched = 0, total = 0;
    for (const p of [3, 4]) {
      const page = await window.__pdf.getPage(p);
      const canvas = await renderPageToCanvas(page, S);
      const boxes = await _detectTextBoxes(canvas);
      total += boxes.length;
      const U = boxes.filter(b => b.x0 / S > 335 && b.x1 / S < 400 && (b.y1 - b.y0) < 60);
      const D = boxes.filter(b => b.x0 / S > 70 && b.x0 / S < 330);
      for (const u of U) {
        units++;
        const uc = (u.y0 + u.y1) / 2;
        if (D.some(d => d.y0 - 12 <= uc && uc <= d.y1 + 12)) matched++;
      }
    }
    out.push({ ...cfg, boxes: total, units, matched });
  }
  return JSON.stringify(out);
} catch (e) { return 'ERR ' + e + ' ' + (e.stack||'').slice(0,300); } })()
