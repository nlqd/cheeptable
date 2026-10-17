// boq-extract.js — table extraction: lattice, OCR, spatial, clustering
'use strict';

// ── Line Extraction from pdf.js Operator List ──
function extractLines(opList, pageH, pageNum) {
  const OPS = pdfjsLib.OPS;
  const lines = [];
  let cx = 0, cy = 0;

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];

    if (fn === OPS.constructPath) {
      const pathOps = args[0];
      const coords = args[1];
      let ci = 0, px = 0, py = 0;
      for (const op of pathOps) {
        if (op === 0) { // moveTo
          px = coords[ci++]; py = coords[ci++];
        } else if (op === 1) { // lineTo
          const nx = coords[ci++], ny = coords[ci++];
          const len = Math.hypot(nx - px, ny - py);
          if (len >= MIN_LINE_LEN) {
            lines.push({ x0: px, y0: pageH - py, x1: nx, y1: pageH - ny, page: pageNum });
          }
          px = nx; py = ny;
        } else if (op === 2) { ci += 6; } // curveTo: skip
        else if (op === 3) { /* closePath */ }
      }
    }

    if (fn === OPS.rectangle && args.length >= 4) {
      const [x, y, w, h] = args;
      // Rectangles produce 4 lines
      if (Math.abs(w) >= MIN_LINE_LEN) {
        lines.push({ x0: x, y0: pageH - y, x1: x + w, y1: pageH - y, page: pageNum });
        lines.push({ x0: x, y0: pageH - (y + h), x1: x + w, y1: pageH - (y + h), page: pageNum });
      }
      if (Math.abs(h) >= MIN_LINE_LEN) {
        lines.push({ x0: x, y0: pageH - y, x1: x, y1: pageH - (y + h), page: pageNum });
        lines.push({ x0: x + w, y0: pageH - y, x1: x + w, y1: pageH - (y + h), page: pageNum });
      }
    }

    // Individual path ops (some pdf.js versions)
    if (fn === OPS.moveTo) { cx = args[0]; cy = args[1]; }
    if (fn === OPS.lineTo) {
      const len = Math.hypot(args[0] - cx, args[1] - cy);
      if (len >= MIN_LINE_LEN) {
        lines.push({ x0: cx, y0: pageH - cy, x1: args[0], y1: pageH - args[1], page: pageNum });
      }
      cx = args[0]; cy = args[1];
    }
  }
  return lines;
}

// ── Lattice Table Extraction ──
async function latticeExtract(textItems, lines, numPages) {
  const allRows = [];

  for (let p = 1; p <= numPages; p++) {
    const pageLines = lines.filter(l => l.page === p);
    const pageText = textItems.filter(t => t.page === p);
    if (pageLines.length < 4 || pageText.length === 0) continue;

    // Classify lines
    const hLines = [], vLines = [];
    for (const l of pageLines) {
      const dx = Math.abs(l.x1 - l.x0), dy = Math.abs(l.y1 - l.y0);
      if (dy < LINE_TOLERANCE && dx >= MIN_LINE_LEN)
        hLines.push({ y: (l.y0 + l.y1) / 2, xMin: Math.min(l.x0, l.x1), xMax: Math.max(l.x0, l.x1) });
      else if (dx < LINE_TOLERANCE && dy >= MIN_LINE_LEN)
        vLines.push({ x: (l.x0 + l.x1) / 2, yMin: Math.min(l.y0, l.y1), yMax: Math.max(l.y0, l.y1) });
    }

    const ys = cluster(hLines.map(l => l.y));
    const xs = cluster(vLines.map(l => l.x));

    if (xs.length < 2 || ys.length < 2) {
      log(`  Page ${p}: Grid too sparse (${xs.length} cols, ${ys.length} rows) — skipping lattice`, 'warn');
      continue;
    }

    log(`  Page ${p}: Grid ${ys.length - 1} rows × ${xs.length - 1} cols`);

    // Build cells
    for (let r = 0; r < ys.length - 1; r++) {
      const rowCells = [];
      const yTop = ys[r], yBot = ys[r + 1];

      for (let c = 0; c < xs.length - 1; c++) {
        const xL = xs[c] + CELL_PAD, xR = xs[c + 1] - CELL_PAD;
        const cellText = pageText.filter(t => {
          const tcx = t.x + t.width / 2;
          const tcy = t.y;
          return tcx >= xL && tcx <= xR && tcy >= yTop + CELL_PAD && tcy <= yBot - CELL_PAD;
        });
        cellText.sort((a, b) => a.y - b.y || a.x - b.x);
        const rawText = cellText.map(t => t.str).join(' ').trim();

        // Use original OCR text without correction
        try {
          rowCells.push(rawText);
        } catch (error) {
          console.error('Cell correction failed in latticeExtract:', rawText, error);
          rowCells.push(rawText); // Fallback to original
        }
      }

      // Skip empty rows
      if (rowCells.every(c => c === '')) continue;

      // Classify row
      const nonEmpty = rowCells.filter(c => c !== '').length;
      const firstCell = rowCells[0] || '';
      const isSection = (nonEmpty <= 2 && rowCells.slice(1).some(c => c.length > 15)) ||
                        (rowCells.join(' ').match(/^(PHẦN|TÁI LẬP|Thủy lượng|ĐƯỜNG|\d+\.\s*ĐƯỜNG)/i));
      const isHeader = firstCell.match(/^(Stt|\(1\))/i);

      if (isHeader) continue; // skip repeated headers

      allRows.push({
        type: isSection ? 'section' : 'data',
        cells: rowCells,
        page: p
      });
    }
  }

  return allRows;
}

// ── Cells as the results table expects them. The recogniser's text is used as read: no spell correction. ──
function classifyCellType(text, colIndex) {
  if (colIndex === 0) return 'stt';
  if (colIndex === 1) return 'text';
  if (colIndex === 2) return 'unit';
  return 'number';
}

function createCellMetadata(value, confidence, colIndex) {
  const text = value || '';
  return { value: text, original: text, confidence: text ? confidence : 0, source: text ? 'ocr' : 'empty', correctedBy: null, type: classifyCellType(text, colIndex), edited: false };
}

function buildCellWithMetadata(words, colIndex) {
  if (!words || !words.length) return createCellMetadata('', 0, colIndex);
  const confidence = Math.round(words.reduce((sum, w) => sum + w.confidence, 0) / words.length);
  return { ...createCellMetadata(words.map(w => w.text).join(' '), confidence, colIndex), ocrWords: words.length, avgOcrConfidence: confidence };
}

// ── Ledger extraction: tables with no ruling, such as a scanned financial statement ──
// Each detected box is a cell. Numbers line up on their right edge, so the right edges of the numeric boxes give the columns;
// a short number at the far left is a code column; everything else on a line is the description.
const LEDGER_NUMBER = /^[\d.,()\-\u2013%/\s]+$/;
function ledgerExtract(lines) {
  const isNum = (w) => /\d/.test(w.text) && LEDGER_NUMBER.test(w.text) && !/^\(?\d{1,2}[.)]$/.test(w.text.trim());   // "1." is an outline number, not a quantity
  const edges = lines.flatMap(l => l.words.filter(isNum).map(w => w.x1)).sort((a, b) => a - b);
  const clusters = [];
  for (const x of edges) {
    const last = clusters[clusters.length - 1];
    if (last && x - last.sum / last.n <= 8) { last.sum += x; last.n++; } else clusters.push({ sum: x, n: 1 });
  }
  const minSupport = Math.max(3, Math.round(0.1 * lines.length));
  const cols = clusters.filter(c => c.n >= minSupport).map(c => c.sum / c.n);
  if (!cols.length) return [];
  const textLeft = lines.flatMap(l => l.words.filter(w => !isNum(w)).map(w => w.x)).sort((a, b) => a - b);
  const descStart = textLeft.length ? textLeft[Math.floor(textLeft.length * 0.1)] : cols[0];
  const hasCode = cols[0] < descStart;                       // a number column that ends before the descriptions start
  const desc = hasCode ? 1 : 0;                              // cells: [code], description, one per remaining number column
  const width = desc + 1 + (hasCode ? cols.length - 1 : cols.length);
  const rows = [];
  for (const line of lines) {
    const cells = Array.from({ length: width }, () => []);
    for (const w of line.words) {
      let at = desc;
      if (isNum(w)) {
        const n = cols.reduce((best, c, i) => (Math.abs(c - w.x1) < Math.abs(cols[best] - w.x1) ? i : best), 0);
        if (Math.abs(cols[n] - w.x1) <= 14) at = hasCode ? (n === 0 ? 0 : desc + n) : desc + 1 + n;
      }
      cells[at].push(w);
    }
    const built = cells.map((ws, i) => buildCellWithMetadata(ws, i));
    if (built.every(c => c.value === '')) continue;
    rows.push({ type: 'data', cells: built, page: line.page });
  }
  return rows;
}

// ── Columns from the gutters between them (any table with aligned columns, ruled or not, scanned or from a text layer) ──
// Lines are made of boxes (a run of words with no wide gap). The share of lines covering each x tells where the gutters are:
// narrow vertical stripes that almost no line crosses. A few lines that span the page (a title) are tolerated.
function gutterExtract(lines) {
  if (lines.length < 4) return [];
  const x0 = Math.floor(Math.min(...lines.map(l => l.x))), x1 = Math.ceil(Math.max(...lines.map(l => l.x1)));
  const cover = new Uint16Array(x1 - x0 + 1);
  for (const l of lines) for (const w of l.words) for (let x = Math.floor(w.x) - x0; x <= Math.ceil(w.x1) - x0; x++) cover[x]++;
  const limit = Math.max(1, Math.round(0.08 * lines.length)), minGap = 5;
  const cuts = [];
  for (let x = 0, start = -1; x <= cover.length; x++) {
    const open = x < cover.length && cover[x] <= limit;
    if (open && start < 0) start = x;
    if (!open && start >= 0) { if (x - start >= minGap && start > 0 && x < cover.length) cuts.push((start + x) / 2 + x0); start = -1; }
  }
  if (!cuts.length) return [];
  const colOf = (w) => { const c = (w.x + w.x1) / 2; let i = 0; while (i < cuts.length && c > cuts[i]) i++; return i; };
  const rows = [];
  for (const line of lines) {
    const cells = Array.from({ length: cuts.length + 1 }, () => []);
    for (const w of line.words) cells[colOf(w)].push(w);
    const built = cells.map((ws, i) => buildCellWithMetadata(ws, i));
    if (built.every(c => c.value === '')) continue;
    rows.push({ type: 'data', cells: built, page: line.page });
  }
  return rows;
}

// Lines of boxes from a PDF text layer. Items closer than an eighth of the text height are one word (the layer often cuts words
// into pieces), up to the text height they are separate words of one box, wider than that they start a new box.
function textLayerLines(items, pageNum) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(it.y - last.y) <= 0.5 * Math.max(it.height, last.height)) { last.items.push(it); last.height = Math.max(last.height, it.height); }
    else rows.push({ y: it.y, height: it.height, items: [it] });
  }
  return rows.map(r => {
    const its = r.items.sort((a, b) => a.x - b.x);
    const boxes = [];
    for (const it of its) {
      const b = boxes[boxes.length - 1], h = Math.max(it.height, 1);
      const gap = b ? it.x - b.x1 : Infinity;
      if (b && gap < h) {
        b.text += (/\s$/.test(b.raw) || /^\s/.test(it.str) || gap >= 0.12 * h ? ' ' : '') + it.str.trim();
        b.raw = it.str; b.x1 = Math.max(b.x1, it.x + it.width); b.height = Math.max(b.height, it.height);
      } else boxes.push({ raw: it.str, text: it.str.trim(), x: it.x, x1: it.x + it.width, y: it.y - it.height, y1: it.y, width: 0, height: it.height, confidence: 100, page: pageNum, src: 'text' });
    }
    const words = boxes.filter(b => b.text);
    return { words, text: words.map(w => w.text).join(' '), page: pageNum, x: Math.min(...words.map(w => w.x)), x1: Math.max(...words.map(w => w.x1)),
      y: Math.min(...words.map(w => w.y)), y1: Math.max(...words.map(w => w.y1)), confidence: 100 };
  }).filter(l => l.words.length);
}

// ── OCR Table Extraction ──
async function ocrTableExtract(ocrLines, ocrWords, borderCells = []) {
  const extractStart = performance.now();

  // Filter margin content (headers/footers in top/bottom 5%)
  const pageHeights = {};
  ocrWords.forEach(w => {
    pageHeights[w.page] = Math.max(pageHeights[w.page] || 0, w.y1);
  });


  // A page with a drawn grid (at least 20 cells) is read cell by cell; every other page, scanned or not, from the positions of its
  // text. One file can hold both kinds, and a stray small box on a page of text must not decide for the whole file.
  const gridPages = new Set();
  for (const p of new Set(borderCells.map(c => c.page))) {
    const n = borderCells.filter(c => c.page === p).length;
    if (n >= 20) gridPages.add(p); else log(`  Page ${p}: only ${n} cells in a grid, read as text instead`, 'warn');
  }
  const parts = [];
  if (gridPages.size) {
    log(`Using BORDER-BASED extraction (${gridPages.size} page(s) with a grid)`, 'ok');
    parts.push(await borderBasedExtract(ocrWords.filter(w => gridPages.has(w.page)), borderCells.filter(c => gridPages.has(c.page))));
  }
  const restWords = ocrWords.filter(w => !gridPages.has(w.page));
  if (restWords.length) parts.push(await textBasedExtract(ocrLines.filter(l => !gridPages.has(l.page)), restWords, pageHeights));
  return parts.length > 1 ? parts.flat().map((r, i) => [r, i]).sort((x, y) => (x[0].page || 0) - (y[0].page || 0) || x[1] - y[1]).map(x => x[0]) : (parts[0] || []);
}

// Rows from the positions of OCR lines and words (no drawn grid).
async function textBasedExtract(ocrLines, ocrWords, pageHeights) {
  const filteredLines = ocrLines.filter(l => {
    const ph = pageHeights[l.page] || 800;
    return l.y > ph * 0.05 && l.y1 < ph * 0.95;
  });

  // Check if pipe characters are prevalent (table borders recognized as |)
  const pipeCount = filteredLines.filter(l => (l.text.match(/[|\[\]]/g) || []).length >= 2).length;
  const pipeRatio = filteredLines.length ? pipeCount / filteredLines.length : 0;
  log(`  Pipe-delimited lines: ${pipeCount}/${filteredLines.length} (${(pipeRatio * 100).toFixed(0)}%)`);

  if (pipeRatio > 0.25) {
    log('Using PIPE-BASED parsing (table borders detected in OCR)', 'ok');
    return await pipeBasedExtract(filteredLines);
  }

  const ledger = filteredLines.length >= 5 ? ledgerExtract(filteredLines) : [];
  if (ledger.length >= 5) {
    log('Using LEDGER parsing (numbers aligned on their right edge)', 'ok');
    return ledger;
  }

  // Fallback: spatial word-position analysis
  log('Using SPATIAL parsing (word positions)', 'ok');
  const filteredWords = ocrWords.filter(w => {
    const ph = pageHeights[w.page] || 800;
    return w.y > ph * 0.05 && w.y1 < ph * 0.95;
  });
  return await spatialExtract(filteredLines, filteredWords);
}

// Build table grid using column boundaries from cell X-positions and
// row boundaries from word Y-centers.
// Column boundaries come from clustering cell.x values (vertical lines are
// reliable in scanned PDFs even when horizontal lines are faint).
// Row boundaries come from clustering word Y-center positions (no dependency
// on horizontal borders at all — eliminates the cross-row word contamination
// caused by the old 30pt cell margin).
function wordGridExtract(pageWords, pageCells) {
  if (pageWords.length === 0) return { grid: [], numRows: 0, numCols: 0 };
  // Words read from a ruled grid (boq-grid.js) already carry their cell, so the geometry guessing below,
  // including its merge of words that sit close across a column line, would only damage them.
  if (pageWords.every(w => w.cell) && pageCells.every(c => c.row !== undefined)) {
    return gridCellsToWordGrid(pageWords, pageCells);
  }

  // ── Column detection ──────────────────────────────────────────────────────
  // Cluster cell left-edge (cell.x) values; gaps > 5pt separate columns.
  const sortedX = pageCells.map(c => c.x).sort((a, b) => a - b);
  const colLefts = [sortedX[0]];
  for (let i = 1; i < sortedX.length; i++) {
    if (sortedX[i] - colLefts[colLefts.length - 1] > 5) {
      colLefts.push(sortedX[i]);
    }
  }
  const maxRight = pageCells.reduce((m, c) => Math.max(m, c.x + c.width), 0);
  const numCols = colLefts.length;

  // ── Row detection ─────────────────────────────────────────────────────────
  // Use cell top-edges (cell.y) — same approach as column detection — so that
  // multi-line description cells don't create phantom extra rows.
  const sortedY = pageCells.map(c => c.y).sort((a, b) => a - b);
  const rowTops = [sortedY[0]];
  for (let i = 1; i < sortedY.length; i++) {
    if (sortedY[i] - rowTops[rowTops.length - 1] > 5) {
      rowTops.push(sortedY[i]);
    }
  }
  const maxBottom = pageCells.reduce((m, c) => Math.max(m, c.y + c.height), 0);
  const numRows = rowTops.length;

  // ── Build grid ────────────────────────────────────────────────────────────
  const grid = Array.from({ length: numRows }, () =>
    Array.from({ length: numCols }, () => ({ words: [], text: '', confidence: 0 }))
  );

  let assigned = 0, skipped = 0;
  // Helper: find which column index an x-coordinate belongs to (left-edge based)
  function findCol(x) {
    let c = numCols - 1;
    for (let i = 0; i < numCols - 1; i++) {
      if (x < colLefts[i + 1]) { c = i; break; }
    }
    return c;
  }

  for (const word of pageWords) {
    const cy = (word.y + word.y1) / 2;

    // Skip words outside the detected row area (use center for vertical)
    if (cy < rowTops[0] || cy > maxBottom) { skipped++; continue; }
    // Skip words entirely to the left of the table or to the right
    if (word.x1 < colLefts[0] || word.x > maxRight) { skipped++; continue; }

    // Row: find which interval [rowTops[r], rowTops[r+1]) contains cy
    let row = numRows - 1;
    for (let r = 0; r < numRows - 1; r++) {
      if (cy < rowTops[r + 1]) { row = r; break; }
    }

    // Column: use the word's LEFT EDGE so a word is placed in the column
    // where it starts — this correctly handles narrow STT numbers whose
    // bounding-box center may bleed into the adjacent description column.
    const leftCol  = findCol(Math.max(word.x,  colLefts[0]));
    const rightCol = findCol(Math.min(word.x1, maxRight));

    if (leftCol !== rightCol) {
      // Word spans a column boundary. If it looks like "NNN<text>" (a STT
      // number fused with the description by PaddleOCR), split it so the
      // digits go to the left column and the rest goes to the right column.
      const m = word.text.match(/^(\d{1,3})\s*([A-Za-z\u00C0-\u024F\u1E00-\u1EFF\[\(].*)$/u);
      if (m) {
        grid[row][leftCol].words.push({ ...word, text: m[1] });
        grid[row][rightCol].words.push({ ...word, text: m[2], x: colLefts[rightCol] });
        assigned += 2;
      } else {
        // Can't split cleanly — put in left column
        grid[row][leftCol].words.push(word);
        assigned++;
      }
    } else {
      grid[row][leftCol].words.push(word);
      assigned++;
    }
  }

  // Sort words within each cell left-to-right
  for (const row of grid) {
    for (const cell of row) {
      if (cell.words.length > 0) cell.words.sort((a, b) => a.x - b.x);
    }
  }

  // Fix column-boundary word splitting: if the last word of cell N and the
  // first word of cell N+1 are very close (< MERGE_GAP px), the column
  // boundary accidentally split a compound token. Merge the stray word back.
  const MERGE_GAP = 10; // canvas pixels (~3.6 PDF points)
  for (const row of grid) {
    for (let ci = 0; ci < numCols - 1; ci++) {
      const left = row[ci], right = row[ci + 1];
      if (left.words.length === 0 || right.words.length === 0) continue;
      const lastLeft   = left.words[left.words.length - 1];
      const firstRight = right.words[0];
      const gapToLeft  = firstRight.x - lastLeft.x1;
      if (gapToLeft < MERGE_GAP) {
        // Also check: is firstRight closer to its left neighbor than its right?
        // If right cell has a second word, compare gaps.
        if (right.words.length >= 2) {
          const secondRight = right.words[1];
          const gapToRight  = secondRight.x - firstRight.x1;
          if (gapToLeft >= gapToRight) continue; // closer to its own cell, skip
        }
        // Move firstRight into left cell
        left.words.push(right.words.shift());
      }
    }
  }

  // Build text for each non-empty cell
  for (const row of grid) {
    for (const cell of row) {
      if (cell.words.length > 0) {
        cell.text       = cell.words.map(w => w.text).join(' ').trim();
        cell.confidence = cell.words.reduce((s, w) => s + w.confidence, 0) / cell.words.length;
      }
    }
  }

  // Post-process: reconstruct STT column (col 0) from three observed failure modes:
  //   1. col0 empty,   col1 = "10Van..." or "14 Van..." (STT fused into description)
  //   2. col0 = "14 Van..." (entire fused word landed in col0, col1 empty)
  //   3. col0 = "1",   col1 = "2 Van..." or "3[Van..." (PaddleOCR split tens/units digit)
  // Guard: \d{1,3} must be followed (after optional spaces) by a non-digit, non-dot,
  // non-space character so we don't split section headers ("1.ĐƯỜNG...") or numbers.
  if (numCols >= 2) {
    for (const row of grid) {
      const cell0 = row[0], cell1 = row[1];

      // Case 1: col0 empty → check col1 for leading STT digits
      if (!cell0.text) {
        const m = cell1.text.match(/^(\d{1,3})\s*([^\d.\s][\s\S]*)$/u);
        if (m) { cell0.text = m[1]; cell1.text = m[2]; }
      }

      // Case 2: col0 has "STT<space>description", col1 empty
      if (cell0.text && !cell1.text) {
        const m = cell0.text.match(/^(\d{1,3})\s+([^\d][\s\S]*)$/u);
        if (m) { cell0.text = m[1]; cell1.text = m[2]; }
      }

      // Case 3: col0 is exactly 1-2 digits (partial STT), col1 starts with the
      // remaining digit(s) — PaddleOCR detected tens and units as separate words.
      if (/^\d{1,2}$/.test(cell0.text)) {
        const m = cell1.text.match(/^(\d{1,2})\s*([^\d.\s][\s\S]*)$/u);
        if (m) { cell0.text += m[1]; cell1.text = m[2]; }
      }
    }
  }

  return { grid, numRows, numCols, colLefts, rowTops, maxRight, maxBottom };
}

// Same result shape as the geometry path. Rows and columns are the ruled-grid indices, compacted to 0..n-1.
function gridCellsToWordGrid(pageWords, pageCells) {
  const ids = (key) => [...new Set(pageCells.map(c => c[key]))].sort((a, b) => a - b);
  const rowIds = ids('row'), colIds = ids('col');
  const numRows = rowIds.length, numCols = colIds.length;
  const rowAt = new Map(rowIds.map((id, i) => [id, i]));
  const colAt = new Map(colIds.map((id, i) => [id, i]));

  const colLefts = [], rowTops = [];
  for (const c of pageCells) {
    colLefts[colAt.get(c.col)] = c.x;
    rowTops[rowAt.get(c.row)] = c.y;
  }
  const maxRight = pageCells.reduce((m, c) => Math.max(m, c.x + c.width), 0);
  const maxBottom = pageCells.reduce((m, c) => Math.max(m, c.y + c.height), 0);

  const grid = Array.from({ length: numRows }, () =>
    Array.from({ length: numCols }, () => ({ words: [], text: '', confidence: 0 })));
  // words arrive top to bottom, so a wrapped description keeps its line order
  for (const word of pageWords) {
    const r = rowAt.get(word.cell.row), c = colAt.get(word.cell.col);
    if (r !== undefined && c !== undefined) grid[r][c].words.push(word);
  }
  for (const row of grid) {
    for (const cell of row) {
      if (!cell.words.length) continue;
      cell.text = cell.words.map(w => w.text).join(' ').trim();
      cell.confidence = cell.words.reduce((s, w) => s + w.confidence, 0) / cell.words.length;
    }
  }
  return { grid, numRows, numCols, colLefts, rowTops, maxRight, maxBottom };
}

// Border-based extraction using OpenCV detected cells
function wordsBox(words) {
  if (!words || !words.length) return undefined;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const w of words) { x0 = Math.min(x0, w.x); y0 = Math.min(y0, w.y); x1 = Math.max(x1, w.x1); y1 = Math.max(y1, w.y1); }
  return { x0: x0 * OCR_SCALE, y0: y0 * OCR_SCALE, x1: x1 * OCR_SCALE, y1: y1 * OCR_SCALE };
}

async function borderBasedExtract(ocrWords, borderCells) {

  // Group cells and words by page for efficient per-page processing
  const cellsByPage = {};
  const wordsByPage = {};

  borderCells.forEach(cell => {
    const page = cell.page || 1;
    if (!cellsByPage[page]) cellsByPage[page] = [];
    cellsByPage[page].push(cell);
  });

  ocrWords.forEach(word => {
    const page = word.page || 1;
    if (!wordsByPage[page]) wordsByPage[page] = [];
    wordsByPage[page].push(word);
  });


  // Process each page independently (mapping + grid reconstruction)
  const tableRows = [];
  let maxCols = 0;

  const pages = Object.keys(cellsByPage).sort((a, b) => parseInt(a) - parseInt(b));

  for (const page of pages) {
    await yieldToMain(); // let the browser breathe between pages
    const pageCells = cellsByPage[page];
    const pageWords = wordsByPage[page] || [];
    const t0 = performance.now();

    const { grid, numRows, numCols, colLefts, rowTops, maxRight, maxBottom } = wordGridExtract(pageWords, pageCells);
    maxCols = Math.max(maxCols, numCols);
    const elapsed = (performance.now() - t0).toFixed(0);

    log(`  Page ${page}: ${numRows} rows × ${numCols} cols | ${pageWords.length} words in ${elapsed}ms`);

    // Convert grid to table rows
    let rowsWithContent = 0;
    for (let r = 0; r < numRows; r++) {
      const cells = grid[r].map((cell, ci) => ({
        value: cell.text || '',
        original: cell.text || '',
        confidence: cell.confidence || 0,
        source: 'word-grid',
        correctedBy: null,
        type: 'data',
        edited: false,
        // Keep word bboxes for numeric columns (qty/price/total) so garbage cells
        // can be re-OCR'd with a targeted crop.
        _words: (ci >= 3 && ci <= 5) ? cell.words : undefined,
        // Where the cell's text sits on the page image (pixels at OCR_SCALE), for the side-by-side view.
        _box: wordsBox(cell.words),
        // Keep cell boundary (PDF points) for empty-cell re-OCR.
        _cellBounds: (ci >= 3 && ci <= 5) ? {
          x:  colLefts[ci] ?? colLefts[colLefts.length - 1],
          x1: (ci < numCols - 1 ? colLefts[ci + 1] : maxRight),
          y:  rowTops[r],
          y1: (r  < numRows - 1 ? rowTops[r + 1]   : maxBottom),
        } : undefined,
      }));

      const hasContent = cells.some(c => c.value.trim() !== '');
      if (hasContent) rowsWithContent++;

      if (tableRows.length < 3) {
      }

      tableRows.push({ type: 'data', cells, page: parseInt(page) });
    }

  }

  log(`  Total: ${tableRows.length} rows × ${maxCols} columns across ${pages.length} pages`);

  return tableRows;
}

// ── Pipe-based extraction (scanned tables with visible borders) ──
async function pipeBasedExtract(ocrLines) {
  var rawRows = [];

  for (var li = 0; li < ocrLines.length; li++) {
    var line = ocrLines[li];
    var text = line.text;

    // Normalize bracket-like chars that Tesseract uses for |
    var normalized = text.replace(/[\[\]]/g, '|');
    var parts = normalized.split('|').map(function(p) { return p.trim(); });
    while (parts.length > 0 && parts[0] === '') parts.shift();
    while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();

    if (parts.length === 0) continue;

    // FIX: Split first cell if it starts with numbered pattern (e.g., "1. Xi mang" → ["1.", "Xi mang"])
    if (parts[0] && /^(\d+\.|\d+\))\s+/.test(parts[0])) {
      var match = parts[0].match(/^(\d+\.|\d+\))\s+(.+)$/);
      if (match) {
        parts.splice(0, 1, match[1], match[2]); // Replace first cell with [STT, content]
      }
    }

    rawRows.push({ parts: parts, page: line.page, text: text, confidence: line.confidence });
  }

  var TARGET_COLS = 6;
  var rows = [];

  for (var ri = 0; ri < rawRows.length; ri++) {
    var raw = rawRows[ri];
    var cellStrings = await assignToColumns(raw.parts);
    if (!cellStrings) continue;

    // Convert string cells to metadata objects
    // FIX Bug #7: Wrap each cell in try-catch to prevent single error from stopping extraction
    var cells = await Promise.all(cellStrings.map(async function(val, colIdx) {
      try {
        return await createCellMetadata(val, raw.confidence || 85, colIdx);
      } catch (error) {
        console.error('Cell correction failed for:', val, error);
        // Return fallback metadata for failed cell
        return {
          value: val,
          original: val,
          confidence: 50,
          source: 'error',
          correctedBy: 'Error - using original',
          type: classifyCellType(val, colIdx),
          edited: false
        };
      }
    }));

    var cellValues = cells.map(c => c.value);
    var rowType = classifyRow(cellValues, TARGET_COLS);
    if (rowType === 'header') continue;
    rows.push({ type: rowType, cells: cells, page: raw.page });
  }

  log('  Pipe parsing: ' + rows.length + ' rows before merge');
  return mergeMultiLineCells(rows, TARGET_COLS);
}

// Recognize Vietnamese units, including OCR-garbled variants
function matchUnit(s) {
  s = s.trim();
  // Clean common OCR substitutions before matching
  var cleaned = s.replace(/[Jj][lI1]/g, '').replace(/^[0-9]+\s*/, '');
  // Direct unit match
  if (/^(m[23]|md|kg|tấn|cái|bộ|lít|Bộ|ci|cil|hộp|con|chiếc|thanh|sợi|cuộn|bao|gói)$/i.test(s)) return true;
  // "100m3", "100m2", "1900m", etc. (number prefix + unit)
  if (/^\d+\s*m[23]?$/i.test(s)) return true;
  // OCR-garbled: "Ji99m3" → "100m3", "Jl00m3" → "100m3"
  if (/^[Jj][lI1i]\d{2}m[23]?$/i.test(s)) return true;
  return false;
}

// Map pipe-split parts into 6 columns: [STT, desc, unit, qty, price, total]
async function assignToColumns(parts) {
  var cells = ['', '', '', '', '', ''];
  if (parts.length === 0) return null;

  // Find the unit part (key anchor) — search from right to left
  var unitIdx = -1;
  for (var i = parts.length - 1; i >= 0; i--) {
    if (matchUnit(parts[i])) { unitIdx = i; break; }
  }

  // Also check if a unit is embedded at the END of a text part: "...Đấtcấp3 m3"
  if (unitIdx === -1) {
    for (var i = 0; i < parts.length; i++) {
      var m = parts[i].match(/\s+(m[23]|100\s*m[23]|kg|tấn|md|Bộ|ci)\s*$/i);
      if (m) {
        // Split the part: text before unit becomes desc, matched unit becomes unit
        var beforeUnit = parts[i].substring(0, parts[i].length - m[0].length).trim();
        var unitText = m[1];
        parts.splice(i, 1, beforeUnit, unitText);
        unitIdx = i + 1;
        break;
      }
    }
  }

  if (unitIdx >= 0 && unitIdx < parts.length - 1) {
    var descParts = parts.slice(0, unitIdx);
    var unit = parts[unitIdx];
    var numParts = parts.slice(unitIdx + 1);

    // Extract STT from desc parts
    var stt = '';
    if (descParts.length > 0) {
      var firstPart = descParts[0].trim();
      if (/^\d{1,3}$/.test(firstPart) && descParts.length > 1) {
        // STT is in its own pipe section
        stt = firstPart;
        descParts.shift();
      } else if (/^\d{1,3}$/.test(firstPart) && descParts.length === 1) {
        // Only a number, no description — STT only
        stt = firstPart;
        descParts[0] = '';
      } else {
        var sttMatch = firstPart.match(/^(\d{1,3})\s+(.*)/);
        if (sttMatch) { stt = sttMatch[1]; descParts[0] = sttMatch[2]; }
      }
    }

    cells[0] = stt;
    cells[1] = descParts.join(' ').trim(); // Use original OCR without correction
    cells[2] = unit;

    // Collect all numbers from remaining parts
    var nums = [];
    for (var j = 0; j < numParts.length; j++) {
      var cleaned = numParts[j].replace(/[())\]\\{}]/g, '').trim();
      if (!cleaned) continue;
      var subNums = cleaned.split(/\s+/).filter(function(s) { return /[\d]/.test(s); });
      nums.push.apply(nums, subNums);
    }

    if (nums.length >= 3) { cells[3] = nums[0]; cells[4] = nums[1]; cells[5] = nums[2]; }
    else if (nums.length === 2) { cells[3] = nums[0]; cells[5] = nums[1]; }
    else if (nums.length === 1) { cells[3] = nums[0]; }

  } else {
    // No unit found — try to salvage
    var fullText = parts.join(' ').trim();
    if (!fullText) return null;

    // Check for trailing numbers pattern: "description ... num num num"
    var trailingNums = fullText.match(/^(.+?)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s*$/);
    if (trailingNums) {
      cells[1] = trailingNums[1];
      cells[3] = trailingNums[2]; cells[4] = trailingNums[3]; cells[5] = trailingNums[4];
    } else if (parts.length >= 3) {
      // Multiple pipe parts but no unit — last parts might be numbers
      var lastParts = parts.slice(-3);
      var numericLast = lastParts.filter(function(p) { return /^[\d.,\-—()\s]+$/.test(p); }).length;
      if (numericLast >= 2) {
        var descEnd = parts.length - numericLast;
        cells[1] = parts.slice(0, descEnd).join(' ').trim();
        var numArr = parts.slice(descEnd);
        for (var k = 0; k < numArr.length && k < 3; k++) {
          cells[3 + k] = numArr[k].replace(/[()]/g, '').trim();
        }
      } else {
        cells[1] = fullText;
      }
    } else {
      // Pure text row — extract STT if present
      var sttMatch2 = fullText.match(/^[\(\[]?(\d{1,3})[\)\]]?\s+(.*)/);
      if (sttMatch2) { cells[0] = sttMatch2[1]; cells[1] = sttMatch2[2]; }
      else { cells[1] = fullText; }
    }
  }

  // Final pass: extract STT from description if not already set
  if (!cells[0] && cells[1]) {
    var sttFinal = cells[1].match(/^[\(\[]?(\d{1,3})[\)\]]?\s+(.*)/);
    if (sttFinal) { cells[0] = sttFinal[1]; cells[1] = sttFinal[2]; }
  }

  // Clean OCR artifacts in numeric columns
  for (var c = 3; c < 6; c++) {
    if (cells[c]) {
      cells[c] = cells[c].replace(/O/g, '0').replace(/[lI]/g, '1').replace(/[$#]/g, '').replace(/\s/g, '');
    }
  }

  return cells;
}

// ── Spatial extraction fallback (for cleaner OCR without pipe borders) ──
async function spatialExtract(filteredLines, filteredWords) {
  var colBoundaries = detectColumns(filteredWords, filteredLines);
  var numCols = colBoundaries.length - 1;
  log('  Column detection: ' + numCols + ' columns (spatial)');

  if (numCols < 2) {
    log('  Column detection failed, falling back to pipe-based splitting...', 'warn');
    return await pipeBasedExtract(filteredLines);
  }

  var rows = [];
  for (var li = 0; li < filteredLines.length; li++) {
    var line = filteredLines[li];
    var cellWords = new Array(numCols).fill(null).map(() => []);

    for (var wi = 0; wi < line.words.length; wi++) {
      var word = line.words[wi];
      var cx = (word.x + word.x1) / 2;
      var colIdx = findColumn(cx, colBoundaries);
      if (colIdx >= 0 && colIdx < numCols) {
        cellWords[colIdx].push(word);
      }
    }

    // Build cells with metadata
    // FIX Bug #7: Wrap each cell in try-catch to prevent single error from stopping extraction
    var cells = await Promise.all(cellWords.map(async function(words, colIdx) {
      try {
        return await buildCellWithMetadata(words, colIdx);
      } catch (error) {
        console.error('Cell metadata build failed:', words, error);
        // Return fallback metadata for failed cell
        const rawText = words.map(w => w.text).join(' ');
        return {
          value: rawText,
          original: rawText,
          confidence: 50,
          source: 'error',
          correctedBy: 'Error - using original',
          type: classifyCellType(rawText, colIdx),
          edited: false
        };
      }
    }));

    if (cells.every(function(c) { return c.value === ''; })) continue;

    // Clean OCR artifacts in numeric columns
    for (var c = 3; c < numCols; c++) {
      if (cells[c].value && /^[\dOol.,()\s-]+$/.test(cells[c].value)) {          // a number misread as letters; text keeps its spaces
        cells[c].value = cells[c].value.replace(/O/g, '0').replace(/l/g, '1').replace(/\s/g, '');
      }
    }

    // For classifyRow, extract values
    var cellValues = cells.map(c => c.value);
    rows.push({ type: classifyRow(cellValues, numCols), cells: cells, page: line.page });
  }

  return mergeMultiLineCells(rows, numCols);
}

function detectColumns(words, lines) {
  // Strategy 1: Header anchoring (look for header line + words in nearby Y-range)
  for (var i = 0; i < lines.length; i++) {
    var lineText = lines[i].text.toLowerCase();
    if ((/stt|\(1\)/).test(lineText) && (/mô\s*tả|công\s*việc|[đd]vt|đơn\s*vị/).test(lineText)) {
      log('  Header found: "' + lines[i].text.substring(0, 60) + '..."', 'ok');

      // FIX: Gather words from header region (±30px Y-range) to catch multi-line headers
      var headerY = lines[i].y;
      var headerWords = words.filter(function(w) {
        return Math.abs(w.y - headerY) < 30 && w.page === lines[i].page;
      });

      var sortedWords = headerWords.slice().sort(function(a, b) { return a.x - b.x; });
      if (sortedWords.length >= 4) {
        var boundaries = [sortedWords[0].x - 5];
        for (var j = 0; j < sortedWords.length - 1; j++) {
          if (sortedWords[j + 1].x - sortedWords[j].x1 > 10) {
            boundaries.push((sortedWords[j].x1 + sortedWords[j + 1].x) / 2);
          }
        }
        boundaries.push(sortedWords[sortedWords.length - 1].x1 + 20);

        // FIX: For 6-column tables, expect 7 boundaries. Fall back to histogram if < 7
        if (boundaries.length >= 7) {
          log('  Column boundaries (header): [' + boundaries.map(function(b) { return b.toFixed(0); }).join(', ') + ']');
          return boundaries;
        }
        log('  Header found but only ' + (boundaries.length - 1) + ' columns, trying histogram...', 'warn');
      }
    }
  }

  log('  Header not found or incomplete, using x-histogram gap detection', 'warn');
  return detectColumnsHistogram(words);
}

function detectColumnsHistogram(words) {
  var BIN_SIZE = 5;
  var maxX = Math.max.apply(null, words.map(function(w) { return w.x1; }));
  var bins = new Array(Math.ceil(maxX / BIN_SIZE) + 1).fill(0);

  words.forEach(function(w) {
    var bin = Math.floor(w.x / BIN_SIZE);
    if (bin >= 0 && bin < bins.length) bins[bin]++;
  });

  var threshold = Math.max.apply(null, bins) * 0.02;
  var gaps = [];
  var inGap = false, gapStart = 0;

  for (var i = 0; i < bins.length; i++) {
    if (bins[i] <= threshold) {
      if (!inGap) { inGap = true; gapStart = i; }
    } else {
      if (inGap && (i - gapStart) >= 2) gaps.push((gapStart + i) / 2 * BIN_SIZE);
      inGap = false;
    }
  }

  var leftEdge = Math.min.apply(null, words.map(function(w) { return w.x; })) - 5;
  var rightEdge = maxX + 20;
  var boundaries = [leftEdge].concat(gaps, [rightEdge]).sort(function(a, b) { return a - b; });

  log('  Column boundaries (histogram): [' + boundaries.map(function(b) { return b.toFixed(0); }).join(', ') + ']');
  return boundaries;
}

function findColumn(x, boundaries) {
  for (var i = 0; i < boundaries.length - 1; i++) {
    if (x >= boundaries[i] && x < boundaries[i + 1]) return i;
  }
  return boundaries.length - 2;
}

function classifyRow(cells, numCols) {
  var stt = cells[0] || '';
  var desc = cells[1] || '';
  var unit = cells[2] || '';
  var nonEmpty = cells.filter(function(c) { return c !== ''; }).length;
  var hasNumericData = cells.slice(3).some(function(c) { return c && /[\d]/.test(c); });

  // Header patterns (column headers)
  if (/^stt$/i.test(stt) || /^\(1\)$/.test(stt)) return 'header';
  if (/^stt$/i.test(desc) || /HÀNG\s*MỤC|MÔ\s*TẢ/i.test(desc)) return 'header';

  // Pre-table content (document titles, metadata) — matches both diacritics and without
  if (/CỘNG\s*H[OÒÕ]À|Độc\s*lập|BI[ÊE]U\s*GI[AÁ]|Đính\s*kèm|dự\s*án|Hợp\s*đồng\s*số|thầu/i.test(desc)) return 'header';
  if (/^đồng\s+đồng$/i.test(desc.trim())) return 'header';
  // Street/area section headers
  if (/H[ÊEẺ]M\s*\d+|CONG\s*TR[ƯU][ỜO]NG\s*QU[ỐO]C/i.test(desc) && !hasNumericData) return 'section';
  // "ĐƯỜNG NGUYỄN ĐÌNH CHIỂU" / "LDUONGNGUYENDINH" — street name headers
  if (/^L?[ĐD]?[ƯU]?[ỜO]?NG\s*NGUY[ÊE]N|PH[ƯU][ỜO]NG\s*[A-Z]/i.test(desc) && !hasNumericData) return 'section';
  // Broad: all-caps sections starting with PHAN (PHẦN)
  if (/^PH[AÀẢ]N\s*(T[AÁ]I|L[AÁ]P|[ĐD][ÀA]O)/i.test(desc)) return 'section';

  // Garbage detection: high ratio of non-alphanumeric chars → skip
  var alphaNum = (desc.match(/[a-zA-ZÀ-ỹ0-9\s.,()]/g) || []).length;
  var garbageRatio = 1 - (alphaNum / (desc.length || 1));

  // Skip garbled text-only rows (no unit, no numbers, lots of garbage)
  if (!unit && !hasNumericData && desc.length > 15 && garbageRatio > 0.25) return 'header';
  // Short garbled fragments with no data
  if (!unit && !hasNumericData && desc.length < 15 && nonEmpty <= 2) return 'header';
  // Long text-only rows with no structure — likely garbled OCR noise
  if (!unit && !hasNumericData && !stt && desc.length > 40) return 'header';

  // Section headers: clear Vietnamese section patterns only
  if (/PHẦN\s*(LẮP|ĐẶT|TÁI|ĐÀO)/i.test(desc) && !hasNumericData) return 'section';
  if (/^\d+\.\s*ĐƯỜNG/i.test(desc) && !hasNumericData) return 'section';
  if (/TÁI\s*LẬP\s*MẶT\s*ĐƯỜNG/i.test(desc) && !hasNumericData) return 'section';
  if (/ĐƯỜNG.*PHƯỜNG/i.test(desc) && !hasNumericData) return 'section';
  if (/TÁI\s*LẬP\s*(GẠCH|LÈ)/i.test(desc) && !hasNumericData) return 'section';

  // Data rows should have at least a unit or some numbers
  if (!unit && !hasNumericData && !stt) {
    // Text only, no structure — might be garbled section or noise
    if (desc.length > 40) return 'header';
    return 'data';
  }

  return 'data';
}

function mergeMultiLineCells(rows, numCols) {
  var merged = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (row.type === 'header') continue;

    // Handle both string cells (legacy) and object cells (metadata)
    var getVal = function(cell) { return typeof cell === 'string' ? cell : (cell ? cell.value : ''); };

    var stt = getVal(row.cells[0]).trim();
    var desc = getVal(row.cells[1]);
    var hasSTT = /^\d{1,3}$/.test(stt);
    var hasUnit = row.cells[2] && getVal(row.cells[2]).trim();
    var hasNumeric = row.cells.slice(3).some(function(c) { return c && /\d/.test(getVal(c)); });

    // A continuation line: no STT, no unit, no numeric data, short desc, and previous row exists
    var isContLine = !hasSTT && !hasUnit && !hasNumeric && desc.length < 120;
    // Don't merge section rows
    if (row.type === 'section') isContLine = false;

    if (isContLine && merged.length > 0 && merged[merged.length - 1].type === 'data') {
      var prev = merged[merged.length - 1];
      // Only merge if it looks like a genuine continuation (same page, desc is reasonable)
      if (row.page === prev.page && desc.length < 80) {
        // Merge description cells
        if (typeof prev.cells[1] === 'object' && typeof row.cells[1] === 'object') {
          prev.cells[1].value = (prev.cells[1].value + ' ' + row.cells[1].value).trim();
        } else {
          prev.cells[1] = (getVal(prev.cells[1]) + ' ' + desc).trim();
        }
        for (var c = 2; c < numCols; c++) {
          if (row.cells[c] && !getVal(prev.cells[c])) prev.cells[c] = row.cells[c];
        }
        continue;
      }
    }

    merged.push({ type: row.type, cells: row.cells.slice(), page: row.page });
  }

  return merged;
}

