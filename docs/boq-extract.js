// boq-extract.js — table extraction: lattice, OCR, spatial, clustering
'use strict';

// Map OCR words to detected cells
function mapWordsToCells(ocrWords, cells) {
  console.log(`[mapWordsToCells] Mapping ${ocrWords.length} words to ${cells.length} cells...`);
  const startTime = performance.now();

  const cellData = cells.map(cell => ({
    ...cell,
    words: [],
    text: '',
    confidence: 0,
    ocrWordCount: 0
  }));

  console.log(`[mapWordsToCells] Cell data initialized, starting word mapping loop...`);

  let wordCount = 0;
  let wordsAssigned = 0;
  let fallbackAssigned = 0;
  let tier1Count = 0;

  // Debug: Log first word and first cell to check coordinates
  if (ocrWords.length > 0 && cells.length > 0) {
    const firstWord = ocrWords[0];
    const firstCell = cells[0];
    console.log(`[mapWordsToCells] First word: "${firstWord.text}" at (${firstWord.x.toFixed(1)}, ${firstWord.y.toFixed(1)}) - (${firstWord.x1.toFixed(1)}, ${firstWord.y1.toFixed(1)})`);
    console.log(`[mapWordsToCells] First cell: at (${firstCell.x}, ${firstCell.y}) size ${firstCell.width}×${firstCell.height}`);
  }

  // CRITICAL FIX: Track orphan words for formula row reconstruction
  const orphanWords = [];

  for (const word of ocrWords) {
    wordCount++;

    // Heartbeat every 50 words
    if (wordCount % 50 === 0) {
      console.log(`[mapWordsToCells] Processed ${wordCount}/${ocrWords.length} words (${((wordCount/ocrWords.length)*100).toFixed(1)}%), ${wordsAssigned} assigned`);
    }

    // OCR words have x, y, x1, y1 properties directly (no nested bbox)
    const wordBbox = { x0: word.x, y0: word.y, x1: word.x1, y1: word.y1 };
    const wordCenterX = (word.x + word.x1) / 2;
    const wordCenterY = (word.y + word.y1) / 2;

    let bestCell = null;
    let bestOverlap = 0;

    for (const cell of cellData) {
      // ULTRA-AGGRESSIVE MATCHING: overlap with expanded bounds, no per-iteration allocations
      const ex = cell.x - CELL_MATCH_MARGIN_PX;
      const ey = cell.y - CELL_MATCH_MARGIN_PX;
      const ex1 = cell.x + cell.width  + CELL_MATCH_MARGIN_PX;
      const ey1 = cell.y + cell.height + CELL_MATCH_MARGIN_PX;

      // Inline overlap calculation (avoids object allocation)
      const ox1 = Math.max(wordBbox.x0, ex);
      const oy1 = Math.max(wordBbox.y0, ey);
      const ox2 = Math.min(wordBbox.x1, ex1);
      const oy2 = Math.min(wordBbox.y1, ey1);
      const overlap = (ox2 > ox1 && oy2 > oy1) ? (ox2 - ox1) * (oy2 - oy1) : 0;

      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestCell = cell;
      }
    }

    if (bestCell) {
      bestCell.words.push(word);
      bestCell.ocrWordCount++;
      wordsAssigned++;
      tier1Count++;
    } else {
      // No overlap — treat as orphan (nearest-cell fallback dropped: caused wrong-column assignment)
      orphanWords.push(word);
      if (orphanWords.length <= 5) {
        console.log(`[mapWordsToCells] Orphan #${orphanWords.length}: "${word.text}" at (${word.x.toFixed(1)}, ${word.y.toFixed(1)})`);
      }
    }
  }

  console.log(`[mapWordsToCells] Word assignment complete: ${wordsAssigned}/${ocrWords.length} words assigned to cells, ${orphanWords.length} orphan words`);

  // DEBUG: Show coordinate ranges for cells vs words (use reduce — safe for large arrays)
  if (cellData.length > 0 && ocrWords.length > 0) {
    let cellMinX = Infinity, cellMaxX = -Infinity, cellMinY = Infinity, cellMaxY = -Infinity;
    for (const c of cellData) {
      if (c.x < cellMinX) cellMinX = c.x;
      if (c.x + c.width  > cellMaxX) cellMaxX = c.x + c.width;
      if (c.y < cellMinY) cellMinY = c.y;
      if (c.y + c.height > cellMaxY) cellMaxY = c.y + c.height;
    }
    let wordMinX = Infinity, wordMaxX = -Infinity, wordMinY = Infinity, wordMaxY = -Infinity;
    for (const w of ocrWords) {
      if (w.x  < wordMinX) wordMinX = w.x;
      if (w.x1 > wordMaxX) wordMaxX = w.x1;
      if (w.y  < wordMinY) wordMinY = w.y;
      if (w.y1 > wordMaxY) wordMaxY = w.y1;
    }

    console.log(`[mapWordsToCells] Cell bounds: X[${cellMinX.toFixed(1)} - ${cellMaxX.toFixed(1)}], Y[${cellMinY.toFixed(1)} - ${cellMaxY.toFixed(1)}]`);
    console.log(`[mapWordsToCells] Word bounds: X[${wordMinX.toFixed(1)} - ${wordMaxX.toFixed(1)}], Y[${wordMinY.toFixed(1)} - ${wordMaxY.toFixed(1)}]`);

    const xOverlap = !(cellMaxX < wordMinX || wordMaxX < cellMinX);
    const yOverlap = !(cellMaxY < wordMinY || wordMaxY < cellMinY);
    console.log(`[mapWordsToCells] Coordinate overlap: X=${xOverlap}, Y=${yOverlap}`);

    if (!xOverlap || !yOverlap) {
      console.error(`[mapWordsToCells] ⚠️ CRITICAL: Cells and words don't overlap! Coordinate system mismatch!`);
    }
  }

  console.log(`[mapWordsToCells] Word mapping complete, building cell text...`);

  // ── Stacking diagnostic: find cells whose words span multiple Y-bands ──
  // For each such cell, log whether the words are inside the cell bbox or
  // being pulled in from outside by the CELL_MATCH_MARGIN_PX expansion.
  {
    const cellHeights = cellData.filter(c => c.words.length > 0).map(c => c.height).sort((a,b)=>a-b);
    const medH = cellHeights.length ? cellHeights[Math.floor(cellHeights.length/2)] : 0;
    let multibandCount = 0;

    for (const cell of cellData) {
      if (cell.words.length < 2) continue;
      const sorted = cell.words.slice().sort((a,b) => a.y - b.y);
      let bands = 1, lastAnchor = sorted[0].y;
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].y - lastAnchor > ROW_Y_THRESHOLD_PX) { bands++; lastAnchor = sorted[i].y; }
      }
      if (bands < 2) continue;
      multibandCount++;

      // For first 3 multi-band cells: log cell geometry vs word positions
      if (multibandCount <= 3) {
        const ySpread = sorted[sorted.length-1].y - sorted[0].y;
        const cellBottom = cell.y + cell.height;
        // How many words are OUTSIDE the raw cell bbox (only inside because of margin)?
        const outsideCell = sorted.filter(w => w.y < cell.y || w.y1 > cellBottom);
        console.log(
          `[stacking] cell(${cell.x.toFixed(0)},${cell.y.toFixed(0)}) `+
          `size=${cell.width.toFixed(0)}×${cell.height.toFixed(0)} `+
          `bands=${bands} ySpread=${ySpread.toFixed(0)}pt `+
          `wordsBeyondCellEdge=${outsideCell.length}/${sorted.length} `+
          `words: ${sorted.map(w=>`"${w.text}"@y${w.y.toFixed(0)}`).join(' | ')}`
        );
      }
    }

    // Surface counts to in-page log (via borderBasedExtract's log call)
    console.log(`[stacking] medianCellHeight=${medH.toFixed(1)}pt margin=${CELL_MATCH_MARGIN_PX}pt multibandCells=${multibandCount}`);
    // Store on cell data array so borderBasedExtract can log it
    cellData._stacking = { medH, multibandCount };
  }

  // Build text for each cell
  let cellsWithWords = 0;
  let cellsWithoutWords = 0;

  for (const cell of cellData) {
    if (cell.words.length > 0) {
      cellsWithWords++;

      // Sort words: top-to-bottom, then left-to-right
      // OCR words have x, y properties directly (no bbox)
      cell.words.sort((a, b) => {
        const yDiff = a.y - b.y;
        return Math.abs(yDiff) < 5 ? a.x - b.x : yDiff;
      });

      cell.text = cell.words.map(w => w.text).join(' ').trim();
      cell.confidence = cell.words.reduce((sum, w) => sum + w.confidence, 0) / cell.words.length;

      // Debug: log first few cells with content
      if (cellsWithWords <= 5) {
        console.log(`[mapWordsToCells] Cell ${cellsWithWords} has ${cell.words.length} words: "${cell.text}"`);
      }
    } else {
      cellsWithoutWords++;
    }
  }

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
  console.log(`[mapWordsToCells] Completed in ${elapsed}s: ${cellsWithWords} cells with words, ${cellsWithoutWords} cells empty`);

  // CRITICAL: Return both cell data and orphan words for formula row reconstruction
  return { cellData, orphanWords, tier1Count, tier2Count: fallbackAssigned, tier3Count: orphanWords.length };
}

function calculateBboxOverlap(wordBbox, cell) {
  const x1 = Math.max(wordBbox.x0, cell.x);
  const y1 = Math.max(wordBbox.y0, cell.y);
  const x2 = Math.min(wordBbox.x1, cell.x + cell.width);
  const y2 = Math.min(wordBbox.y1, cell.y + cell.height);

  if (x2 < x1 || y2 < y1) return 0;
  return (x2 - x1) * (y2 - y1);
}

// Reconstruct table grid from cells
function reconstructTableGrid(cellData) {
  console.log(`[reconstructTableGrid] Starting with ${cellData.length} cells`);
  if (cellData.length === 0) return { rows: [], cols: 0 };

  const t0 = performance.now();

  // CRITICAL: Count cells with text before reconstruction
  const cellsWithText = cellData.filter(c => c.text && c.text.trim().length > 0).length;
  console.log(`[reconstructTableGrid] Input: ${cellsWithText}/${cellData.length} cells have text (${((cellsWithText/cellData.length)*100).toFixed(1)}%)`);

  const sortedCells = cellData.slice().sort((a, b) => {
    const yDiff = a.y - b.y;
    return Math.abs(yDiff) < 10 ? a.x - b.x : yDiff;
  });
  console.log(`[reconstructTableGrid] Sorted cells in ${(performance.now()-t0).toFixed(0)}ms`);

  const rows = [];
  let currentRow = [];
  let lastY = sortedCells[0].y;
  const ROW_Y_THRESHOLD = 10; // pixels tolerance for same row

  for (const cell of sortedCells) {
    if (Math.abs(cell.y - lastY) > ROW_Y_THRESHOLD) {
      if (currentRow.length > 0) {
        currentRow.sort((a, b) => a.x - b.x);
        rows.push(currentRow);
        currentRow = [];
      }
      lastY = cell.y;
    }
    currentRow.push(cell);
  }

  if (currentRow.length > 0) {
    currentRow.sort((a, b) => a.x - b.x);
    rows.push(currentRow);
  }

  const maxCols = rows.reduce((max, r) => r.length > max ? r.length : max, 0);

  // DEBUG: Count rows with any text
  const rowsWithText = rows.filter(row => row.some(cell => cell.text && cell.text.trim().length > 0)).length;
  console.log(`[reconstructTableGrid] Created ${rows.length} rows × ${maxCols} columns in ${(performance.now()-t0).toFixed(0)}ms`);
  console.log(`[reconstructTableGrid] ${rowsWithText}/${rows.length} rows have text (${((rowsWithText/rows.length)*100).toFixed(1)}%)`);

  return { rows, cols: maxCols };
}


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

// ── Fallback: Text Clustering ──
async function textClusterExtract(textItems) {
  log('Text clustering: grouping by Y coordinate...', 'warn');
  const rows = [];

  // Group by page, then by Y clusters
  const byPage = {};
  textItems.forEach(t => { (byPage[t.page] = byPage[t.page] || []).push(t); });

  for (const [page, items] of Object.entries(byPage)) {
    const yVals = cluster(items.map(t => t.y), 4);

    for (let i = 0; i < yVals.length - 1; i++) {
      const yTop = yVals[i], yBot = (i < yVals.length - 1) ? yVals[i + 1] : yTop + 20;
      const rowItems = items.filter(t => t.y >= yTop - 2 && t.y < yBot - 2);
      if (rowItems.length === 0) continue;

      rowItems.sort((a, b) => a.x - b.x);
      const text = rowItems.map(t => t.str).join(' ').trim();
      if (!text) continue;

      // Check if this line has pipe separators (table data)
      if (text.includes('|')) {
        const parts = text.split('|').map(p => p.trim()).filter(p => p);
        if (parts.length >= 2) {
          // FIX: Split first cell if it starts with numbered pattern (e.g., "1. Xi mang" → ["1.", "Xi mang"])
          // This handles PDFs where STT column is not pipe-separated from content
          const cells = [...parts];
          if (cells[0] && /^(\d+\.|\d+\))\s+/.test(cells[0])) {
            const match = cells[0].match(/^(\d+\.|\d+\))\s+(.+)$/);
            if (match) {
              cells.splice(0, 1, match[1], match[2]); // Replace first cell with [STT, content]
            }
          }

          rows.push({ type: 'data', cells: cells, page: +page });
          continue;
        }
      }

      // Otherwise single column - use original text
      try {
        rows.push({ type: 'data', cells: [text], page: +page });
      } catch (error) {
        console.error('Text parsing failed:', text, error);
        rows.push({ type: 'data', cells: [text], page: +page }); // Fallback to original
      }
    }
  }
  return rows;
}

// ── OCR Table Extraction ──
async function ocrTableExtract(ocrLines, ocrWords, borderCells = [], pageCanvases = {}) {
  console.log(`[ocrTableExtract] ENTRY: ${ocrWords.length} words, ${ocrLines.length} lines, ${borderCells.length} borderCells`);
  const extractStart = performance.now();

  // Filter margin content (headers/footers in top/bottom 5%)
  const pageHeights = {};
  ocrWords.forEach(w => {
    pageHeights[w.page] = Math.max(pageHeights[w.page] || 0, w.y1);
  });

  console.log(`[ocrTableExtract] Page heights calculated: ${Object.keys(pageHeights).length} pages`);

  // If border cells detected, use border-based extraction
  // Require at least 20 cells to consider it a valid table grid
  if (borderCells.length >= 20) {
    log(`Using BORDER-BASED extraction (${borderCells.length} cells detected)`, 'ok');
    console.log(`[ocrTableExtract] Calling borderBasedExtract...`);
    const result = await borderBasedExtract(ocrWords, borderCells, pageCanvases);
    console.log(`[ocrTableExtract] borderBasedExtract returned ${result.length} rows in ${(performance.now()-extractStart).toFixed(0)}ms`);
    return result;
  } else if (borderCells.length > 0) {
    log(`Border detection found only ${borderCells.length} cells, falling back to text-based extraction`, 'warn');
  }

  console.log(`[ocrTableExtract] Checking for pipe-based extraction...`);

  const filteredLines = ocrLines.filter(l => {
    const ph = pageHeights[l.page] || 800;
    return l.y > ph * 0.05 && l.y1 < ph * 0.95;
  });

  // Check if pipe characters are prevalent (table borders recognized as |)
  const pipeCount = filteredLines.filter(l => (l.text.match(/[|\[\]]/g) || []).length >= 2).length;
  const pipeRatio = pipeCount / filteredLines.length;
  log(`  Pipe-delimited lines: ${pipeCount}/${filteredLines.length} (${(pipeRatio * 100).toFixed(0)}%)`);

  if (pipeRatio > 0.25) {
    log('Using PIPE-BASED parsing (table borders detected in OCR)', 'ok');
    const correctionType = vpsApiAvailable ? 'VPS API (94%)' : (syllableCorrector && syllableCorrector.ready ? 'dict + syllable' : 'dict only');
    log(`  Applying Vietnamese spell correction (${correctionType})...`, 'ok');
    return await pipeBasedExtract(filteredLines);
  }

  // Fallback: spatial word-position analysis
  log('Using SPATIAL parsing (word positions)', 'ok');
  const correctionType2 = vpsApiAvailable ? 'VPS API (94%)' : (syllableCorrector && syllableCorrector.ready ? 'dict + syllable' : 'dict only');
  log(`  Applying Vietnamese spell correction (${correctionType2})...`, 'ok');
  const filteredWords = ocrWords.filter(w => {
    const ph = pageHeights[w.page] || 800;
    return w.y > ph * 0.05 && w.y1 < ph * 0.95;
  });
  return await spatialExtract(filteredLines, filteredWords);
}

// Reconstruct formula rows from orphan words (words outside table borders)
function reconstructFormulaRows(orphanWords, numCols) {
  if (orphanWords.length === 0) return [];
  if (numCols < 2) {
    console.warn(`[reconstructFormulaRows] numCols=${numCols} < 2, cannot build formula rows — skipping`);
    return [];
  }

  console.log(`[reconstructFormulaRows] Processing ${orphanWords.length} orphan words (numCols=${numCols})`);

  // Group words by Y-coordinate (same visual row)
  // Update currentY on each addition to handle multi-line OCR bboxes in same row
  const rowGroups = [];
  const sortedWords = orphanWords.slice().sort((a, b) => a.y - b.y);

  let currentGroup = [sortedWords[0]];
  let currentY = sortedWords[0].y;

  for (let i = 1; i < sortedWords.length; i++) {
    const word = sortedWords[i];
    if (Math.abs(word.y - currentY) < ROW_Y_THRESHOLD_PX) {
      currentGroup.push(word);
      currentY = word.y; // update so drifting multi-line words stay in group
    } else {
      rowGroups.push(currentGroup);
      currentGroup = [word];
      currentY = word.y;
    }
  }
  rowGroups.push(currentGroup);

  console.log(`[reconstructFormulaRows] Grouped into ${rowGroups.length} candidate rows`);

  const formulaRows = [];

  for (const group of rowGroups) {
    group.sort((a, b) => a.x - b.x);

    const rawText     = group.map(w => w.text).join(' ').trim();
    const description = rawText;

    // Formula detection: only match clear summary-row patterns, not data specs like D=100 or K=0.98
    const isFormula = /^[AB]\s*=|Tổng\s*cộng|Tong\s*cong/i.test(rawText.trimStart());

    if (!isFormula && rawText.length < 10) {
      console.log(`[reconstructFormulaRows] Skip short noise: "${rawText}"`);
      continue;
    }

    // Extract trailing number (must start with a digit to avoid alphanumeric codes)
    const numberMatch = rawText.match(/(\d[\d.,]*)\s*$/);
    const number      = numberMatch ? numberMatch[1] : '';
    const descText    = number
      ? rawText.slice(0, rawText.lastIndexOf(number)).trim()
      : description;

    // Cell height from actual word bboxes (no spread — safe for any group size)
    let minY = group[0].y, maxY = group[0].y1;
    for (const w of group) {
      if (w.y  < minY) minY = w.y;
      if (w.y1 > maxY) maxY = w.y1;
    }
    const avgConf = group.reduce((s, w) => s + w.confidence, 0) / group.length;

    const row = [];
    for (let i = 0; i < numCols; i++) {
      if (i === 1) {
        row.push({ text: descText, confidence: avgConf, words: group,
          x: group[0].x, y: minY, width: group[group.length - 1].x1 - group[0].x, height: maxY - minY });
      } else if (i === numCols - 1 && number) {
        row.push({ text: number, confidence: avgConf, words: [],
          x: group[group.length - 1].x1, y: minY, width: 0, height: maxY - minY });
      } else {
        row.push({ text: '', confidence: 0, words: [], x: 0, y: minY, width: 0, height: maxY - minY });
      }
    }

    console.log(`[reconstructFormulaRows] Row: "${descText}" | total: "${number}"`);
    formulaRows.push(row);
  }

  return formulaRows;
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

  // Build text for each non-empty cell (words sorted left-to-right)
  for (const row of grid) {
    for (const cell of row) {
      if (cell.words.length > 0) {
        cell.words.sort((a, b) => a.x - b.x);
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

  console.log(`[wordGridExtract] ${pageWords.length} words → ${numRows}r × ${numCols}c (assigned=${assigned} skipped=${skipped}) colLefts=[${colLefts.map(x=>x.toFixed(1)).join(',')}] maxRight=${maxRight.toFixed(1)}`);
  return { grid, numRows, numCols, colLefts, rowTops, maxRight, maxBottom };
}

// ── Per-cell re-OCR for garbage numeric cells ────────────────────────────────
// Crop the bounding box of words in a numeric cell, zoom 2×, and re-send to
// the OCR server.  Returns the joined text of all detected words, or ''.
async function reOcrCellRegion(canvas, words) {
  if (!words || words.length === 0) return '';
  // Compute union bbox of all words (in PDF points → convert to canvas pixels)
  const xs  = words.map(w => w.x  * OCR_SCALE);
  const xs1 = words.map(w => w.x1 * OCR_SCALE);
  const ys  = words.map(w => w.y  * OCR_SCALE);
  const ys1 = words.map(w => w.y1 * OCR_SCALE);
  const pad = 6;   // pixels of padding around the region
  const sx  = Math.max(0, Math.floor(Math.min(...xs))  - pad);
  const sy  = Math.max(0, Math.floor(Math.min(...ys))  - pad);
  const ex  = Math.min(canvas.width,  Math.ceil(Math.max(...xs1)) + pad);
  const ey  = Math.min(canvas.height, Math.ceil(Math.max(...ys1)) + pad);
  const sw  = ex - sx;
  const sh  = ey - sy;
  if (sw < 4 || sh < 4) return '';

  // Draw cropped region at 2× zoom into a temp canvas
  const crop = document.createElement('canvas');
  crop.width  = sw * 2;
  crop.height = sh * 2;
  crop.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw * 2, sh * 2);

  // Send to OCR server
  const blob = await new Promise(res => crop.toBlob(res, 'image/png'));
  const b64  = await new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload  = () => res(reader.result.split(',')[1]);
    reader.onerror = rej;
    reader.readAsDataURL(blob);
  });
  const resp = await fetch(`${OCR_SERVER_URL}/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ image: b64, page: 0 }),
    signal: AbortSignal.timeout(15000),
  });
  if (resp.status === 401) { clearAuthToken(); return ''; }
  if (!resp.ok) return '';
  const data = await resp.json();
  return (data.words || []).map(w => w.text).join(' ').trim();
}

// Scan all table rows; for each numeric cell (cols 3–5) where parseVnNumber
// returns null but the value contains digits, attempt re-OCR.
async function reOcrGarbageCells(tableRows, pageCanvases) {
  let fixed = 0, checked = 0;
  for (const row of tableRows) {
    if (!row.cells || row.cells.length < 6) continue;
    const canvas = pageCanvases[row.page];
    if (!canvas) continue;

    for (const ci of [3, 4, 5]) {
      const cell = row.cells[ci];
      if (!cell._words || cell._words.length === 0) continue;
      const val = cell.value || '';
      if (parseVnNumber(val) !== null) continue;    // already parseable
      if (!/\d/.test(val)) continue;                // no digits → not garbled

      checked++;
      console.log(`[reOcrGarbage] checking col${ci} val="${val}" page=${row.page} words=${cell._words.length}`);
      // Garbled: has digits but can't parse. Re-OCR the word region.
      try {
        const newText = await reOcrCellRegion(canvas, cell._words);
        console.log(`[reOcrGarbage] col${ci} reOcr result="${newText}" parseable=${parseVnNumber(newText)}`);
        if (newText && parseVnNumber(newText) !== null) {
          console.log(`[reOcrGarbage] col${ci} old="${val}" → new="${newText}"`);
          cell.value       = newText;
          cell.correctedBy = 'reocr-garbage';
          fixed++;
        }
      } catch (e) {
        console.warn(`[reOcrGarbage] col${ci} failed: ${e.message}`);
      }
    }
  }
  console.log(`[reOcrGarbage] checked=${checked} fixed=${fixed}`);
  return fixed;
}

// Re-OCR empty numeric cells using the known cell boundary + border padding.
// Fixes digits pressed against cell borders that PaddleOCR misses in full-page scan.
// Experiment confirmed: 15px padding into borders recovers all 5 page-1 error cells
// (including "22"→"2" misread) with 100% accuracy at 2× zoom.
async function reOcrEmptyCells(tableRows, pageCanvases) {
  // 50px padding needed for pdf.js rendering — PaddleOCR requires enough
  // surrounding context to trigger text detection on near-border digits.
  const BORDER_PAD_PX = 50;
  let fixed = 0, checked = 0;

  for (const row of tableRows) {
    if (!row.cells || row.cells.length < 6) continue;
    const canvas = pageCanvases[row.page];
    if (!canvas) continue;

    for (const ci of [3, 4, 5]) {
      const cell = row.cells[ci];
      if (!cell._cellBounds) continue;
      if (cell.value !== '') continue;   // only attempt empty cells

      // Only re-OCR if the price column (col 4) has a value — this filters out
      // blank spacer rows where all numeric cells are empty.
      if (ci === 3 && !row.cells[4].value) continue;
      if (ci === 4 && !row.cells[3].value && !row.cells[5].value) continue;
      if (ci === 5 && !row.cells[4].value) continue;

      const { x, x1, y, y1 } = cell._cellBounds;
      const sx = Math.max(0,             Math.floor(x  * OCR_SCALE) - BORDER_PAD_PX);
      const ex = Math.min(canvas.width,  Math.ceil( x1 * OCR_SCALE) + BORDER_PAD_PX);
      const sy = Math.max(0,             Math.floor(y  * OCR_SCALE) - BORDER_PAD_PX);
      const ey = Math.min(canvas.height, Math.ceil( y1 * OCR_SCALE) + BORDER_PAD_PX);
      const sw = ex - sx, sh = ey - sy;
      if (sw < 4 || sh < 4) continue;

      checked++;
      try {
        const crop = document.createElement('canvas');
        crop.width  = sw;   // no 2x zoom — 400 DPI is sufficient for PaddleOCR
        crop.height = sh;
        crop.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

        const blob = await new Promise(res => crop.toBlob(res, 'image/png'));
        const b64  = await new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload  = () => res(reader.result.split(',')[1]);
          reader.onerror = rej;
          reader.readAsDataURL(blob);
        });
        const resp = await fetch(`${OCR_SERVER_URL}/ocr`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ image: b64, page: 0 }),
          signal: AbortSignal.timeout(15000),
        });
        if (resp.status === 401) { clearAuthToken(); break; }
        if (!resp.ok) continue;
        const data = await resp.json();
        const words = data.words || [];
        // Compute the target cell's pixel bounds within the crop.
        // Word detections outside this range come from adjacent rows/columns.
        const cellPixW = Math.ceil((x1 - x) * OCR_SCALE);
        const cellPixH = Math.ceil((y1 - y) * OCR_SCALE);
        const cxMin = BORDER_PAD_PX, cxMax = BORDER_PAD_PX + cellPixW;
        const cyMin = BORDER_PAD_PX, cyMax = BORDER_PAD_PX + cellPixH;
        const inCell = words.filter(w => {
          const cx = (w.bbox[0] + w.bbox[2]) / 2;
          const cy = (w.bbox[1] + w.bbox[3]) / 2;
          return cx >= cxMin - 8 && cx <= cxMax + 8
              && cy >= cyMin - 8 && cy <= cyMax + 8;
        });
        // Accept only single in-cell word to avoid ambiguous multi-digit reads.
        if (inCell.length !== 1) continue;
        const newText = inCell[0].text.trim();
        if (newText && parseVnNumber(newText) !== null) {
          console.log(`[reOcrEmpty] col${ci} page=${row.page} "" → "${newText}"`);
          cell.value       = newText;
          cell.correctedBy = 'reocr-empty';
          fixed++;
        }
      } catch (e) {
        console.warn(`[reOcrEmpty] col${ci} failed: ${e.message}`);
      }
    }
  }
  console.log(`[reOcrEmpty] checked=${checked} fixed=${fixed}`);
  return fixed;
}

// Re-OCR empty numeric cells using ONNX recognition directly on cell crops.
// Skips detection entirely — we already know cell bounds from OpenCV borders.
// This avoids border-line false positives, hallucinated text, and adjacent cell bleed.
async function reOcrEmptyCellsOnnx(tableRows, pageCanvases) {
  // Inset: crop INSIDE cell bounds to avoid border lines (in canvas pixels)
  const BORDER_INSET_PX = 4;
  let fixed = 0, checked = 0;

  for (const row of tableRows) {
    if (!row.cells || row.cells.length < 6) continue;
    const canvas = pageCanvases[row.page];
    if (!canvas) continue;

    for (const ci of [3, 4, 5]) {
      const cell = row.cells[ci];
      if (!cell._cellBounds) continue;
      if (cell.value !== '') continue;

      // Same adjacency filter as server version
      if (ci === 3 && !row.cells[4].value) continue;
      if (ci === 4 && !row.cells[3].value && !row.cells[5].value) continue;
      if (ci === 5 && !row.cells[4].value) continue;

      // Crop INSIDE the cell (inset to skip border lines)
      const { x, x1, y, y1 } = cell._cellBounds;
      const sx = Math.floor(x  * OCR_SCALE) + BORDER_INSET_PX;
      const ex = Math.ceil( x1 * OCR_SCALE) - BORDER_INSET_PX;
      const sy = Math.floor(y  * OCR_SCALE) + BORDER_INSET_PX;
      const ey = Math.ceil( y1 * OCR_SCALE) - BORDER_INSET_PX;
      const sw = ex - sx, sh = ey - sy;
      if (sw < 4 || sh < 4) continue;

      checked++;
      try {
        // Run recognition directly — no detection needed
        const rec = await reOcrCropOnnx(canvas, sx, sy, sw, sh);
        const newText = (rec.text || '').trim();
        if (newText && parseVnNumber(newText) !== null) {
          console.log(`[reOcrEmptyOnnx] col${ci} page=${row.page} "" → "${newText}" (conf=${(rec.confidence*100).toFixed(0)}%)`);
          cell.value = newText;
          cell.correctedBy = 'reocr-empty-onnx';
          cell.confidence = rec.confidence * 100;
          fixed++;
        }
      } catch (e) {
        console.warn(`[reOcrEmptyOnnx] col${ci} failed: ${e.message}`);
      }
    }
  }
  log(`  Re-OCR (ONNX): recovered ${fixed} empty cells (checked ${checked})`, fixed > 0 ? 'ok' : '');
  return fixed;
}

// Border-based extraction using OpenCV detected cells
async function borderBasedExtract(ocrWords, borderCells, pageCanvases = {}) {
  console.log(`[borderBasedExtract] Starting with ${ocrWords.length} words and ${borderCells.length} cells`);

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

  console.log(`[borderBasedExtract] Processing ${Object.keys(cellsByPage).length} pages separately...`);

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
        console.log(`[borderBasedExtract] Page ${page} row ${r}: [${cells.map(c => `"${c.value}"`).join(', ')}]`);
      }

      tableRows.push({ type: 'data', cells, page: parseInt(page) });
    }

    console.log(`[borderBasedExtract] Page ${page}: ${rowsWithContent}/${numRows} rows with content`);
  }

  // ── Post-process: per-cell re-OCR for garbage numeric cells ─────────────────
  // Cells where parseVnNumber returns null but the value contains digits are
  // garbled OCR (e.g. "066*66"). Crop the word region and re-OCR at 2x zoom.
  console.log(`[reOcrGarbage] gate: ocrServerAvailable=${ocrServerAvailable} pageCanvasCount=${Object.keys(pageCanvases).length}`);
  if (Object.keys(pageCanvases).length > 0) {
    if (ocrServerAvailable) {
      await reOcrGarbageCells(tableRows, pageCanvases);
      await reOcrEmptyCells(tableRows, pageCanvases);
    }
    if (typeof onnxBackendAvailable !== 'undefined' && onnxBackendAvailable) {
      await reOcrEmptyCellsOnnx(tableRows, pageCanvases);
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
      if (cells[c].value) {
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

