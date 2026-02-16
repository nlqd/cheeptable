// boq-viz.js — page viewer: viz navigation, PDF rendering with OCR bbox overlay
'use strict';

// ── Page Viewer ──
let _vizRenderSeq = 0;  // increment on every render; stale renders self-abort

function vizNav(delta) {
  const newPage = vizCurrentPage + delta;
  if (newPage < 1 || newPage > totalPDFPages) return;
  vizCurrentPage = newPage;
  renderVizPage();
}

async function renderVizPage() {
  if (!pdfDoc) return;
  const mySeq = ++_vizRenderSeq;  // claim this render slot
  const canvas = $('vizCanvas');
  const ctx = canvas.getContext('2d');

  // Snapshot the page we intend to render — vizCurrentPage may change while awaiting
  const targetPage = vizCurrentPage;

  // Render the PDF page
  const page = await pdfDoc.getPage(targetPage);
  if (mySeq !== _vizRenderSeq) return;  // superseded by a newer render

  const vp = page.getViewport({ scale: VIZ_SCALE });
  canvas.width = vp.width;
  canvas.height = vp.height;
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  if (mySeq !== _vizRenderSeq) return;  // superseded

  // Update nav label
  $('vizPageLabel').textContent = `Page ${targetPage} of ${totalPDFPages}`;
  $('vizPrev').disabled = targetPage <= 1;
  $('vizNext').disabled = targetPage >= totalPDFPages;

  if (!$('vizShowBoxes').checked) {
    $('vizWordCount').textContent = '';
    return;
  }

  const colorByConf = $('vizColorConf').checked;
  const showText   = $('vizShowText').checked;
  const pageWords  = debugData.ocrWords.filter(w => w.page === targetPage);
  $('vizWordCount').textContent = `(${pageWords.length} words on page ${targetPage})`;

  ctx.font = '8px monospace';
  for (const w of pageWords) {
    const x  = w.x  * VIZ_SCALE;
    const y  = w.y  * VIZ_SCALE;
    const x1 = w.x1 * VIZ_SCALE;
    const y1 = w.y1 * VIZ_SCALE;
    const conf = (w.confidence || 0) / 100; // normalize 0-1

    let stroke;
    if (colorByConf) {
      if (conf >= 0.90) stroke = 'rgba(16,185,129,0.85)';      // green  - high
      else if (conf >= 0.70) stroke = 'rgba(245,158,11,0.85)'; // amber  - medium
      else stroke = 'rgba(239,68,68,0.85)';                    // red    - low
    } else {
      stroke = w.src === 'paddle' ? 'rgba(59,130,246,0.85)' : 'rgba(16,185,129,0.85)';
    }

    // Semi-transparent fill makes boxes visible at a glance
    ctx.fillStyle = stroke.replace('0.85)', '0.25)');
    ctx.fillRect(x, y, x1 - x, y1 - y);

    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, x1 - x, y1 - y);

    if (showText && w.text) {
      ctx.font = '9px monospace';
      ctx.fillStyle = stroke.replace('0.85)', '1)');
      ctx.fillText(w.text, x, Math.max(10, y - 2));
    }
  }
}

function showVizPanel() {
  if (!pdfDoc || !debugData.ocrWords.length) return;
  $('vizPanel').classList.remove('hidden');
  vizCurrentPage = 1;
  renderVizPage();
}

