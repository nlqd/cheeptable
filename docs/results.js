// results.js — the table the visitor reviews, and the Excel export. Loaded after a job finishes, never at startup.
// A native <table> (keyboard and screen-reader friendly), editing in place, review flags that carry a symbol and a spoken label.
'use strict';

CT.addStrings({
  resTitle: 'Đã đọc {rows} hàng từ {pages} trang', resNone: 'Không tìm thấy bảng trong tệp này',
  noneHelp: 'Thử ảnh rõ hơn (ít nhất 150 dpi, chụp thẳng, đủ sáng) hoặc một trang có bảng. Tệp scan nghiêng nhiều hoặc quá mờ có thể không đọc được.',
  download: 'Tải Excel (.xlsx)', again: 'Chọn tệp khác', preparing: 'Đang chuẩn bị Excel…', exported: 'Đã tạo tệp {name}.', exportFailed: 'Không tạo được tệp Excel: {msg}',
  checkCount: '{n} ô cần kiểm tra', maybeCount: '{n} ô nghi ngờ nhẹ', allChecked: 'Không còn ô nào cần kiểm tra.',
  prev: 'Ô trước', next: 'Ô sau', onlyFlagged: 'Chỉ hiện hàng cần kiểm tra', hint: 'Enter để sửa hoặc xác nhận ô; ] và [ nhảy tới ô cần kiểm tra; mũi tên để di chuyển.',
  tableLabel: 'Bảng đã đọc từ tệp', rowNo: 'Số hàng',
  flagLowText: 'Cần kiểm tra: độ tin cậy thấp ({c}%)', flagLowNum: 'Cần kiểm tra số: độ tin cậy thấp ({c}%)',
  flagIdentity: 'Cần kiểm tra: số lượng × đơn giá không bằng thành tiền', flagMaybe: 'Hơi nghi ngờ: độ tin cậy {c}%',
  failedPages: 'Không đọc được {n} trang: {list}.', retryAll: 'Thử lại cả tệp',
  headersDropped: 'Đã bỏ {n} hàng tiêu đề lặp lại.', fixedNum: 'Đã sửa {n} số bị đọc sai nhờ quan hệ số lượng × đơn giá = thành tiền.',
  fixedSeq: 'Đã sửa {n} số thứ tự nhờ quy luật tăng dần.', log: 'Nhật ký xử lý (cho hỗ trợ kỹ thuật)',
  sheetMain: 'Bảng đã đọc', sheetReview: 'Cần kiểm tra', colRow: 'Hàng', colReason: 'Lý do',
  step3: 'Kiểm tra', step4: 'Tải Excel', step1: 'Chọn tệp', step2: 'Nhận dạng', showPage: 'Xem trang gốc', hidePage: 'Ẩn trang gốc',
  pageScroll: 'Ảnh trang gốc, có thể cuộn', fit: 'Vừa khung', zoomIn: 'Phóng to trang gốc', zoomOut: 'Thu nhỏ trang gốc',
}, {
  resTitle: 'Read {rows} rows from {pages} pages', resNone: 'No table was found in this file',
  noneHelp: 'Try a clearer image (at least 150 dpi, shot straight on, well lit) or a page that has a table. Badly tilted or blurred scans may not be readable.',
  download: 'Download Excel (.xlsx)', again: 'Choose another file', preparing: 'Preparing Excel…', exported: 'Created {name}.', exportFailed: 'Could not create the Excel file: {msg}',
  checkCount: '{n} cells to check', maybeCount: '{n} slightly doubtful cells', allChecked: 'No cells left to check.',
  prev: 'Previous cell', next: 'Next cell', onlyFlagged: 'Show only rows to check', hint: 'Enter edits or confirms a cell; ] and [ jump to cells to check; arrow keys move.',
  tableLabel: 'Table read from the file', rowNo: 'Row number',
  flagLowText: 'Check: low confidence ({c}%)', flagLowNum: 'Check the number: low confidence ({c}%)',
  flagIdentity: 'Check: quantity × unit price does not equal the amount', flagMaybe: 'Slightly doubtful: confidence {c}%',
  failedPages: '{n} pages could not be read: {list}.', retryAll: 'Try the whole file again',
  headersDropped: 'Removed {n} repeated header rows.', fixedNum: 'Fixed {n} misread numbers using quantity × price = amount.',
  fixedSeq: 'Fixed {n} row numbers using the counting-up rule.', log: 'Processing log (for support)',
  sheetMain: 'Extracted table', sheetReview: 'To check', colRow: 'Row', colReason: 'Reason',
  step3: 'Review', step4: 'Download Excel', step1: 'Choose file', step2: 'Recognise', showPage: 'Show source page', hidePage: 'Hide source page',
  pageScroll: 'Source page image, scrollable', fit: 'Fit', zoomIn: 'Zoom in on the source page', zoomOut: 'Zoom out of the source page',
});

(() => {
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  let R = null;   // everything about the table on screen

  const val = (c) => (c && typeof c === 'object') ? String(c.value ?? '') : String(c ?? '');
  const reasonText = (f) => f.reason === 'identity' ? CT.t('flagIdentity')
    : f.reason === 'maybeText' ? CT.t('flagMaybe', { c: Math.round(f.conf) })
    : CT.t(f.reason === 'lowNum' ? 'flagLowNum' : 'flagLowText', { c: Math.round(f.conf ?? 0) });

  // ── Building the screen ──
  function render({ rows, pages, fileName }) {
    const root = $('stage-result');
    root.textContent = '';
    const norm = normalizeHeaders(rows);
    const kept = norm.rows;
    extractedRows = kept;
    const dataRows = kept.filter(r => r.type === 'data' && r.cells.some(c => val(c).trim()));
    const count = Math.max(1, ...kept.map(r => r.cells.length));
    R = { rows: kept, pages, fileName, count, names: columnNames(count, norm.names, CT.lang, looksLikeBoq(kept)), detected: norm.names, dropped: norm.dropped,
      flags: null, cursor: -1, onlyFlagged: false, sel: null, tds: [], trs: [] };

    const head = el('div', 'rhead');
    const title = el('h2', '', ''); title.id = 'resTitle'; title.tabIndex = -1;
    const actions = el('div', 'actions');
    const dl = el('button', 'btn', CT.t('download')); dl.type = 'button'; dl.id = 'dlXlsx';
    const again = el('button', 'btn quiet', CT.t('again')); again.type = 'button';
    again.addEventListener('click', () => { CT.showStage('start'); $('fileInput').focus(); });
    actions.append(dl, again);
    head.append(title, actions);
    const steps = el('ol', 'steps');
    [['step1', 'done'], ['step2', 'done'], ['step3', 'now'], ['step4', '']].forEach(([k, c], i) => {
      const li = el('li', c); li.dataset.key = k; li.append(el('span', 'n', String(i + 1)), el('span', '', CT.t(k))); steps.append(li);
    });
    R.steps = steps;
    root.append(steps, head);

    if (!dataRows.length) {
      title.textContent = CT.t('resNone');
      root.append(el('p', 'nonehelp', CT.t('noneHelp')));
      dl.disabled = true;
      CT.emit('results:ready', { empty: true });
      title.focus();
      return;
    }

    title.textContent = CT.t('resTitle', { rows: dataRows.length.toLocaleString(CT.lang === 'vi' ? 'vi-VN' : 'en-US'), pages });
    const notes = el('ul', 'notes');
    const failed = CT.state.failedPages || [];
    if (failed.length) {
      const li = el('li', 'bad', CT.t('failedPages', { n: failed.length, list: failed.join(', ') }) + ' ');
      const b = el('button', 'btn quiet sm', CT.t('retryAll')); b.type = 'button'; b.addEventListener('click', () => CT.retry());
      li.append(b); notes.append(li);
    }
    if (norm.dropped) notes.append(el('li', '', CT.t('headersDropped', { n: norm.dropped })));
    if (CT.state.fixes && CT.state.fixes.arithmetic) notes.append(el('li', '', CT.t('fixedNum', { n: CT.state.fixes.arithmetic })));
    if (CT.state.fixes && CT.state.fixes.numbering) notes.append(el('li', '', CT.t('fixedSeq', { n: CT.state.fixes.numbering })));
    if (notes.children.length) root.append(notes);

    // review bar
    const bar = el('div', 'reviewbar');
    const counter = el('p', 'rcount'); counter.setAttribute('role', 'status'); counter.setAttribute('aria-live', 'polite');
    const prev = el('button', 'btn quiet sm', CT.t('prev')); prev.type = 'button';
    const next = el('button', 'btn quiet sm', CT.t('next')); next.type = 'button';
    prev.addEventListener('click', () => jump(-1)); next.addEventListener('click', () => jump(+1));
    const only = el('label', 'only'); const chk = el('input'); chk.type = 'checkbox'; only.append(chk, document.createTextNode(' ' + CT.t('onlyFlagged')));
    chk.addEventListener('change', () => { R.onlyFlagged = chk.checked; applyFilter(); });
    bar.append(counter, prev, next, only);
    R.counter = counter; R.prev = prev; R.next = next; R.only = chk;
    root.append(bar, el('p', 'hint', CT.t('hint')));

    // table (+ page pane in side-by-side mode)
    const split = el('div', 'split');
    const pane = el('div', 'pane'); pane.id = 'pagePane'; pane.hidden = CT.mode !== 'workbench';
    pane.setAttribute('role', 'region'); pane.setAttribute('aria-label', CT.t('showPage'));
    const wrap = el('div', 'gridwrap'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', CT.t('tableLabel'));
    wrap.append(buildTable());
    split.append(pane, wrap);
    root.append(split);
    R.pane = pane; R.wrap = wrap;

    // log
    const det = el('details', 'logbox'); det.append(el('summary', '', CT.t('log')));
    det.append(Object.assign(el('pre'), { textContent: (CT.logs || []).map(l => l.msg).join('\n') }));
    root.append(det);

    dl.addEventListener('click', () => exportXlsx(dl));
    R.dl = dl;
    refreshFlags();
    if (CT.mode === 'guided' && R.flags.check > 0) { chk.checked = R.onlyFlagged = true; applyFilter(); }
    CT.loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js').catch(() => {});   // ready before the click
    if (CT.mode === 'workbench') mountWorkbench();
    CT.emit('results:ready', { empty: false });
    title.focus({ preventScroll: true });
  }

  function buildTable() {
    const table = el('table', 'grid');
    table.setAttribute('aria-label', CT.t('tableLabel'));
    const thead = el('thead'), htr = el('tr');
    const th0 = el('th', 'rn', '#'); th0.scope = 'col'; th0.title = CT.t('rowNo'); htr.append(th0);
    R.names.forEach((n, i) => { const th = el('th', i >= 3 ? 'num' : '', n); th.scope = 'col'; htr.append(th); });
    thead.append(htr);
    const tbody = el('tbody');
    let shown = 0;
    R.rows.forEach((row, r) => {
      const blank = !row.cells.some(c => val(c).trim());
      const tr = el('tr', row.type === 'section' ? 'section' : ''); tr.dataset.r = r; tr.dataset.blank = blank ? '1' : '';
      const rh = el('th', 'rn', blank ? '' : String(++shown)); rh.scope = 'row'; tr.append(rh);
      for (let c = 0; c < R.count; c++) {
        const td = el('td', c >= 3 ? 'num' : '', val(row.cells[c])); td.dataset.r = r; td.dataset.c = c; td.tabIndex = -1;
        tr.append(td); R.tds[r * R.count + c] = td;
      }
      R.trs[r] = tr;
      tbody.append(tr);
    });
    table.append(thead, tbody);
    R.tds[0] && (R.tds[0].tabIndex = 0);
    tbody.addEventListener('click', (e) => { const td = e.target.closest('td'); if (td) select(td, false); });
    tbody.addEventListener('dblclick', (e) => { const td = e.target.closest('td'); if (td) edit(td); });
    tbody.addEventListener('keydown', onKey);
    return table;
  }

  // ── Flags ──
  function refreshFlags() {
    R.flags = reviewFlags(R.rows, arithHolds);
    R.order = [...R.flags.map.entries()].filter(([, f]) => f.level === 'check').map(([k]) => k.split(':').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    R.tds.forEach((td) => {
      const key = td.dataset.r + ':' + td.dataset.c, f = R.flags.map.get(key);
      const had = td.dataset.flag;
      if (!f && !had) return;
      td.classList.toggle('flag-check', !!f && f.level === 'check');
      td.classList.toggle('flag-maybe', !!f && f.level === 'maybe');
      if (f) { td.dataset.flag = f.level; td.title = reasonText(f); } else { delete td.dataset.flag; td.removeAttribute('title'); }
      td.querySelectorAll('.mark,.sr').forEach(n => n.remove());
      if (f) { const m = el('span', 'mark', f.level === 'check' ? '!' : '?'); m.setAttribute('aria-hidden', 'true'); td.append(m, Object.assign(el('span', 'sr'), { textContent: ' — ' + reasonText(f) })); }
    });
    const parts = [R.flags.check ? CT.t('checkCount', { n: R.flags.check }) : CT.t('allChecked')];
    if (R.flags.maybe) parts.push(CT.t('maybeCount', { n: R.flags.maybe }));
    R.counter.textContent = parts.join(' · ');
    R.counter.dataset.state = R.flags.check ? 'todo' : 'ok';
    R.prev.disabled = R.next.disabled = !R.order.length;
    applyFilter();
  }
  function applyFilter() {
    const flaggedRows = new Set(R.order.map(o => o[0]));
    R.trs.forEach((tr, r) => { tr.hidden = tr.dataset.blank === '1' || (R.onlyFlagged && R.order.length > 0 && !flaggedRows.has(r)); });
  }
  function jump(delta) {
    if (!R.order.length) return;
    const cur = R.sel ? R.sel : [-1, -1];
    let i;
    if (delta > 0) i = R.order.findIndex(o => o[0] > cur[0] || (o[0] === cur[0] && o[1] > cur[1]));
    else { i = -1; R.order.forEach((o, k) => { if (o[0] < cur[0] || (o[0] === cur[0] && o[1] < cur[1])) i = k; }); }
    if (i < 0) i = delta > 0 ? 0 : R.order.length - 1;
    const [r, c] = R.order[i];
    select(R.tds[r * R.count + c], true);
  }

  // ── Selection, keyboard, editing ──
  function select(td, focus) {
    if (!td) return;
    const old = R.tds.find(t => t && t.tabIndex === 0);
    if (old && old !== td) old.tabIndex = -1;
    td.tabIndex = 0;
    R.tds.forEach(t => t && t.classList.remove('cur'));
    td.classList.add('cur');
    R.sel = [Number(td.dataset.r), Number(td.dataset.c)];
    if (focus) { td.focus({ preventScroll: true }); td.scrollIntoView({ block: 'center', inline: 'nearest' }); }
    CT.emit('cell:select', { r: R.sel[0], c: R.sel[1], row: R.rows[R.sel[0]], cell: R.rows[R.sel[0]].cells[R.sel[1]] });
  }
  function move(dr, dc) {
    let [r, c] = R.sel || [0, 0];
    c = Math.max(0, Math.min(R.count - 1, c + dc));
    let step = dr;
    r += step;
    while (r >= 0 && r < R.rows.length && R.trs[r].hidden) r += step || 1;
    r = Math.max(0, Math.min(R.rows.length - 1, r));
    if (R.trs[r].hidden) return;
    select(R.tds[r * R.count + c], true);
  }
  function onKey(e) {
    const td = e.target.closest && e.target.closest('td');
    if (!td || e.target.tagName === 'INPUT') return;
    const k = e.key;
    if (k === 'ArrowDown') move(1, 0); else if (k === 'ArrowUp') move(-1, 0); else if (k === 'ArrowRight') move(0, 1); else if (k === 'ArrowLeft') move(0, -1);
    else if (k === 'Enter' || k === 'F2') { edit(td); }
    else if (k === ']') jump(+1); else if (k === '[') jump(-1);
    else return;
    e.preventDefault();
  }
  function edit(td) {
    if (td.querySelector('input')) return;
    select(td, false);
    const r = Number(td.dataset.r), c = Number(td.dataset.c);
    const cell = R.rows[r].cells[c];
    const input = el('input', 'cellin'); input.type = 'text'; input.value = val(cell);
    input.setAttribute('aria-label', R.names[c] + ', ' + CT.t('rowNo') + ' ' + (Number(td.parentNode.firstChild.textContent) || r + 1));
    td.textContent = ''; td.append(input); input.focus(); input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return; done = true;
      const v = input.value;
      if (commit) {
        const meta = (cell && typeof cell === 'object') ? cell : (R.rows[r].cells[c] = { value: val(cell), confidence: null });
        if (v !== meta.value) { meta.original = meta.original ?? meta.value; meta.value = v; meta.edited = true; meta.source = 'user'; meta.correctedBy = 'Manual Edit'; }
        meta.reviewed = true;                 // typed over or confirmed with Enter: the flag has done its job
      }
      td.textContent = commit ? v : val(cell);
      refreshFlags();
      td.focus({ preventScroll: true });
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); move(0, 0); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Tab') { e.preventDefault(); finish(true); move(0, e.shiftKey ? -1 : 1); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
  }

  // ── Side by side ──
  function mountWorkbench() {
    CT.loadScript('workbench.js').then(() => { R.pane.hidden = false; CT.workbench.mount(R.pane, () => R); if (R.sel) select(R.tds[R.sel[0] * R.count + R.sel[1]], false); });
  }
  CT.on('mode', () => {
    if (!R || !R.pane) return;
    if (CT.mode === 'workbench') mountWorkbench(); else { R.pane.hidden = true; if (CT.workbench) CT.workbench.unmount(); }
    if (CT.mode === 'guided' && R.flags && R.flags.check > 0) { R.only.checked = R.onlyFlagged = true; applyFilter(); }
  });
  CT.on('image:pick', ({ r, c }) => { if (R && R.tds[r * R.count + c]) select(R.tds[r * R.count + c], true); });

  // ── Excel ──
  async function exportXlsx(btn) {
    btn.disabled = true; const label = btn.textContent; btn.textContent = CT.t('preparing');
    try {
      await CT.loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
      const numeric = numericColumns(R.rows, R.count, parseVnNumber);
      const header = R.names.slice();
      const aoa = [header];
      R.rows.forEach(row => {
        aoa.push(Array.from({ length: R.count }, (_, c) => {
          const v = val(row.cells[c]);
          if (v && numeric[c] && row.type === 'data') { const n = parseVnNumber(v); if (n !== null) return n; }
          return v;
        }));
      });
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = header.map((_, c) => ({ wch: c === 1 ? 60 : c === 0 ? 8 : 16 }));
      XLSX.utils.book_append_sheet(wb, ws, CT.t('sheetMain'));
      const todo = [];
      R.flags.map.forEach((f, key) => { if (f.level === 'check') { const [r] = key.split(':').map(Number); if (!todo.some(t => t[0] === r + 1)) todo.push([r + 1, ...Array.from({ length: R.count }, (_, c) => val(R.rows[r].cells[c])), reasonText(f)]); } });
      if (todo.length) {
        const wr = XLSX.utils.aoa_to_sheet([[CT.t('colRow'), ...header, CT.t('colReason')], ...todo.sort((a, b) => a[0] - b[0])]);
        XLSX.utils.book_append_sheet(wb, wr, CT.t('sheetReview'));
      }
      const name = (R.fileName || 'table').replace(/\.[^.]+$/, '') + '.xlsx';
      XLSX.writeFile(wb, name);
      CT.say(CT.t('exported', { name }), 'info');
      R.steps.children[2].className = 'done'; R.steps.children[3].className = 'now';
    } catch (e) {
      CT.say(CT.t('exportFailed', { msg: e.message }), 'error');
    } finally { btn.disabled = false; btn.textContent = label; }
  }

  CT.on('results:render', render);
  CT.on('lang', () => { if (R && $('stage-result') && !$('stage-result').hidden) { render({ rows: R.rows, pages: R.pages, fileName: R.fileName }); } });
})();
