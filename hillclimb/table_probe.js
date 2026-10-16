// Read every page of a PDF with a chosen method and return the boxes and text produced (pixels at OCR_SCALE).
// window.__pdfUrl, window.__method = 'detector' | 'borderless'
(async () => { try {
  if (!onnxReady) await initOnnxOCR(() => {});
  await startOcrPool();
  const pdf = await pdfjsLib.getDocument(window.__pdfUrl).promise;
  const out = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const canvas = await renderPageToCanvas(page, OCR_SCALE);
    let words;
    if (window.__method === 'borderless') {
      words = (await ocrPageBorderless(canvas, p)).words;
    } else {
      words = (await ocrPageWithOnnx(canvas, p)).words;
    }
    out.push(words.map(w => ({ t: w.text, b: [Math.round(w.x * OCR_SCALE), Math.round(w.y * OCR_SCALE), Math.round(w.x1 * OCR_SCALE), Math.round(w.y1 * OCR_SCALE)] })));
    window.__progress = p;
  }
  stopOcrPool();
  return JSON.stringify(out);
} catch (e) { return 'ERR ' + e + ' ' + (e.stack || '').slice(0, 300); } })()
