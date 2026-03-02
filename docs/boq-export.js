// boq-export.js — export functions: XLSX, debug JSON, CSV helper
'use strict';

// Called from init after DOM is ready
function setupExport() {
  document.getElementById('dlXlsx').addEventListener('click', () => {
    if (extractedRows.length === 0) return;
    const maxCols = Math.max(...extractedRows.map(r => r.cells.length));
    const headers = Array.from({ length: maxCols }, (_, i) => `Column ${i + 1}`);

    const aoa = [headers];
    for (const row of extractedRows) {
      const cells = [];
      for (let c = 0; c < maxCols; c++) {
        const cell = row.cells[c];
        let val = typeof cell === 'object' ? (cell ? cell.value : '') : (cell || '');
        if (c >= 3 && val) {
          const parsed = parseVnNumber(val);
          if (parsed !== null) { cells.push(parsed); continue; }
        }
        if (c === 0 && val && /^\d+$/.test(val)) { cells.push(parseInt(val)); continue; }
        cells.push(val);
      }
      aoa.push(cells);
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch:6 },{ wch:60 },{ wch:10 },{ wch:14 },{ wch:16 },{ wch:18 }].slice(0, maxCols);
    XLSX.utils.book_append_sheet(wb, ws, 'Extracted Table');

    // ── Review sheet: flagged rows only ──
    if (flagList.length > 0) {
      const getVal = c => (typeof c === 'object' && c) ? (c.value || '') : (c || '');
      const reviewAoa = [
        ['Row #', 'STT', 'Mô tả công việc', 'Đvt', 'Khối lượng', 'Đơn giá', 'Thành tiền', 'Issue type', 'Issue detail']
      ];
      const seen = new Set();
      flagList.forEach(f => {
        if (seen.has(f.rowIdx)) return;
        seen.add(f.rowIdx);
        const row = extractedRows[f.rowIdx];
        if (!row) return;
        const rowFlags_ = rowFlags[f.rowIdx] || [];
        const issues    = rowFlags_.map(fl => fl.type).join(', ');
        const details   = rowFlags_.map(fl => fl.message).join(' | ');
        const cells     = Array.from({ length: maxCols }, (_, ci) => getVal(row.cells[ci]));
        reviewAoa.push([f.rowIdx + 1, ...cells, issues, details]);
      });
      const wsReview = XLSX.utils.aoa_to_sheet(reviewAoa);
      wsReview['!cols'] = [{ wch:6 },{ wch:6 },{ wch:50 },{ wch:8 },{ wch:12 },{ wch:14 },{ wch:16 },{ wch:18 },{ wch:60 }];
      XLSX.utils.book_append_sheet(wb, wsReview, 'Cần kiểm tra');
      log(`Review sheet: ${reviewAoa.length - 1} flagged rows`, 'warn');
    }

    XLSX.writeFile(wb, 'table_extracted.xlsx');
    log('XLSX exported!', 'ok');
  });
}

// ── Debug: Export JSON ──
function exportDebugJSON() {
  if (!debugData || !debugData.ocrWords || debugData.ocrWords.length === 0) {
    alert('No debug data available. Process a PDF first.');
    return;
  }

  const exportData = {
    metadata: debugData.pdfMetadata,
    statistics: {
      totalWords: debugData.ocrWords.length,
      totalLines: debugData.ocrLines.length,
      totalPages: (debugData.pageImages || []).length,
      avgConfidence: debugData.ocrWords.length > 0
        ? (debugData.ocrWords.reduce((sum, w) => sum + w.confidence, 0) / debugData.ocrWords.length).toFixed(1)
        : 0
    },
    ocrWords: debugData.ocrWords,
    ocrLines: debugData.ocrLines,
    extractedRows: extractedRows.map(row => ({
      type: row.type,
      cells: row.cells.map(cell => ({
        value: typeof cell === 'object' ? cell.value : cell,
        original: typeof cell === 'object' ? cell.original : cell,
        confidence: typeof cell === 'object' ? cell.confidence : null
      }))
    })),
    columnBoundaries: debugData.columnBoundaries
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ocr_debug_data.json';
  a.click();
  URL.revokeObjectURL(url);
  log('Debug JSON exported!', 'ok');
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob(['\ufeff' + content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
