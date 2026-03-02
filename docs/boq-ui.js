// boq-ui.js — UI rendering: stats panel, table preview, inline editing
'use strict';

// ── UI: Stats ──
function showStats(s) {
  $('statsPanel').classList.remove('hidden');
  const items = [
    ['Pages', s.pages],
    ...(s.ocrWords > 0 ? [
      ['OCR Words', s.ocrWords],
      ['Avg Confidence', s.avgConfidence ? s.avgConfidence + '%' : 'N/A'],
    ] : [
      ['Text Spans', s.textSpans],
      ['Lines Found', s.lines],
    ]),
    ['Table Rows', s.rows],
    ['Data Rows', s.dataRows],
    ['Sections', s.sectionRows]
  ];
  $('stats').innerHTML = items
    .map(([l, v]) => `<div class="stat"><div class="val">${typeof v === 'number' ? v.toLocaleString() : v}</div><div class="label">${l}</div></div>`)
    .join('');
}

// ── UI: Table Preview ──
function renderPreview(rows) {
  $('previewPanel').classList.remove('hidden');
  $('previewCount').textContent = `(${rows.length} rows)`;
  showVizPanel();

  // ── Compute flags ──
  computeRowFlags(rows);

  // ── Confidence stats for review panel ──
  let totalCells = 0, highConf = 0, medConf = 0, lowConf = 0;
  let dictCorrections = 0, syllableCorrections = 0, userEdits = 0;
  rows.forEach(row => {
    row.cells.forEach(cell => {
      if (typeof cell === 'object' && cell !== null && cell.value) {
        totalCells++;
        if (cell.confidence >= 90) highConf++;
        else if (cell.confidence >= 70) medConf++;
        else lowConf++;
        if (cell.source === 'dictionary') dictCorrections++;
        else if (cell.source === 'syllable') syllableCorrections++;
        if (cell.edited) userEdits++;
      }
    });
  });
  if (totalCells > 0) {
    $('reviewPanel').classList.remove('hidden');
    let reviewHtml = `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:8px;">`;
    reviewHtml += `<div><strong style="color:var(--text)">${highConf}</strong> <span style="color:var(--dim)">high conf</span></div>`;
    reviewHtml += `<div><strong style="color:var(--warn)">${medConf}</strong> <span style="color:var(--dim)">need review</span></div>`;
    reviewHtml += `<div><strong style="color:#ef4444">${lowConf}</strong> <span style="color:var(--dim)">low conf</span></div>`;
    reviewHtml += `</div><div style="margin-top:12px;font-size:11px;color:var(--dim);">`;
    reviewHtml += `Corrections: <strong style="color:var(--accent2)">${dictCorrections} dict</strong> · `;
    reviewHtml += `<strong style="color:var(--accent2)">${syllableCorrections} syllable</strong>`;
    if (userEdits > 0) reviewHtml += ` · <strong style="color:var(--accent)">${userEdits} manual edits</strong>`;
    reviewHtml += `</div>`;
    $('reviewStats').innerHTML = reviewHtml;
  }

  // ── Build table HTML ──
  const maxCols = Math.max(...rows.map(r => r.cells.length), 1);
  const colHeaders = Array.from({ length: maxCols }, (_, i) => COL_NAMES[i] || `Col ${i+1}`);

  // Flag severity → CSS class for cells
  const FLAG_CLASS = { math: 'fl-math', chartype: 'fl-char', unit: 'fl-unit', conf: 'fl-conf', tail: 'fl-tail', short: 'fl-conf' };
  const FLAG_SEV   = { err: 'err', warn: 'warn', info: 'info' };

  let html = '<table><thead><tr>';
  html += '<th style="width:20px;padding:4px 2px;"></th>';  // flag badge col
  html += '<th style="width:28px;">#</th>';
  colHeaders.forEach(h => html += `<th>${escHtml(h)}</th>`);
  html += '</tr></thead><tbody>';

  rows.forEach((row, idx) => {
    const flags   = rowFlags[idx] || [];
    const rowCls  = row.type === 'section' ? ' class="section"' : '';
    html += `<tr${rowCls} data-row="${idx}">`;

    // Flag badge cell
    if (flags.length > 0) {
      const topFlag = flags[0];
      const sev = FLAG_SEV[topFlag.severity] || 'info';
      const tip = flags.map(f => f.message).join('\n').replace(/"/g, '&quot;');
      html += `<td style="padding:2px;text-align:center;" title="${tip}">` +
        `<span class="fl-icon ${sev}" onclick="jumpToFlagRow(${idx})">` +
        `${flags.length > 1 ? flags.length : (topFlag.severity === 'err' ? '✕' : '!')}</span></td>`;
    } else {
      html += '<td></td>';
    }

    // Row number
    html += `<td style="color:var(--dim)">${idx + 1}</td>`;

    // Data cells
    for (let c = 0; c < maxCols; c++) {
      const cell       = row.cells[c];
      const isMetadata = typeof cell === 'object' && cell !== null;
      const val        = isMetadata ? cell.value : (cell || '');
      const isNum      = val.match(/^[\d.,]+$/) && c >= 3;

      let classes = isNum ? 'num editable' : 'editable';
      let style   = '';
      let title   = '';

      // Confidence background (existing)
      if (isMetadata) {
        if (cell.confidence < 90) {
          style = `background:${getConfidenceColor(cell.confidence)};border:${getConfidenceBorder(cell.confidence)};`;
        }
        title = buildAttributionTooltip(cell).replace(/"/g, '&quot;');
        if (cell.edited) classes += ' edited';
      }

      // Flag override class (takes visual priority over confidence bg)
      const cellFlags = flags.filter(f => f.cellIdx === c || f.cellIdx === -1);
      if (cellFlags.length) {
        const cl = FLAG_CLASS[cellFlags[0].type];
        if (cl) { classes += ' ' + cl; style = ''; }  // flag style overrides conf
      }

      // Description cell extras: speak button + re-OCR button (for flagged)
      let extras = '';
      if (c === 1 && val) {
        extras += `<button class="speak-btn" title="Read aloud (vi-VN)" onclick="event.stopPropagation();speakCell('${val.replace(/'/g,"\\'")}')">🔊</button>`;
      }
      if (cellFlags.some(f => f.severity === 'err' || f.severity === 'warn') && ocrServerAvailable !== false) {
        extras += `<button class="reocr-btn" title="Re-OCR this cell at 2×" onclick="event.stopPropagation();reOcrCell(${idx},${c},this)">⟳</button>`;
      }

      html += `<td class="${classes}" data-row="${idx}" data-col="${c}" style="${style}" title="${title}">${escHtml(val)}${extras}</td>`;
    }
    html += '</tr>';
  });
  html += '</tbody></table>';
  $('tableWrap').innerHTML = html;

  // ── Event delegation: click = edit, hover = crop popover ──
  const tw = $('tableWrap');
  tw.addEventListener('click', function(e) {
    const td = e.target.closest('td.editable');
    if (!td) return;
    // Only open editor if not clicking speak/reocr buttons
    if (e.target.classList.contains('speak-btn') || e.target.classList.contains('reocr-btn')) return;
    makeEditable(td);
  });
  tw.addEventListener('mouseover', function(e) {
    const td = e.target.closest('td[data-col="1"]');
    if (!td || !td.dataset.row) return;
    showCropPop(e, parseInt(td.dataset.row), 1);
  });
  tw.addEventListener('mouseleave', hideCropPop);
  tw.addEventListener('mouseout', function(e) {
    if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('#tableWrap')) hideCropPop();
  });

  // ── Issue nav + minimap ──
  updateIssueNav();
  setTimeout(() => renderMinimap(rows), 50);  // after layout settles

  $('dlXlsx').disabled = false;
  $('dlDebugJSON').disabled = false;
}



// ── Inline Cell Editing ──
function makeEditable(td) {
  const rowIdx = parseInt(td.dataset.row);
  const colIdx = parseInt(td.dataset.col);
  const cell = extractedRows[rowIdx].cells[colIdx];
  const currentValue = typeof cell === 'object' ? cell.value : (cell || '');

  // Create input
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentValue;
  input.style.cssText = 'width:100%;background:var(--bg);color:var(--text);border:2px solid var(--accent);padding:4px;font:inherit;';

  // Replace cell content with input
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  input.select();

  // Save on blur or Enter
  const save = () => {
    const newValue = input.value.trim();
    if (typeof cell === 'object') {
      if (newValue !== cell.value) {
        cell.value = newValue;
        cell.edited = true;
        cell.source = 'user';
        cell.correctedBy = 'Manual Edit';
      }
    } else {
      extractedRows[rowIdx].cells[colIdx] = newValue;
    }
    renderPreview(extractedRows);
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') renderPreview(extractedRows);
  });
}
