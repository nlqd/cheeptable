// boq-review.js — review/flag UI: issue navigator, minimap, read aloud, re-OCR, crop popover
'use strict';


// ── Flag Computation ──
function computeRowFlags(rows) {
  rowFlags = {};
  const addFlag = (idx, type, message, severity, cellIdx) => {
    if (!rowFlags[idx]) rowFlags[idx] = [];
    rowFlags[idx].push({ type, message, severity, cellIdx: cellIdx ?? -1 });
  };
  const getVal = c => (typeof c === 'object' && c) ? (c.value || '') : (c || '');
  const getConf = c => (typeof c === 'object' && c && c.confidence != null) ? c.confidence : null;

  // Math check: qty × price ≈ total
  rows.forEach((row, idx) => {
    if (row.type !== 'data') return;
    const qty   = parseVnNumber(getVal(row.cells[3]));
    const price = parseVnNumber(getVal(row.cells[4]));
    const total = parseVnNumber(getVal(row.cells[5]));
    if (qty != null && price != null && total != null && qty > 0 && price > 0 && total > 0) {
      const expected = qty * price;
      const diff = Math.abs(expected - total) / total;
      if (diff > 0.015) {
        addFlag(idx, 'math',
          `Math: ${qty} × ${price.toLocaleString()} = ${Math.round(expected).toLocaleString()} ≠ ${Math.round(total).toLocaleString()} (${(diff*100).toFixed(1)}% off)`,
          'err', 5);
      }
    }
  });

  // Character-set check: letters in numeric columns (3,4,5)
  rows.forEach((row, idx) => {
    if (row.type !== 'data') return;
    [3, 4, 5].forEach(ci => {
      const val = getVal(row.cells[ci]);
      if (val && /[a-zA-ZÀ-ỹ]/.test(val)) {
        addFlag(idx, 'chartype',
          `Col "${COL_NAMES[ci]||ci}": "${val}" contains letters (expected number)`,
          'err', ci);
      }
    });
  });

  // Unit vocabulary check
  rows.forEach((row, idx) => {
    if (row.type !== 'data') return;
    const raw  = getVal(row.cells[2]);
    const unit = raw.trim().toLowerCase();
    if (!unit) return;
    const known = KNOWN_UNITS.has(unit) ||
      /^\d+\s*m[23²³]?$/.test(unit) ||
      /^\d+\s*(m|km|kg|l)$/.test(unit);
    if (!known && unit.length > 4) {
      addFlag(idx, 'unit',
        `Unit "${raw}" not in known vocabulary`,
        'warn', 2);
    }
  });

  // Low OCR confidence on description cell
  rows.forEach((row, idx) => {
    if (row.type !== 'data') return;
    const conf = getConf(row.cells[1]);
    if (conf !== null && conf < 72) {
      addFlag(idx, 'conf',
        `Low OCR confidence on description: ${conf.toFixed(0)}%`,
        'warn', 1);
    }
  });

  // Description too short
  rows.forEach((row, idx) => {
    if (row.type !== 'data') return;
    const desc = getVal(row.cells[1]).trim();
    if (desc && desc.split(/\s+/).filter(w => w.length >= 2).length < 2) {
      addFlag(idx, 'short',
        `Very short description: "${desc}"`,
        'warn', 1);
    }
  });

  // Page-level tail pattern: same last-word on 4+ rows of same page
  const pageLastWords = {};
  rows.forEach((row, idx) => {
    if (row.type !== 'data') return;
    const desc = getVal(row.cells[1]).trim();
    if (!desc) return;
    const words = desc.split(/\s+/);
    const last = words[words.length - 1].toLowerCase().replace(/[.,!?]/g, '');
    if (last.length >= 2) {
      const key = `${row.page || 1}:${last}`;
      if (!pageLastWords[key]) pageLastWords[key] = [];
      pageLastWords[key].push(idx);
    }
  });
  // Only flag tails that are clearly wrong: non-unit words appearing 6+ times
  const UNIT_TAILS = new Set(['m','m2','m3','m²','m³','kg','tấn','cái','bộ','công','lần','md','100m','100m3','tổ','ca']);
  Object.entries(pageLastWords).forEach(([key, indices]) => {
    if (indices.length >= 6) {
      const [pg, word] = key.split(':');
      if (UNIT_TAILS.has(word)) return;  // legitimate unit endings — skip
      indices.forEach(idx => {
        if (!(rowFlags[idx] || []).some(f => f.type === 'tail')) {
          addFlag(idx, 'tail',
            `Tail pattern: "${word}" ends ${indices.length} rows on page ${pg} (possible OCR bleed)`,
            'info', 1);
        }
      });
    }
  });

  // Build flat sorted flagList
  flagList = [];
  Object.entries(rowFlags).forEach(([idxStr, flags]) => {
    const idx = parseInt(idxStr);
    flags.forEach(f => flagList.push({ rowIdx: idx, ...f }));
  });
  flagList.sort((a, b) => a.rowIdx - b.rowIdx);
  currFlagIdx = -1;
  return rowFlags;
}

// ── Issue Navigator ──
function updateIssueNav() {
  const nav = $('issueNav');
  nav.classList.remove('hidden', 'no-issues');
  const total    = flagList.length;
  const rowCount = Object.keys(rowFlags).length;
  if (total === 0) {
    nav.classList.add('no-issues');
    nav.innerHTML = `<span class="fl-cnt ok">✓</span> <span>No issues detected — all math checks pass</span>`;
    return;
  }
  const pos = currFlagIdx >= 0 ? `${currFlagIdx + 1} / ${total}` : '';
  nav.innerHTML = `
    <span class="fl-cnt">${rowCount}</span><span> rows flagged,</span>
    <span class="fl-cnt">${total}</span><span> issues total</span>
    <button onclick="navFlag(-1)" style="padding:3px 10px;font-size:11px;">◀ Prev</button>
    <span id="flagPos" style="font-size:11px;color:var(--dim);min-width:70px;text-align:center;">${pos}</span>
    <button onclick="navFlag(+1)" style="padding:3px 10px;font-size:11px;">Next ▶</button>
    <span style="font-size:10px;color:var(--dim);margin-left:8px;">
      <span class="fl-icon err">●</span> math/char &nbsp;
      <span class="fl-icon warn">●</span> conf/unit &nbsp;
      <span class="fl-icon info">●</span> pattern
    </span>`;
}

function navFlag(delta) {
  if (flagList.length === 0) return;
  currFlagIdx = (currFlagIdx + delta + flagList.length) % flagList.length;
  jumpToFlagRow(flagList[currFlagIdx].rowIdx);
  const posEl = $('flagPos');
  if (posEl) posEl.textContent = `${currFlagIdx + 1} / ${flagList.length}`;
}

function jumpToFlagRow(rowIdx) {
  document.querySelectorAll('tr.fl-active').forEach(r => r.classList.remove('fl-active'));
  const tr = document.querySelector(`tr[data-row="${rowIdx}"]`);
  if (tr) {
    tr.classList.add('fl-active');
    tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  const row = extractedRows[rowIdx];
  if (row && row.page && pdfDoc) {
    vizCurrentPage = row.page;
    renderVizPage();
    $('vizPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ── Minimap ──
function renderMinimap(rows) {
  const mm = $('minimap');
  const tw = $('tableWrap');
  if (!mm || !tw) return;
  const tableH = tw.clientHeight || 400;
  mm.style.height = tableH + 'px';
  mm.innerHTML = '';
  if (!rows.length) return;
  const rowH = tableH / rows.length;
  rows.forEach((row, idx) => {
    const flags = rowFlags[idx] || [];
    let color;
    if (flags.some(f => f.severity === 'err'))       color = 'rgba(239,68,68,0.75)';
    else if (flags.some(f => f.severity === 'warn')) color = 'rgba(245,158,11,0.65)';
    else if (flags.some(f => f.severity === 'info')) color = 'rgba(59,130,246,0.45)';
    else if (row.type === 'section')                 color = 'rgba(59,130,246,0.3)';
    else                                             color = 'rgba(16,185,129,0.2)';
    const div = document.createElement('div');
    div.style.cssText = `position:absolute;left:0;right:0;top:${idx/rows.length*tableH}px;height:${Math.max(1,rowH)}px;background:${color};`;
    const tip = flags.length ? flags[0].message : (row.type === 'section' ? 'Section header' : '');
    if (tip) div.title = tip;
    div.addEventListener('click', () => jumpToFlagRow(idx));
    mm.appendChild(div);
  });
}

// ── Read Aloud ──
function speakCell(text) {
  if (!window.speechSynthesis) { alert('Speech synthesis not available in this browser.'); return; }
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = 'vi-VN';
  utt.rate = 0.88;
  window.speechSynthesis.speak(utt);
}

// ── Re-OCR on Demand ──
async function reOcrCell(rowIdx, colIdx, btnEl) {
  const row = extractedRows[rowIdx];
  if (!row || !window._pageCanvases) return;
  const canvas = window._pageCanvases[row.page];
  if (!canvas) { alert('Page canvas not available (processed pages only)'); return; }

  const getVal = c => (typeof c === 'object' && c) ? (c.value || '') : (c || '');
  const cellVal = getVal(row.cells[colIdx]);

  // Find words on this page matching the cell's content → get their bbox
  const pageWords = debugData.ocrWords.filter(w => w.page === row.page);
  const matchWords = pageWords.filter(w =>
    w.text.length >= 3 && cellVal.includes(w.text.substring(0, Math.min(5, w.text.length)))
  );

  if (matchWords.length === 0) { alert('Cannot locate cell bbox for re-OCR. No matching words found.'); return; }

  const pad = 6;
  const x0 = Math.max(0, Math.min(...matchWords.map(w => w.x)) * OCR_SCALE - pad);
  const y0 = Math.max(0, Math.min(...matchWords.map(w => w.y)) * OCR_SCALE - pad);
  const x1 = Math.min(canvas.width,  Math.max(...matchWords.map(w => w.x1)) * OCR_SCALE + pad);
  const y1 = Math.min(canvas.height, Math.max(...matchWords.map(w => w.y1)) * OCR_SCALE + pad);
  const cw = x1 - x0, ch = y1 - y0;
  if (cw < 4 || ch < 4) { alert('Crop region too small for re-OCR.'); return; }

  // Scale up 2× for better recognition
  const crop = document.createElement('canvas');
  crop.width = cw * 2; crop.height = ch * 2;
  crop.getContext('2d').drawImage(canvas, x0, y0, cw, ch, 0, 0, cw * 2, ch * 2);

  const origText = btnEl ? btnEl.textContent : '';
  if (btnEl) btnEl.textContent = '⏳';

  try {
    const blob = await new Promise(r => crop.toBlob(r, 'image/png'));
    const b64  = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload  = () => res(reader.result.split(',')[1]);
      reader.onerror = rej;
      reader.readAsDataURL(blob);
    });
    const resp = await fetch(`${OCR_SERVER_URL}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ image: b64, page: row.page }),
      signal: AbortSignal.timeout(30000)
    });
    if (resp.status === 401) { clearAuthToken(); throw new Error('Unauthorized'); }
    const data = await resp.json();
    const newText = (data.words || []).map(w => w.text).join(' ');
    if (btnEl) btnEl.textContent = origText;
    const confirmed = confirm(`Re-OCR result:\n\n"${newText}"\n\nOriginal: "${cellVal}"\n\nApply to cell?`);
    if (confirmed && newText) {
      const cell = extractedRows[rowIdx].cells[colIdx];
      if (typeof cell === 'object' && cell) { cell.value = newText; cell.edited = true; cell.source = 'reocr'; }
      else extractedRows[rowIdx].cells[colIdx] = newText;
      renderPreview(extractedRows);
    }
  } catch (err) {
    if (btnEl) btnEl.textContent = origText;
    alert(`Re-OCR failed: ${err.message}`);
  }
}

// ── Crop Popover ──
let _cropPopTimer = null;
function showCropPop(e, rowIdx, colIdx) {
  clearTimeout(_cropPopTimer);
  _cropPopTimer = setTimeout(async () => {
    const row = extractedRows[rowIdx];
    if (!row || !window._pageCanvases) return;
    const canvas = window._pageCanvases[row.page];
    if (!canvas) return;

    const getVal = c => (typeof c === 'object' && c) ? (c.value || '') : (c || '');
    const cellVal = getVal(row.cells[colIdx]);
    if (!cellVal || cellVal.length < 3) return;

    const pageWords = debugData.ocrWords.filter(w => w.page === row.page);
    const matchWords = pageWords.filter(w =>
      w.text.length >= 3 && cellVal.includes(w.text.substring(0, Math.min(5, w.text.length)))
    );
    if (matchWords.length === 0) return;

    const pad = 8;
    const x0 = Math.max(0, Math.min(...matchWords.map(w => w.x)) * OCR_SCALE - pad);
    const y0 = Math.max(0, Math.min(...matchWords.map(w => w.y)) * OCR_SCALE - pad - 4);
    const x1 = Math.min(canvas.width,  Math.max(...matchWords.map(w => w.x1)) * OCR_SCALE + pad);
    const y1 = Math.min(canvas.height, Math.max(...matchWords.map(w => w.y1)) * OCR_SCALE + pad + 4);
    const cw = x1 - x0, ch = y1 - y0;
    if (cw < 4 || ch < 4) return;

    // Render at 2× for clarity
    const scale = Math.min(3, 400 / cw);
    const cropC = $('cropCanvas');
    cropC.width  = Math.round(cw * scale);
    cropC.height = Math.round(ch * scale);
    cropC.getContext('2d').drawImage(canvas, x0, y0, cw, ch, 0, 0, cropC.width, cropC.height);

    $('cropLabel').textContent = `Page ${row.page} · "${cellVal}"`;
    const pop = $('cropPop');
    pop.style.display = 'block';
    // Position near cursor but within viewport
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = e.clientX + 14, top = e.clientY - 20;
    if (left + cropC.width + 24 > vw) left = e.clientX - cropC.width - 24;
    if (top + cropC.height + 40 > vh) top = vh - cropC.height - 50;
    pop.style.left = `${Math.max(4, left)}px`;
    pop.style.top  = `${Math.max(4, top)}px`;
  }, 280);
}

function hideCropPop() {
  clearTimeout(_cropPopTimer);
  $('cropPop').style.display = 'none';
}

