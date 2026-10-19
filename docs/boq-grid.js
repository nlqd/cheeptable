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

// Runs of ink separated by blank stretches of at least `gap` columns: a heading with the company on the left and the motto on the
// right is two texts, not one line.
function gridInkRuns(colInk, gap) {
  const runs = [];
  let start = -1, last = -1;
  for (let c = 0; c < colInk.length; c++) {
    if (colInk[c] < 1) continue;
    if (start >= 0 && c - last > gap) { runs.push([start, last]); start = -1; }
    if (start < 0) start = c;
    last = c;
  }
  if (start >= 0) runs.push([start, last]);
  return runs;
}

// Paper texture leaves single dark pixels; a stroke of a letter always touches another dark pixel. Returns a copy without the lone ones.
function gridDespeckle(ink, width, height) {
  const out = new Uint8Array(ink.length);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (!ink[r * width + c]) continue;
      let near = 0;
      for (let dr = -1; dr <= 1 && !near; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if ((dr || dc) && rr >= 0 && rr < height && cc >= 0 && cc < width && ink[rr * width + cc]) { near = 1; break; }
        }
      }
      out[r * width + c] = near;
    }
  }
  return out;
}

// The recogniser squeezes a line wider than 16 times its height; a long heading line is cut at the widest blank stretch near its middle
// until every piece fits. Only a blank stretch of `minGap` columns counts (a word gap, not the space between two letters).
// `colInk` is the ink per column; `run` is [left, right].
function gridSplitWide(colInk, run, maxW, minGap = 1) {
  const [left, right] = run;
  if (right - left + 1 <= maxW) return [run];
  const mid = (left + right) / 2;
  let best = null;
  for (let c = left; c <= right;) {
    if (colInk[c] > 0) { c++; continue; }
    let e = c;
    while (e <= right && colInk[e] === 0) e++;
    const centre = (c + e - 1) / 2;
    if (c > left && e <= right && e - c >= minGap && (!best || Math.abs(centre - mid) < Math.abs(best[2] - mid))) best = [c, e - 1, centre];
    c = e;
  }
  if (!best) return [run];
  return [...gridSplitWide(colInk, [left, best[0] - 1], maxW, minGap), ...gridSplitWide(colInk, [best[1] + 1, right], maxW, minGap)];
}

// A horizontal ruled line belongs to the table when vertical rules cross it (a joint). A page-edge shadow or an underline crosses none, so
// it is not a row boundary: otherwise the whole heading above the table becomes one tall row, cut at the table's column lines.
// `ver` is the vertical-rule mask (w x h, nonzero = rule); a joint is a rule within `reach` pixels of a column line at the height of the line.
function gridJointCount(ver, w, h, xs, y, reach) {
  let n = 0;
  for (const x of xs) {
    let hit = false;
    for (let yy = Math.max(0, y - reach); yy <= Math.min(h - 1, y + reach) && !hit; yy++) {
      for (let xx = Math.max(0, x - reach); xx <= Math.min(w - 1, x + reach); xx++) if (ver[yy * w + xx]) { hit = true; break; }
    }
    n += hit;
  }
  return n;
}

// Lines set tightly (justified text, accents touching the line above) leave no blank row between them and come out as one tall band.
// A band much taller than a line is cut at the row with the least ink near each expected line boundary. `lineH` is a typical line
// height on the page; `counts` is the ink per row of the cell.
// Share of the words that sit in grid rows holding several table rows each (the median cell of the row has three or more lines). A grid
// like that is one whose horizontal rules were mostly missed, and its rows cannot be trusted (see gridCellsToWordGrid in boq-extract.js).
function gridUnderSegmented(words) {
  const rows = new Map();
  for (const w of words) {
    const cols = rows.get(w.cell.row) || new Map();
    cols.set(w.cell.col, (cols.get(w.cell.col) || 0) + 1);
    rows.set(w.cell.row, cols);
  }
  let crowded = 0;
  for (const cols of rows.values()) {
    if (cols.size >= 3 && [...cols.values()].sort((a, b) => a - b)[Math.floor(cols.size / 2)] >= 3) crowded += [...cols.values()].reduce((s, n) => s + n, 0);
  }
  return words.length ? crowded / words.length : 0;
}

function gridSplitTall(bands, counts, lineH, ratio = 1.7, window = 0.3) {
  const out = [];
  for (const [a, b] of bands) {
    const h = b - a;
    if (!(lineH > 0) || h < ratio * lineH) { out.push([a, b]); continue; }
    const n = Math.max(2, Math.round(h / lineH));
    let from = a;
    const cuts = [];
    for (let k = 1; k < n; k++) {
      const target = a + k * h / n;
      let best = -1;
      for (let r = Math.max(a + 2, Math.floor(target - window * lineH)); r <= Math.min(b - 2, Math.ceil(target + window * lineH)); r++) {
        if (best < 0 || counts[r] < counts[best] || (counts[r] === counts[best] && Math.abs(r - target) < Math.abs(best - target))) best = r;
      }
      if (best >= 0) cuts.push(best);
    }
    for (const c of [...cuts, b]) { if (c - from >= 3) out.push([from, c]); from = c; }
  }
  return out;
}

// Column lines from the per-column vertical-line mass (pixels of vertical ruling in each x). A real table line is
// about as strong as the strongest one; letter strokes are weak. The page-edge shadow is ignored when setting the
// scale: it lies within the outer 2% of the page, so a table whose last rule sits at 97% (page 11 of the contract) keeps its last column.
// (A fixed pixel threshold gave 14 "columns" on a short table.)
function gridPickColumns(mass, f, rel = 0.4) {
  const w = mass.length;
  const lo = Math.floor(0.02 * w), hi = Math.floor(0.985 * w);
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

// Line detection runs on a copy no wider than GRID_REF_WIDTH (the size it was tuned on): the work falls with the pixel count and the
// ruled lines are still several pixels thick there. Positions are scaled back to the full-size canvas.
async function findGrid(canvas) {
  if (!opencvReady || typeof cv === 'undefined') return null;
  const full = canvas.width / GRID_REF_WIDTH;
  let src = canvas, k = 1;
  if (canvas.width > GRID_REF_WIDTH) {
    k = GRID_REF_WIDTH / canvas.width;
    src = document.createElement('canvas');
    src.width = GRID_REF_WIDTH; src.height = Math.round(canvas.height * k);
    src.getContext('2d').drawImage(canvas, 0, 0, src.width, src.height);
  }
  const f = src.width / GRID_REF_WIDTH;
  const w = src.width, h = src.height;
  const mats = [];
  const keep = (m) => { mats.push(m); return m; };
  try {
    const gray = keep(new cv.Mat());
    cv.cvtColor(keep(cv.imread(src)), gray, cv.COLOR_RGBA2GRAY);
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
    const xsSrc = gridPickColumns(Array.from(colSum.data32S.subarray(0, w)), f);
    const reach = Math.max(2, Math.round(3 * f));
    const ys = gridClusters(yHits, 4 * f).filter(y => gridJointCount(ver.data, w, h, xsSrc, y, reach) >= 2).map(y => Math.round(y / k));
    const xs = xsSrc.map(x => Math.round(x / k));
    // a few boxes on a page of text are not a table: the extractor wants at least 20 cells, so a smaller grid is not used
    return xs.length >= 3 && ys.length >= 3 && (xs.length - 1) * (ys.length - 1) >= 20 ? { xs, ys, f: full } : null;
  } finally {
    mats.forEach(m => m.delete());
  }
}

// ── Reading the grid ──

// Text lines inside one cell, as canvas-space boxes hugging the ink horizontally.
// Ink per pixel row of a cell, and the bands of rows that are text lines.
function _cellBands(ctx, cell, f) {
  const { x, y, width, height } = cell;
  const px = ctx.getImageData(x, y, width, height).data;
  const raw = new Uint8Array(width * height);
  for (let i = 0; i < raw.length; i++) raw[i] = (px[4 * i] * 0.299 + px[4 * i + 1] * 0.587 + px[4 * i + 2] * 0.114) < GRID_INK ? 1 : 0;
  const ink = gridDespeckle(raw, width, height);
  const dark = (i) => ink[i >> 2] === 1;
  const counts = new Array(height).fill(0);
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) if (ink[r * width + c]) counts[r]++;
  const bands = gridTextBands(counts.map(n => n > 0), Math.max(2, Math.round(GRID_BAND_GAP * f)), Math.round(GRID_BAND_MIN_H * f));
  return { px, dark, counts, bands };
}

function _cellLineBoxes(ctx, cell, f, lineH, scanned, splitGaps = false) {
  const { x, y, width } = cell;
  const { dark, counts, bands } = scanned || _cellBands(ctx, cell, f);
  const margin = Math.round(3 * f);
  const colInk = (a, b) => {
    const ink = new Array(width).fill(0);
    for (let r = a; r < b; r++) for (let c = 0; c < width; c++) if (dark((r * width + c) * 4)) ink[c]++;
    return ink;
  };
  const extent = (a, b) => {
    let left = width, right = -1;
    colInk(a, b).forEach((n, c) => { if (n) { left = Math.min(left, c); right = c; } });
    return [left, right];
  };
  // Only a band wider than it is tall can be several lines of text: a tall narrow band is sideways text and stays whole.
  const pieces = bands.flatMap(([a, b]) => { const [l, r] = extent(a, b); return r - l + 1 >= 1.5 * (b - a) ? gridSplitTall([[a, b]], counts, lineH) : [[a, b]]; });
  return pieces.flatMap(([a, b]) => {
    const ink = splitGaps ? colInk(a, b) : null;
    const spans = splitGaps ? gridInkRuns(ink, Math.round(2.5 * (b - a))).flatMap(run => gridSplitWide(ink, run, 16 * (b - a), Math.round(0.25 * (b - a)))) : [extent(a, b)];
    return spans.map(([left, right], i) => {
      if (gridIsRuleFragment(b - a, cell.height, right - left + 1)) return null;
      if (splitGaps && right - left + 1 < 0.6 * (b - a)) return null;          // a fold mark or a hole at the edge of the page, not a word
      // beside a neighbouring piece the margin stops halfway across the gap, so a letter is not read twice
      const lm = i > 0 ? Math.min(margin, (left - spans[i - 1][1] - 1) >> 1) : margin;
      const rm = i < spans.length - 1 ? Math.min(margin, (spans[i + 1][0] - right - 1) >> 1) : margin;
      return { x0: x + Math.max(0, left - lm), x1: x + Math.min(width, right + 1 + rm), y0: y + a, y1: y + b };
    });
  }).filter(Boolean);
}

// Same return shape as ocrPageWithOnnx, plus the grid cells for the table builder.
async function ocrPageWithGrid(canvas, pageNum, grid, withHeading = true) {
  if (!onnxReady) throw new Error('ONNX models not loaded');
  perfStart(`Grid OCR page ${pageNum}`);
  const s = OCR_SCALE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const cells = gridCells(grid.xs, grid.ys, grid.f);
  const words = [];

  // The heading above the table (title, contract number, project) is not in any grid row: it is read as lines across the page and
  // filed in the widest column of a row of its own, so it is not cut at the table's column lines. Only on the first table page: above
  // the later ones sit page numbers and running heads.
  const topH = grid.ys[0] - Math.round(3 * grid.f);
  if (withHeading && topH >= 12 * grid.f && cells.length) {
    const widest = cells.reduce((best, c) => (c.width > best.width ? c : best), cells[0]);
    const m = Math.round(0.03 * canvas.width);
    // the cell handed on has the geometry of its column; the crop it is read from spans the page
    cells.unshift({ row: -1, col: widest.col, x: widest.x, y: 0, width: widest.width, height: topH, area: widest.width * topH, heading: { x: m, width: canvas.width - 2 * m } });
  }
  const cropOf = (c) => (c.heading ? { ...c, x: c.heading.x, width: c.heading.width } : c);

  // A typical text line in each column (a description column has taller letters than a column of numbers): the 70th percentile of
  // the band heights, so a few merged lines do not inflate it.
  const scans = [];
  const byCol = new Map();
  for (let i = 0; i < cells.length; i++) {
    const sc = _cellBands(ctx, cropOf(cells[i]), grid.f);
    scans.push(sc);
    const list = byCol.get(cells[i].col) || [];
    if (!cells[i].heading) sc.bands.forEach(([a, b]) => list.push(b - a));
    byCol.set(cells[i].col, list);
    if (i % 20 === 0) await yieldToMain();
  }
  const lineH = new Map([...byCol].map(([col, hs]) => [col, hs.sort((p, q) => p - q)[Math.floor(0.7 * (hs.length - 1))] || 0]));

  const items = [];
  for (let i = 0; i < cells.length; i++) {
    for (const box of _cellLineBoxes(ctx, cropOf(cells[i]), grid.f, lineH.get(cells[i].col), scans[i], !!cells[i].heading)) {
      if (box.x1 - box.x0 >= 5 && box.y1 - box.y0 >= 5) items.push({ box, cell: cells[i] });
    }
    scans[i] = null;
    if (i % 20 === 0) await yieldToMain();
  }

  // Each line of the heading becomes a row of its own, top to bottom (ids below zero sort before the table's rows).
  const proto = cells.find(c => c.heading);
  if (proto) {
    const headRows = [];
    for (const it of items.filter(it => it.cell.heading).sort((p, q) => p.box.y0 - q.box.y0)) {
      const last = headRows[headRows.length - 1];
      if (last && (it.box.y0 + it.box.y1) / 2 <= last.y1) { last.items.push(it); last.y1 = Math.max(last.y1, it.box.y1); } else headRows.push({ items: [it], y1: it.box.y1 });
    }
    const rows = headRows.map((hr, j) => {
      const row = { ...proto, row: j - headRows.length, y: Math.min(...hr.items.map(it => it.box.y0)) };
      hr.items.forEach(it => { it.cell = row; });
      return row;
    });
    cells.splice(cells.indexOf(proto), 1, ...rows);
  }

  window.CT?.emit('page:reads', { page: pageNum, total: items.length, cells: cells.length });
  let readCount = 0;
  const reads = await _recognizeBoxes(canvas, items.map(it => it.box), (i, r) => {
    window.CT?.emit('read', { page: pageNum, done: ++readCount, total: items.length, text: r.text, conf: r.confidence, box: items[i].box });
  });
  items.forEach(({ box, cell }, i) => {
    const text = _postProcess(reads[i].text).trim();
    if (!text) return;
    words.push({
      text,
      x: box.x0 / s, y: box.y0 / s, x1: box.x1 / s, y1: box.y1 / s,
      width: (box.x1 - box.x0) / s, height: (box.y1 - box.y0) / s,
      confidence: reads[i].confidence * 100,
      src: _NUMERIC_RE.test(text) ? 'onnx-num' : 'onnx-viet',
      page: pageNum,
      cell: { row: cell.row, col: cell.col },
    });
  });

  perfEnd(`Grid OCR page ${pageNum}`);
  console.log(`[Grid] Page ${pageNum}: ${cells.length} cells, ${words.length} text lines recognized`);
  return { words, lines: [], cells };
}

if (typeof module !== 'undefined') module.exports = { gridClusters, gridTextBands, gridJointCount, gridDespeckle, gridSplitWide, gridInkRuns, gridSplitTall, gridUnderSegmented, gridCells, gridPickColumns, gridIsRuleFragment };
