// boq-ui.js — UI rendering: summary line, Tabulator table preview, inline editing
'use strict';

let tabulatorInstance = null;

// ── UI: Stats (one-line summary) ──
function showStats(s) {
  $('resultPanel').classList.remove('hidden');
  $('summaryLine').textContent = 'Extracted ' + s.rows.toLocaleString() + ' rows from ' + s.pages + ' pages';
}

// ── UI: Table Preview with Tabulator ──
function renderPreview(rows) {
  $('resultPanel').classList.remove('hidden');

  // Compute flags
  computeRowFlags(rows);

  // Determine columns
  const maxCols = Math.max(...rows.map(r => r.cells.length), 1);
  const colHeaders = Array.from({ length: maxCols }, (_, i) => COL_NAMES[i] || 'Col ' + (i + 1));

  // (only conf flags now — single severity)

  // Build flat data for Tabulator
  const tableData = rows.map((row, idx) => {
    const flags = rowFlags[idx] || [];
    const obj = {
      _rowIdx: idx,
      _rowType: row.type,
      _flags: flags
    };

    for (let c = 0; c < maxCols; c++) {
      const cell = row.cells[c];
      const isMetadata = typeof cell === 'object' && cell !== null;
      const val = isMetadata ? cell.value : (cell || '');
      const conf = isMetadata ? cell.confidence : null;
      obj['col' + c] = val;
      obj['_conf' + c] = conf;
      obj['_meta' + c] = isMetadata ? cell : null;
    }

    return obj;
  });

  // Build column definitions
  const columns = [];

  // Flag badge column
  columns.push({
    title: '',
    field: '_flags',
    width: 32,
    headerSort: false,
    hozAlign: 'center',
    formatter: function(cell) {
      const flags = cell.getValue();
      if (!flags || flags.length === 0) return '';
      const tip = flags.map(f => f.message).join('\n');
      const label = flags.length > 1 ? flags.length : '!';
      const span = document.createElement('span');
      span.className = 'fl-badge';
      span.textContent = label;
      span.title = tip;
      span.addEventListener('click', function() { jumpToFlagRow(cell.getRow().getData()._rowIdx); });
      return span;
    }
  });

  // Row number column
  columns.push({
    title: '#',
    field: '_rowIdx',
    width: 48,
    headerSort: false,
    hozAlign: 'right',
    formatter: function(cell) {
      return cell.getValue() + 1;
    }
  });

  // Data columns
  for (let c = 0; c < maxCols; c++) {
    const colField = 'col' + c;
    const confField = '_conf' + c;
    const isNumCol = c >= 3;

    columns.push({
      title: colHeaders[c],
      field: colField,
      editor: 'input',
      hozAlign: isNumCol ? 'right' : 'left',
      headerSort: true,
      formatter: function(cell) {
        const val = cell.getValue() || '';
        const rowData = cell.getRow().getData();
        const conf = rowData[confField];
        const colIdx = parseInt(cell.getColumn().getField().replace('col', ''));
        const flags = rowData._flags || [];
        const cellFlags = flags.filter(f => f.cellIdx === colIdx || f.cellIdx === -1);

        const el = document.createElement('span');
        el.textContent = val;

        // Confidence coloring — only on cells with actual measured confidence
        if (val && conf !== null && conf !== undefined && conf > 0 && conf < 90) {
          cell.getElement().style.background = getConfidenceColor(conf);
          cell.getElement().style.border = getConfidenceBorder(conf);
        }

        return el;
      }
    });
  }

  // Destroy previous instance
  if (tabulatorInstance) {
    tabulatorInstance.destroy();
  }

  // Initialize Tabulator
  tabulatorInstance = new Tabulator('#tabulatorTable', {
    data: tableData,
    columns: columns,
    height: '70vh',
    layout: 'fitDataFill',
    editTriggerEvent: 'click',
    rowFormatter: function(row) {
      const data = row.getData();
      if (data._rowType === 'section') {
        row.getElement().classList.add('section-row');
      }
    },
    placeholder: 'No data'
  });

  // Sync edits back to extractedRows
  tabulatorInstance.on('cellEdited', function(cell) {
    const rowData = cell.getRow().getData();
    const rowIdx = rowData._rowIdx;
    const colField = cell.getColumn().getField();
    if (!colField.startsWith('col')) return;
    const colIdx = parseInt(colField.replace('col', ''));
    const newValue = cell.getValue();

    const existingCell = extractedRows[rowIdx].cells[colIdx];
    if (typeof existingCell === 'object' && existingCell !== null) {
      existingCell.value = newValue;
      existingCell.edited = true;
      existingCell.source = 'user';
      existingCell.correctedBy = 'Manual Edit';
    } else {
      extractedRows[rowIdx].cells[colIdx] = newValue;
    }
  });

  // Issue nav + enable download
  updateIssueNav();
  $('dlXlsx').disabled = false;
}
