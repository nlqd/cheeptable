// boq-grid.js — ruled-table OCR path: find the drawn grid, cut every cell into text lines, read each line.
// No text detector is involved, so no line can be missed and none is merged with its neighbour.
// On the 11-page contract this read 470 of 473 rows (detector path: about half of the descriptions dropped).
// Pages without a recognisable grid return null and keep using the detector path in boq-onnx.js.
'use strict';

// Thresholds were tuned on pages rendered 1191 px wide (A4 at 144 dpi); everything pixel-sized scales with width.
const GRID_REF_WIDTH = 1191;
const GRID_INK = 170;          // luminance below this is ink
const GRID_BAND_MIN_H = 6;     // shorter ink runs are specks, not text lines
const GRID_BAND_GAP = 3;       // blank rows that separate two text lines in one cell

// ── Pure helpers (unit-tested in test-grid.mjs) ──

// Merge sorted positions closer than `gap` into their mean: a ruled line is several pixels thick.
function gridClusters(vals, gap) {
  const sorted = [...vals].sort((a, b) => a - b);
  if (!sorted.length) return [];
  const out = [];
  let cur = [sorted[0]];
  for (const v of sorted.slice(1)) {
    if (v - cur[cur.length - 1] <= gap) {
      cur.push(v);
    } else {
      out.push(Math.round(cur.reduce((a, b) => a + b, 0) / cur.length));
      cur = [v];
    }
  }
  out.push(Math.round(cur.reduce((a, b) => a + b, 0) / cur.length));
  return out;
}

// Split a cell into text lines. rowInk[y] is true when row y holds ink. Returns [start, end) pairs.
function gridTextBands(rowInk, minGap, minH) {
  const bands = [];
  let start = null, last = 0, gap = 0;
  for (let y = 0; y < rowInk.length; y++) {
    if (rowInk[y]) {
      if (start === null) start = y;
      last = y;
      gap = 0;
    } else if (start !== null && ++gap >= minGap) {
      bands.push([start, last + 1]);
      start = null;
      gap = 0;
    }
  }
  if (start !== null) bands.push([start, last + 1]);
  return bands.filter(([a, b]) => b - a >= minH);
}

// Column lines from the per-column vertical-line mass (pixels of vertical ruling in each x). A real table line is
// about as strong as the strongest one; letter strokes are weak. The page-edge shadow is ignored when setting the
// scale. (A fixed pixel threshold gave 14 "columns" on a short table.)
function gridPickColumns(mass, f, rel = 0.4) {
  const w = mass.length;
  const lo = Math.floor(0.05 * w), hi = Math.floor(0.96 * w);
  let peak = 0;
  for (let x = lo; x < hi; x++) peak = Math.max(peak, mass[x]);
  const hits = [];
  for (let x = lo; x < hi; x++) if (mass[x] > Math.max(255 * 25 * f, rel * peak)) hits.push(x);
  return gridClusters(hits, 10 * f);
}

// A ruled-line fragment left in a cell: ink that spans the whole cell height but is narrow. Real text never fills it.
const gridIsRuleFragment = (bandH, cellH, inkW) => bandH >= 0.9 * cellH && inkW < 0.5 * bandH;

// Cell rectangles between consecutive ruled lines, inset so the lines themselves stay out of the crop.
function gridCells(xs, ys, f) {
  const inL = Math.round(3 * f), inR = Math.round(2 * f);
  const cells = [];
  for (let r = 0; r < ys.length - 1; r++) {
    const y0 = ys[r] + inL, y1 = ys[r + 1] - inR;
    if (y1 - y0 < 12 * f) continue;
    for (let c = 0; c < xs.length - 1; c++) {
      const x0 = xs[c] + inL, x1 = xs[c + 1] - inR;
      if (x1 - x0 < 8 * f) continue;
      cells.push({ row: r, col: c, x: x0, y: y0, width: x1 - x0, height: y1 - y0, area: (x1 - x0) * (y1 - y0) });
    }
  }
  return cells;
}

// ── OpenCV: ruled lines -> grid ──

async function findGrid(canvas) {
  if (!opencvReady || typeof cv === 'undefined') return null;
  const f = canvas.width / GRID_REF_WIDTH;
  const w = canvas.width, h = canvas.height;
  const mats = [];
  const keep = (m) => { mats.push(m); return m; };
  try {
    const gray = keep(new cv.Mat());
    cv.cvtColor(keep(cv.imread(canvas)), gray, cv.COLOR_RGBA2GRAY);
    const bw = keep(new cv.Mat());
    const block = Math.round(25 * f) | 1;
    cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, block, 10);
    await yieldToMain();

    const hor = keep(new cv.Mat()), ver = keep(new cv.Mat());
    cv.morphologyEx(bw, hor, cv.MORPH_OPEN, keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.floor(w / 8), 1))));
    cv.morphologyEx(bw, ver, cv.MORPH_OPEN, keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, Math.round(30 * f)))));
    const rowSum = keep(new cv.Mat()), colSum = keep(new cv.Mat());
    cv.reduce(hor, rowSum, 1, cv.REDUCE_SUM, cv.CV_32S);
    cv.reduce(ver, colSum, 0, cv.REDUCE_SUM, cv.CV_32S);

    const yHits = [];
    for (let y = 0; y < h; y++) if (rowSum.data32S[y] > 255 * w * 0.25) yHits.push(y);
    const ys = gridClusters(yHits, 4 * f);
    const xs = gridPickColumns(Array.from(colSum.data32S.subarray(0, w)), f);
    return xs.length >= 3 && ys.length >= 3 ? { xs, ys, f } : null;
  } finally {
    mats.forEach(m => m.delete());
  }
}

// ── Reading the grid ──

// Text lines inside one cell, as canvas-space boxes hugging the ink horizontally.
function _cellLineBoxes(ctx, cell, f) {
  const { x, y, width, height } = cell;
  const px = ctx.getImageData(x, y, width, height).data;
  const dark = (i) => (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) < GRID_INK;
  const rowInk = new Array(height).fill(false);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (dark((r * width + c) * 4)) { rowInk[r] = true; break; }
    }
  }
  const margin = Math.round(3 * f);
  return gridTextBands(rowInk, Math.max(2, Math.round(GRID_BAND_GAP * f)), Math.round(GRID_BAND_MIN_H * f)).map(([a, b]) => {
    let left = width, right = -1;
    for (let r = a; r < b; r++) {
      for (let c = 0; c < width; c++) {
        if (dark((r * width + c) * 4)) { left = Math.min(left, c); right = Math.max(right, c); }
      }
    }
    if (gridIsRuleFragment(b - a, height, right - left + 1)) return null;
    return { x0: x + Math.max(0, left - margin), x1: x + Math.min(width, right + 1 + margin), y0: y + a, y1: y + b };
  }).filter(Boolean);
}

// Same return shape as ocrPageWithOnnx, plus the grid cells for the table builder.
async function ocrPageWithGrid(canvas, pageNum, grid) {
  if (!onnxReady) throw new Error('ONNX models not loaded');
  perfStart(`Grid OCR page ${pageNum}`);
  const s = OCR_SCALE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const cells = gridCells(grid.xs, grid.ys, grid.f);
  const words = [];

  for (let i = 0; i < cells.length; i++) {
    for (const box of _cellLineBoxes(ctx, cells[i], grid.f)) {
      if (box.x1 - box.x0 < 5 || box.y1 - box.y0 < 5) continue;
      const { text: rawText, confidence } = await _recognizeBox(canvas, box);
      const text = _postProcess(rawText).trim();
      if (!text) continue;
      words.push({
        text,
        x: box.x0 / s, y: box.y0 / s, x1: box.x1 / s, y1: box.y1 / s,
        width: (box.x1 - box.x0) / s, height: (box.y1 - box.y0) / s,
        confidence: confidence * 100,
        src: _NUMERIC_RE.test(text) ? 'onnx-num' : 'onnx-viet',
        page: pageNum,
        cell: { row: cells[i].row, col: cells[i].col },
      });
    }
    if (i % 5 === 0) await yieldToMain();
  }

  perfEnd(`Grid OCR page ${pageNum}`);
  console.log(`[Grid] Page ${pageNum}: ${cells.length} cells, ${words.length} text lines recognized`);
  return { words, lines: [], cells };
}

if (typeof module !== 'undefined') module.exports = { gridClusters, gridTextBands, gridCells, gridPickColumns, gridIsRuleFragment };
