// boq-grid.js — ruled-table OCR path: find the drawn grid, cut every cell into text lines, read each line.
// No text detector is involved, so no line can be missed and none is merged with its neighbour.
// On the 11-page contract this read 470 of 473 rows (detector path: about half of the descriptions dropped).
// Pages without a recognisable grid return null and keep using the detector path in boq-onnx.js.
'use strict';

// Thresholds were tuned on pages rendered 1191 px wide (A4 at 144 dpi); everything pixel-sized scales with width.
const GRID_REF_WIDTH = 1191;
const GRID_INK = 170;          // luminance below this is ink
const GRID_BAND_MIN_H = 4;     // shorter ink runs are specks, not text lines (a digit in 6-point print is 11 rows tall at 200 dpi)
const GRID_PITCH_MIN = 6;      // shortest line pitch looked for inside a tall band (6-point print is set at about 8 reference pixels)
const GRID_FOOT_LIMIT = 0.97;  // text below the grid is read down to this share of the page height (the page number sits below)
const GRID_ZONE_CONF = 0.8;    // least confidence of a line read outside the grid
const GRID_FRAME_RULED = 0.6;  // share of the edges between cells that must be drawn for a grid to be a table
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

// gridSplitWide with the word gap it may cut at taken from `minGaps`, widest first: dense small print has word gaps narrower than a
// quarter of the line height, so a line that stays too wide at the first gap is tried again at the next, down to the last.
function gridSplitWideAny(colInk, run, maxW, minGaps) {
  let pieces = [run];
  for (const gap of minGaps) {
    pieces = gridSplitWide(colInk, run, maxW, gap);
    if (pieces.every(([l, r]) => r - l + 1 <= maxW)) break;
  }
  return pieces;
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

// How many pixel rows below the grid's last row rule still carry two or more of its column rules. A table whose row separators are
// dotted or faint is found as just its header: the body below has column rules but no row rules, and is not part of the grid.
function gridRulesBelow(ver, w, h, xs, y, reach) {
  let n = 0;
  for (let yy = y + reach + 1; yy < h; yy++) {
    let hits = 0;
    for (const x of xs) {
      for (let xx = Math.max(0, x - reach); xx <= Math.min(w - 1, x + reach); xx++) if (ver[yy * w + xx]) { hits++; break; }
    }
    if (hits >= 2) n++;
  }
  return n;
}

// A box at least twice as tall as wide and tall enough to be a line of text turned on its side (a column heading written upwards).
function gridIsSideways(w, h) {
  return h >= 2 * w && h >= 24;
}

// A column whose cells all hold two tight lines has no single line to measure: its bands are all double height, so its own estimate is
// twice the true one and the splitter leaves them whole. The lines of a page share one type size more often than not, so a column's
// estimate is capped at the smallest on the page; the pitch check in gridSplitTall still decides whether a band really is several lines.
function gridColumnLineHeights(own) {
  const smallest = Math.min(Infinity, ...[...own.values()].filter(h => h > 0));
  return new Map([...own].map(([col, h]) => [col, h > 0 ? Math.min(h, smallest) : h]));
}

// A low estimate of the height of one line in a column, from the heights of its bands: the lower quartile, which merged strips
// (tight lines whose accents touch, read as one band) cannot inflate. It only says which bands are worth measuring; whether a band is
// several lines, and at what pitch, is decided by gridLinePitch.
function gridLineHeight(cellBands) {
  const all = cellBands.flat().sort((p, q) => p - q);
  return all[Math.floor(0.25 * (all.length - 1))] || 0;
}

// The pitch of the lines in a band of ink rows, or 0 when it does not repeat. Lines of text show the same ink profile again one pitch
// further down (the profile of a row of letters, then the gap, then the same); one tall line does not. The profile is compared
// with itself shifted by each lag from `minLag` on, and the first lag at which the two agree is the pitch.
function gridLinePitch(counts, a, b, minLag, agree = 0.5) {
  const n = b - a;
  const mean = counts.slice(a, b).reduce((s, c) => s + c, 0) / Math.max(n, 1);
  const p = Array.from({ length: n }, (_, i) => counts[a + i] - mean);
  const agreement = (lag) => {
    let dot = 0, x = 0, y = 0;
    for (let i = 0; i + lag < n; i++) { dot += p[i] * p[i + lag]; x += p[i] * p[i]; y += p[i + lag] * p[i + lag]; }
    return x > 0 && y > 0 ? dot / Math.sqrt(x * y) : 0;
  };
  for (let lag = Math.max(2, Math.round(minLag)); n - lag >= 0.4 * lag; lag++) {
    const r = agreement(lag);
    if (r >= agree && r >= agreement(lag - 1) && r >= agreement(lag + 1)) return lag;
  }
  return 0;
}

// The line pitch of a page's body text: the median of the pitches found in bands that hold at least three lines, where a repeat in the
// ink is unmistakable. Lines of one type size set the same pitch from cell to cell, so it can cut the bands whose own ink is too uneven to
// show a repeat (two lines of different lengths), or whose repeat was found at a multiple of the pitch. 0 when fewer than three bands agree.
function gridPagePitch(pitches, minSamples = 3) {
  if (pitches.length < minSamples) return 0;
  const sorted = [...pitches].sort((p, q) => p - q);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

// Lines set tightly (justified text, accents touching the line above) leave no blank row between them and come out as one tall band.
// A band much taller than a line is cut at the row with the least ink near each expected line boundary. `lineH` is a typical line
// height on the page; `counts` is the ink per row of the cell.
function gridSplitTall(bands, counts, lineH, ratio = 1.7, window = 0.3, floor = 0, known = 0) {
  const out = [];
  // `floor` is the shortest line pitch worth looking for. Where every band of a column is a merged strip (small print set tight) the
  // column's own line height is the strip itself, so a band is examined from twice the floor up and the floor is the shortest lag tried.
  const low = floor > 0 ? Math.min(lineH > 0 ? lineH : Infinity, 2.5 * floor) : lineH;
  for (const [a, b] of bands) {
    const h = b - a;
    if (!(low > 0) || h < ratio * low) { out.push([a, b]); continue; }
    // the band is cut only if its ink repeats at a steady pitch, which is the pitch of its lines; one tall line does not repeat
    let pitch = gridLinePitch(counts, a, b, floor > 0 ? floor : 0.8 * lineH);
    // the page's own pitch stands in where the band shows none or one that is not it, but only if every cut lands in a gap between lines
    const fromPage = known > 0 && h >= ratio * known && (!pitch || Math.abs(pitch - known) > 0.2 * known);
    if (fromPage) pitch = known;
    if (!pitch) { out.push([a, b]); continue; }
    const n = Math.max(2, Math.round(h / pitch));
    let from = a;
    const cuts = [];
    for (let k = 1; k < n; k++) {
      const target = a + k * h / n;
      let best = -1;
      for (let r = Math.max(a + 2, Math.floor(target - window * pitch)); r <= Math.min(b - 2, Math.ceil(target + window * pitch)); r++) {
        if (best < 0 || counts[r] < counts[best] || (counts[r] === counts[best] && Math.abs(r - target) < Math.abs(best - target))) best = r;
      }
      if (best >= 0) cuts.push(best);
    }
    if (fromPage) {
      const mean = counts.slice(a, b).reduce((t, c) => t + c, 0) / h;
      if (cuts.length < n - 1 || cuts.some(c => counts[c] > 0.5 * mean)) { out.push([a, b]); continue; }
    }
    for (const c of [...cuts, b]) { if (c - from >= 3) out.push([from, c]); from = c; }
  }
  return out;
}

// Two lines of a heading whose accents touch leave no blank row between them and come out as one band. If the band has a row
// inside it with almost no ink (a tenth of the densest row), with at least `minPart` rows of text on each side, it is cut there
// (at the row with the least ink); each part is then examined again. A single line has no such row: its ascenders and descenders
// are at its edges, and the body of its letters is dense throughout.
function gridSplitAtValley(bands, counts, minPart, share = 0.1) {
  const out = [];
  for (const [a, b] of bands) {
    let best = -1, peak = 0;
    for (let r = a; r < b; r++) peak = Math.max(peak, counts[r]);
    for (let r = a + minPart; r <= b - minPart; r++) if (best < 0 || counts[r] < counts[best]) best = r;
    if (best >= 0 && counts[best] <= share * peak) out.push(...gridSplitAtValley([[a, best], [best + 1, b]], counts, minPart, share));
    else out.push([a, b]);
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

// The share of a ruled line's length that carries ink. `mask` is a w x h rule mask (nonzero = rule); the line sits at `at` (x for a vertical
// line, y for a horizontal one) and is measured from `from` to `to` along its length, within `reach` pixels of `at` for a tilted scan.
function gridRuleShare(mask, w, h, at, from, to, vertical, reach) {
  let hits = 0;
  for (let p = Math.max(0, from); p < Math.min(vertical ? h : w, to); p++) {
    for (let d = at - reach; d <= at + reach; d++) {
      const x = vertical ? d : p, y = vertical ? p : d;
      if (x >= 0 && x < w && y >= 0 && y < h && mask[y * w + x]) { hits++; break; }
    }
  }
  return to > from ? hits / (to - from) : 0;
}

// A rule counts as drawn when at least this share of the edge carries ink. A banner row has no column rule through it at all, a tall
// cell no row rule beneath its text; a faint rule on a scan is still most of the way there.
const GRID_RULE_ABSENT = 0.2;
// When more than this share of the page's inner edges look undrawn, the rules are faint and not a merged-cell layout: nothing is merged.
const GRID_MERGE_MAX_ABSENT = 0.4;

// Which cells are one: cells with no drawn rule between them. `rules.v[r][c]` is the share drawn of column line c within row r,
// `rules.h[r][c]` the share drawn of row line r across column c. Returns a group number per cell, or null to leave every cell alone.
function gridMergeGroups(rows, cols, rules) {
  if (!rules || rows < 1 || cols < 1) return null;
  const parent = Array.from({ length: rows * cols }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  let edges = 0, absent = 0;
  const join = (a, b) => { parent[find(a)] = find(b); };
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (c + 1 < cols) { edges++; if (rules.v[r][c + 1] < GRID_RULE_ABSENT) { absent++; join(r * cols + c, r * cols + c + 1); } }
    if (r + 1 < rows) { edges++; if (rules.h[r + 1][c] < GRID_RULE_ABSENT) { absent++; join(r * cols + c, (r + 1) * cols + c); } }
  }
  if (!absent || absent > GRID_MERGE_MAX_ABSENT * edges) return null;
  // only a rectangle is one cell: a bent run of missing rules would swallow a neighbour, so its members stay single
  const members = new Map();
  for (let i = 0; i < rows * cols; i++) members.set(find(i), [...(members.get(find(i)) || []), i]);
  const group = new Array(rows * cols);
  members.forEach((ids) => {
    const rs = ids.map(i => Math.floor(i / cols)), cs = ids.map(i => i % cols);
    const full = (Math.max(...rs) - Math.min(...rs) + 1) * (Math.max(...cs) - Math.min(...cs) + 1) === ids.length;
    ids.forEach(i => { group[i] = full ? ids[0] : i; });
  });
  return group;
}

// Cell rectangles between consecutive ruled lines, inset so the lines themselves stay out of the crop. With `rules` (see gridMergeGroups)
// cells that have no rule between them are one rectangle, filed under the row and column of its top left corner.
function gridCells(xs, ys, f, rules = null) {
  const inL = Math.round(3 * f), inR = Math.round(2 * f);
  const rows = ys.length - 1, cols = xs.length - 1;
  // On a dense page the rows are only a line of print high: insets of 5 reference pixels would eat half of one, so they shrink with the row.
  const insetOf = (r, inset) => Math.min(inset, Math.max(2, Math.floor(0.12 * (ys[r + 1] - ys[r]))));
  const group = gridMergeGroups(rows, cols, rules);
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (group && group[r * cols + c] !== r * cols + c) continue;           // swallowed by the cell it belongs to
      let r1 = r, c1 = c;
      if (group) for (let i = 0; i < rows * cols; i++) if (group[i] === r * cols + c) { r1 = Math.max(r1, Math.floor(i / cols)); c1 = Math.max(c1, i % cols); }
      const y0 = ys[r] + insetOf(r, inL), y1 = ys[r1 + 1] - insetOf(r1, inR);
      if (y1 - y0 < Math.min(GRID_BAND_MIN_H * f, 0.5 * (ys[r1 + 1] - ys[r]))) continue;     // shorter than the shortest ink run that counts as a line of text
      const x0 = xs[c] + inL, x1 = xs[c1 + 1] - inR;
      if (x1 - x0 < 8 * f) continue;
      const cell = { row: r, col: c, x: x0, y: y0, width: x1 - x0, height: y1 - y0, area: (x1 - x0) * (y1 - y0) };
      if (r1 > r) cell.rowspan = r1 - r + 1;
      if (c1 > c) cell.colspan = c1 - c + 1;
      cells.push(cell);
    }
  }
  return cells;
}

// ── OpenCV: ruled lines -> grid ──

// The width a picture is measured by: its own, unless it is more than 1.5 times as wide as it is tall.
function gridSpan(width, height) {
  return Math.min(width, 1.5 * height);
}

// A few boxes on a page of text are not a table: the extractor wants at least 20 cells. A frame across most of the page with three
// columns or more is one too, however few rows it has: it is the page that carries over the last row of a table.
function gridIsTable(xs, ys, pageWidth) {
  const cells = (xs.length - 1) * (ys.length - 1);
  const frame = xs.length >= 4 && ys.length >= 2 && xs[xs.length - 1] - xs[0] >= 0.7 * pageWidth && cells >= 6;
  return frame || (xs.length >= 3 && ys.length >= 3 && cells >= 20);
}

// A grid is a table only when its column rules run through its rows. The long lines of a drawing can make a grid of the same shape,
// but they are broken: most of the edges between its cells are not drawn.
function gridIsRuled(v) {
  const edges = v.flat();
  return edges.filter(x => x >= 0.5).length >= GRID_FRAME_RULED * edges.length;
}

// Line detection runs on a copy no wider than GRID_REF_WIDTH (the size it was tuned on): the work falls with the pixel count and the
// ruled lines are still several pixels thick there. Positions are scaled back to the full-size canvas.
async function findGrid(canvas) {
  if (!opencvReady || typeof cv === 'undefined') return null;
  // A sheet far wider than a page (a price table printed across 24 columns) is printed at the same density as one: its text is no bigger,
  // so the scale follows the width only up to 1.5 times the height, the shape of a landscape page.
  const span = gridSpan(canvas.width, canvas.height);
  const full = span / GRID_REF_WIDTH;
  let src = canvas, k = 1;
  if (span > GRID_REF_WIDTH) {
    k = GRID_REF_WIDTH / span;
    src = document.createElement('canvas');
    src.width = Math.round(canvas.width * k); src.height = Math.round(canvas.height * k);
    src.getContext('2d').drawImage(canvas, 0, 0, src.width, src.height);
  }
  const f = Math.min(1, full);
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
    // rule shares per edge are read from a mask of short horizontal runs: a rule only as wide as a narrow column must still count
    const horShort = keep(new cv.Mat());
    cv.morphologyEx(bw, horShort, cv.MORPH_OPEN, keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(8, Math.floor(w / 40)), 1))));
    const rowSum = keep(new cv.Mat()), colSum = keep(new cv.Mat());
    cv.reduce(hor, rowSum, 1, cv.REDUCE_SUM, cv.CV_32S);
    cv.reduce(ver, colSum, 0, cv.REDUCE_SUM, cv.CV_32S);

    const yHits = [];
    for (let y = 0; y < h; y++) if (rowSum.data32S[y] > 255 * w * 0.25) yHits.push(y);
    const xsSrc = gridPickColumns(Array.from(colSum.data32S.subarray(0, w)), f);
    const reach = Math.max(2, Math.round(3 * f));
    const ysSrc = gridClusters(yHits, 4 * f).filter(y => gridJointCount(ver.data, w, h, xsSrc, y, reach) >= 2);
    if (ysSrc.length && gridRulesBelow(ver.data, w, h, xsSrc, ysSrc[ysSrc.length - 1], reach) >= 0.1 * h) return null;   // the table goes on below its last row rule
    const ys = ysSrc.map(y => Math.round(y / k));
    const xs = xsSrc.map(x => Math.round(x / k));
    // a few boxes on a page of text are not a table: the extractor wants at least 20 cells, so a smaller grid is not used
    if (!gridIsTable(xs, ys, canvas.width)) return null;
    // which rules are drawn between neighbouring cells, so a banner or a tall cell is read whole, not cut at lines that are not there
    // An edge counts as undrawn only when the opened rule mask and the raw ink agree: near the end of a table the opening can lose a rule
    // that is plainly there (contract page 8, last rows), and merging across it would put an item number into its description.
    // The opened mask holds only long straight lines, so it can be searched sideways: on a tilted scan a rule has drifted several pixels from
    // its line by the page's far end. The raw ink vouches for a rule only when it is strong, at the line itself: the opening loses rules near
    // the end of a table (contract page 8, last rows: raw 0.7 to 0.9), while ordinary text near a cell edge gives a raw share of 0.2 to 0.5.
    const slide = Math.max(reach, Math.round(8 * f));
    const share = (opened, vertical, at, from, to) => {
      const raw = gridRuleShare(bw.data, w, h, at, from, to, vertical, reach);
      let best = raw >= 0.6 ? raw : 0;
      for (let d = -slide; d <= slide && best < 1; d++) best = Math.max(best, gridRuleShare(opened.data, w, h, at + d, from, to, vertical, 1));
      return best;
    };
    const v = ysSrc.slice(0, -1).map((y, r) => xsSrc.map(x => share(ver, true, x, y + reach + 1, ysSrc[r + 1] - reach)));
    const hh = ysSrc.map(y => xsSrc.slice(0, -1).map((x, c) => share(horShort, false, y, x + reach + 1, xsSrc[c + 1] - reach)));
    if (!gridIsRuled(v)) return null;
    return { xs, ys, f: full, rules: { v, h: hh } };
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
  // a speck is shorter than a line of print: in a cell only a line high that is 0.4 of the cell (dense small print), else the usual six reference pixels
  const bands = gridTextBands(counts.map(n => n > 0), Math.max(2, Math.round(GRID_BAND_GAP * f)), Math.min(Math.round(GRID_BAND_MIN_H * f), Math.round(0.4 * height)));
  return { px, dark, counts, bands };
}

function _cellLineBoxes(ctx, cell, f, lineH, scanned, splitGaps = false, pagePitch = 0) {
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
  // Only a band wider than it is tall can be several lines of text: a tall narrow band is sideways text and stays whole. A block of
  // many short lines can be taller than wide too, but it is at least several line heights across, which sideways text never is.
  const lines = splitGaps ? gridSplitAtValley(bands, counts, Math.round(GRID_BAND_MIN_H * 2.5 * f)) : bands;
  const pieces = lines.flatMap(([a, b]) => { const [l, r] = extent(a, b); return r - l + 1 >= 1.5 * (b - a) || (lineH > 0 && r - l + 1 >= 8 * lineH) ? gridSplitTall([[a, b]], counts, lineH, 1.7, 0.3, Math.round(GRID_PITCH_MIN * f), splitGaps ? 0 : pagePitch) : [[a, b]]; });
  return pieces.flatMap(([a, b]) => {
    const ink = colInk(a, b);
    // The recogniser sees a strip 32 high and at most 512 wide, so a line wider than about 16 times its height is squeezed past reading:
    // it is cut at its word gaps, in a heading wherever the ink breaks, in a cell only where the line is that long.
    const [left0, right0] = extent(a, b);
    const gapsFor = (h) => [Math.round(0.25 * h), Math.round(0.15 * h), Math.round(0.08 * h)].map(g => Math.max(2, g));
    const spans = splitGaps ? gridInkRuns(ink, Math.round(2.5 * (b - a))).flatMap(run => gridSplitWideAny(ink, run, 16 * (b - a), gapsFor(b - a))) : left0 > right0 ? [] : gridSplitWideAny(ink, [left0, right0], 16 * (b - a), gapsFor(b - a));
    return spans.map(([left, right], i) => {
      if (gridIsRuleFragment(b - a, cell.height, right - left + 1)) return null;
      if (splitGaps && right - left + 1 < 0.6 * (b - a)) return null;          // a fold mark or a hole at the edge of the page, not a word
      // beside a neighbouring piece the margin stops halfway across the gap, so a letter is not read twice
      const lm = i > 0 ? Math.min(margin, (left - spans[i - 1][1] - 1) >> 1) : margin;
      const rm = i < spans.length - 1 ? Math.min(margin, (spans[i + 1][0] - right - 1) >> 1) : margin;
      const vm = Math.round(0.15 * (b - a));
      return { x0: x + Math.max(0, left - lm), x1: x + Math.min(width, right + 1 + rm), y0: y + Math.max(0, a - vm), y1: y + Math.min(cell.height, b + vm) };
    });
  }).filter(Boolean);
}

// The stretches of the page outside the grid that are read as lines: above the first rule (when asked) and below the last, each at
// least twelve reference pixels tall. Heights and positions are in canvas pixels; `f` is the canvas width over the reference width.
function gridZones(ys, pageHeight, f, withHeading) {
  const zones = [];
  const topH = ys[0] - Math.round(3 * f);
  if (withHeading && topH >= 12 * f) zones.push({ name: 'top', y: 0, height: topH });
  const footY = ys[ys.length - 1] + Math.round(3 * f);
  const footH = Math.round(GRID_FOOT_LIMIT * pageHeight) - footY;
  if (footH >= 12 * f) zones.push({ name: 'foot', y: footY, height: footH });
  return zones;
}

// Same return shape as ocrPageWithOnnx, plus the grid cells for the table builder.
async function ocrPageWithGrid(canvas, pageNum, grid, withHeading = true) {
  if (!onnxReady) throw new Error('ONNX models not loaded');
  perfStart(`Grid OCR page ${pageNum}`);
  const s = OCR_SCALE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const cells = gridCells(grid.xs, grid.ys, grid.f, grid.rules);
  const words = [];

  // Text outside the grid is not in any grid row: the heading above the table (title, contract number, project) and what follows it
  // (a note, the next heading, a second table) are read as lines across the page and filed in the widest column of a row of their own,
  // so they are not cut at the table's column lines. Above, only on the first table page: above the later ones sit page numbers and
  // running heads. Below, on every page, down to where the page number sits.
  const m = Math.round(0.03 * canvas.width);
  const zones = gridZones(grid.ys, canvas.height, grid.f, withHeading);
  if (cells.length) {
    const widest = cells.reduce((best, c) => (c.width > best.width ? c : best), cells[0]);
    // the cell handed on has the geometry of its column; the crop it is read from spans the page
    for (const z of zones) cells.unshift({ row: z.name === 'top' ? -1 : cells.length, col: widest.col, x: widest.x, y: z.y, width: widest.width, height: z.height, area: widest.width * z.height, heading: { x: m, width: canvas.width - 2 * m }, zone: z.name });
  }
  const cropOf = (c) => (c.heading ? { ...c, x: c.heading.x, width: c.heading.width } : c);

  // A typical text line in each column (a description column has taller letters than a column of numbers).
  const scans = [];
  const byCol = new Map();
  for (let i = 0; i < cells.length; i++) {
    const sc = _cellBands(ctx, cropOf(cells[i]), grid.f);
    scans.push(sc);
    if (!cells[i].heading && !cells[i].colspan) byCol.set(cells[i].col, [...(byCol.get(cells[i].col) || []), sc.bands.map(([a, b]) => b - a)]);
    if (i % 20 === 0) await yieldToMain();
  }
  const lineH = gridColumnLineHeights(new Map([...byCol].map(([col, bands]) => [col, gridLineHeight(bands)])));
  // the heading is not in a column: it is set in a larger face than a column of figures, so it takes the tallest line of any column
  const headingLineH = Math.max(0, ...lineH.values());
  const pitches = [];
  cells.forEach((c, i) => {
    if (c.heading || c.colspan) return;
    const low = lineH.get(c.col) || 0;
    for (const [a, b] of scans[i].bands) {
      const pitch = low > 0 && b - a >= 3 * low ? gridLinePitch(scans[i].counts, a, b, Math.round(GRID_PITCH_MIN * grid.f)) : 0;
      if (pitch && b - a >= 2.6 * pitch) pitches.push(pitch);
    }
  });
  const pagePitch = gridPagePitch(pitches);

  const items = [];
  for (let i = 0; i < cells.length; i++) {
    for (const box of _cellLineBoxes(ctx, cropOf(cells[i]), grid.f, cells[i].heading ? headingLineH : lineH.get(cells[i].col) ?? headingLineH, scans[i], !!cells[i].heading, pagePitch)) {
      if (box.x1 - box.x0 >= 5 && box.y1 - box.y0 >= 5) items.push({ box, cell: cells[i] });
    }
    scans[i] = null;
    if (i % 20 === 0) await yieldToMain();
  }

  // Each line outside the grid becomes a row of its own, top to bottom (ids below zero sort before the table's rows, ids past its last row after).
  const lastRow = Math.max(-1, ...cells.filter(c => !c.heading).map(c => c.row + (c.rowspan || 1) - 1));
  for (const z of zones) {
    const proto = cells.find(c => c.zone === z.name);
    const lines = [];
    for (const it of items.filter(it => it.cell === proto).sort((p, q) => p.box.y0 - q.box.y0)) {
      const last = lines[lines.length - 1];
      if (last && (it.box.y0 + it.box.y1) / 2 <= last.y1) { last.items.push(it); last.y1 = Math.max(last.y1, it.box.y1); } else lines.push({ items: [it], y1: it.box.y1 });
    }
    const rows = lines.map((hr, j) => {
      const row = { ...proto, row: z.name === 'top' ? j - lines.length : lastRow + 1 + j, y: Math.min(...hr.items.map(it => it.box.y0)) };
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
    // a line outside the grid sits among stamps and signatures, whose strokes read as a stray letter: it must be read with some surety
    if (cell.heading && (text.length < 2 || reads[i].confidence < GRID_ZONE_CONF)) return;
    words.push({
      text,
      x: box.x0 / s, y: box.y0 / s, x1: box.x1 / s, y1: box.y1 / s,
      width: (box.x1 - box.x0) / s, height: (box.y1 - box.y0) / s,
      confidence: reads[i].confidence * 100,
      src: _NUMERIC_RE.test(text) ? 'onnx-num' : 'onnx-viet',
      page: pageNum,
      cell: { row: cell.row, col: cell.col, tall: cell.rowspan > 1 },
    });
  });

  perfEnd(`Grid OCR page ${pageNum}`);
  console.log(`[Grid] Page ${pageNum}: ${cells.length} cells, ${words.length} text lines recognized`);
  return { words, lines: [], cells };
}

if (typeof module !== 'undefined') module.exports = { gridClusters, gridTextBands, gridJointCount, gridRulesBelow, gridIsSideways, gridLineHeight, gridLinePitch, gridDespeckle, gridSplitWide, gridSplitWideAny, gridInkRuns, gridSplitTall, gridPagePitch, gridSplitAtValley, gridIsTable, gridIsRuled, gridSpan, gridZones, gridCells, gridPickColumns, gridIsRuleFragment, gridRuleShare, gridMergeGroups, gridColumnLineHeights };
