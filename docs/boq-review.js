// boq-review.js — review/flag UI: issue navigator (generic, not file-specific)
'use strict';

// ── Flag Computation ──
function computeRowFlags(rows) {
  rowFlags = {};
  const addFlag = (idx, type, message, severity, cellIdx) => {
    if (!rowFlags[idx]) rowFlags[idx] = [];
    rowFlags[idx].push({ type, message, severity, cellIdx: cellIdx ?? -1 });
  };
  const getConf = c => (typeof c === 'object' && c && c.confidence != null) ? c.confidence : null;

  // Low OCR confidence on any cell with actual content
  rows.forEach((row, idx) => {
    if (row.type !== 'data') return;
    row.cells.forEach((cell, ci) => {
      if (typeof cell !== 'object' || !cell) return;
      const val = (cell.value || '').trim();
      if (!val) return;
      const conf = getConf(cell);
      if (conf !== null && conf > 0 && conf < 70) {
        addFlag(idx, 'conf',
          'Low OCR confidence: ' + conf.toFixed(0) + '% (col ' + (ci + 1) + ')',
          'warn', ci);
      }
    });
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
    nav.innerHTML = '<span class="fl-cnt ok">OK</span> <span>No issues detected</span>';
    return;
  }
  const pos = currFlagIdx >= 0 ? (currFlagIdx + 1) + ' / ' + total : '';
  nav.innerHTML =
    '<span class="fl-cnt">' + rowCount + '</span><span> rows with low confidence</span> ' +
    '<button onclick="navFlag(-1)" style="padding:3px 10px;font-size:11px;">Prev</button> ' +
    '<span id="flagPos" style="font-size:11px;color:var(--dim);min-width:70px;text-align:center;">' + pos + '</span> ' +
    '<button onclick="navFlag(+1)" style="padding:3px 10px;font-size:11px;">Next</button>';
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
