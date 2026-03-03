// boq-review.js — review/flag UI: issue navigator
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

  // Math check: qty * price ~ total
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
          'Math: ' + qty + ' x ' + price.toLocaleString() + ' = ' + Math.round(expected).toLocaleString() + ' != ' + Math.round(total).toLocaleString() + ' (' + (diff*100).toFixed(1) + '% off)',
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
          'Col "' + (COL_NAMES[ci]||ci) + '": "' + val + '" contains letters (expected number)',
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
        'Unit "' + raw + '" not in known vocabulary',
        'warn', 2);
    }
  });

  // Low OCR confidence on description cell
  rows.forEach((row, idx) => {
    if (row.type !== 'data') return;
    const conf = getConf(row.cells[1]);
    if (conf !== null && conf < 72) {
      addFlag(idx, 'conf',
        'Low OCR confidence on description: ' + conf.toFixed(0) + '%',
        'warn', 1);
    }
  });

  // Description too short
  rows.forEach((row, idx) => {
    if (row.type !== 'data') return;
    const desc = getVal(row.cells[1]).trim();
    if (desc && desc.split(/\s+/).filter(w => w.length >= 2).length < 2) {
      addFlag(idx, 'short',
        'Very short description: "' + desc + '"',
        'warn', 1);
    }
  });

  // Page-level tail pattern: same last-word on 6+ rows of same page
  const pageLastWords = {};
  rows.forEach((row, idx) => {
    if (row.type !== 'data') return;
    const desc = getVal(row.cells[1]).trim();
    if (!desc) return;
    const words = desc.split(/\s+/);
    const last = words[words.length - 1].toLowerCase().replace(/[.,!?]/g, '');
    if (last.length >= 2) {
      const key = (row.page || 1) + ':' + last;
      if (!pageLastWords[key]) pageLastWords[key] = [];
      pageLastWords[key].push(idx);
    }
  });
  const UNIT_TAILS = new Set(['m','m2','m3','m²','m³','kg','tấn','cái','bộ','công','lần','md','100m','100m3','tổ','ca']);
  Object.entries(pageLastWords).forEach(([key, indices]) => {
    if (indices.length >= 6) {
      const [pg, word] = key.split(':');
      if (UNIT_TAILS.has(word)) return;
      indices.forEach(idx => {
        if (!(rowFlags[idx] || []).some(f => f.type === 'tail')) {
          addFlag(idx, 'tail',
            'Tail pattern: "' + word + '" ends ' + indices.length + ' rows on page ' + pg + ' (possible OCR bleed)',
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
    nav.innerHTML = '<span class="fl-cnt ok">OK</span> <span>No issues detected — all math checks pass</span>';
    return;
  }
  const pos = currFlagIdx >= 0 ? (currFlagIdx + 1) + ' / ' + total : '';
  nav.innerHTML =
    '<span class="fl-cnt">' + rowCount + '</span><span> rows to check</span> ' +
    '<button onclick="navFlag(-1)" style="padding:3px 10px;font-size:11px;">Prev</button> ' +
    '<span id="flagPos" style="font-size:11px;color:var(--dim);min-width:70px;text-align:center;">' + pos + '</span> ' +
    '<button onclick="navFlag(+1)" style="padding:3px 10px;font-size:11px;">Next</button> ' +
    '<span style="font-size:10px;color:var(--dim);margin-left:8px;">' +
      '<span class="fl-icon err">*</span> math/char &nbsp;' +
      '<span class="fl-icon warn">*</span> conf/unit &nbsp;' +
      '<span class="fl-icon info">*</span> pattern' +
    '</span>';
}

function navFlag(delta) {
  if (flagList.length === 0) return;
  currFlagIdx = (currFlagIdx + delta + flagList.length) % flagList.length;
  jumpToFlagRow(flagList[currFlagIdx].rowIdx);
  const posEl = $('flagPos');
  if (posEl) posEl.textContent = (currFlagIdx + 1) + ' / ' + flagList.length;
}

function jumpToFlagRow(rowIdx) {
  if (!tabulatorInstance) return;

  // Remove previous highlight
  tabulatorInstance.getRows().forEach(r => r.getElement().classList.remove('fl-active-row'));

  // Find the row by _rowIdx and scroll to it
  const rows = tabulatorInstance.getRows();
  for (const row of rows) {
    if (row.getData()._rowIdx === rowIdx) {
      row.getElement().classList.add('fl-active-row');
      row.scrollTo();
      break;
    }
  }
}
