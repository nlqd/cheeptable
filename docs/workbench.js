// workbench.js — "side by side": the source page next to the table. Selecting a cell shows where it sits on the page;
// clicking the page selects the cell under the pointer. Loaded only when that layout is chosen.
'use strict';

CT.workbench = (() => {
  let zoom = 1, selectedBox = null, pane = null, getR = null, imgWrap = null, img = null, hl = null, flags = null, label = null, page = 0, selectCell = null, onImage = null;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const pct = (v, total) => (v / total * 100).toFixed(3) + '%';

  function pageInfo(p) { return CT.state.pages && CT.state.pages[p]; }

  function showPage(p) {
    const info = pageInfo(p);
    if (!info) { img.removeAttribute('src'); label.textContent = CT.t('pagesLbl', { p, n: getR().pages }); page = p; return; }
    if (page !== p || img.getAttribute('src') !== info.url) { img.src = info.url; page = p; drawFlags(); }
    img.width = info.width; img.height = info.height;       // intrinsic ratio; CSS scales it to the pane
    label.textContent = CT.t('pagesLbl', { p, n: getR().pages });
  }

  function rect(div, b, info) {
    div.style.left = pct(b.x0, info.width); div.style.top = pct(b.y0, info.height);
    div.style.width = pct(b.x1 - b.x0, info.width); div.style.height = pct(b.y1 - b.y0, info.height);
  }

  function drawFlags() {
    flags.textContent = '';
    const R = getR(), info = pageInfo(page);
    if (!R || !info) return;
    R.flags.map.forEach((f, key) => {
      if (f.level !== 'check') return;
      const [r, c] = key.split(':').map(Number);
      const row = R.rows[r];
      const box = row && row.page === page && row.cells[c] && row.cells[c]._box;
      if (!box) return;
      const d = el('div', 'fbox'); rect(d, box, info); flags.append(d);
    });
  }

  function onSelect({ r, c, row, cell }) {
    if (!pane || !row) return;
    const p = row.page || 1;
    showPage(p);
    const info = pageInfo(p);
    hl.hidden = true;
    let box = cell && cell._box;
    if (!box) {                                     // no box for this cell: mark the row's band instead
      const boxes = row.cells.map(x => x && x._box).filter(Boolean);
      if (boxes.length) box = { x0: 0, x1: info ? info.width : 0, y0: Math.min(...boxes.map(b => b.y0)), y1: Math.max(...boxes.map(b => b.y1)) };
    }
    if (box && info) {
      rect(hl, { x0: box.x0 - 4, y0: box.y0 - 3, x1: box.x1 + 4, y1: box.y1 + 3 }, info);
      hl.hidden = false;
      selectedBox = { box, info };
      scrollToBox(selectedBox);
    } else selectedBox = null;
  }

  // Bring the highlighted cell into view: a third of the way down, and centred sideways when zoomed in.
  function scrollToBox({ box, info }) {
    const wrapBox = imgWrap.getBoundingClientRect();
    const top = (box.y0 / info.height) * imgWrap.scrollHeight, left = ((box.x0 + box.x1) / 2 / info.width) * imgWrap.scrollWidth;
    imgWrap.scrollTo({ top: Math.max(0, top - wrapBox.height / 3), left: Math.max(0, left - wrapBox.width / 2), behavior: 'auto' });
  }

  function pick(e) {
    const info = pageInfo(page), R = getR();
    if (!info || !R) return;
    const b = img.getBoundingClientRect();
    const x = (e.clientX - b.left) / b.width * info.width, y = (e.clientY - b.top) / b.height * info.height;
    let best = null, bestD = Infinity;
    R.rows.forEach((row, r) => {
      if (row.page !== page) return;
      row.cells.forEach((cell, c) => {
        const bx = cell && cell._box;
        if (!bx) return;
        const dx = x < bx.x0 ? bx.x0 - x : x > bx.x1 ? x - bx.x1 : 0, dy = y < bx.y0 ? bx.y0 - y : y > bx.y1 ? y - bx.y1 : 0;
        const d = Math.hypot(dx, dy);
        if (d < bestD) { bestD = d; best = { r, c }; }
      });
    });
    if (best && bestD < 40) CT.emit('image:pick', best);
  }

  return {
    mount(container, getRows) {
      pane = container; getR = getRows;
      pane.textContent = '';
      const bar = el('div', 'panebar');
      label = el('span', 'plabel');
      const zin = el('button', 'btn quiet sm', '+'), zout = el('button', 'btn quiet sm', '\u2212'), zfit = el('button', 'btn quiet sm', CT.t('fit'));
      [zin, zout, zfit].forEach(b => { b.type = 'button'; });
      zin.setAttribute('aria-label', CT.t('zoomIn')); zout.setAttribute('aria-label', CT.t('zoomOut'));
      const setZoom = (z) => { zoom = Math.max(1, Math.min(4, z)); CT.pref.set('zoom', String(zoom)); stack.style.width = (zoom * 100) + '%'; if (selectedBox) scrollToBox(selectedBox); };
      zin.addEventListener('click', () => setZoom(zoom + 0.5)); zout.addEventListener('click', () => setZoom(zoom - 0.5)); zfit.addEventListener('click', () => setZoom(1));
      bar.append(label, zout, zin, zfit);
      imgWrap = el('div', 'imgwrap'); imgWrap.tabIndex = 0; imgWrap.setAttribute('role', 'region'); imgWrap.setAttribute('aria-label', CT.t('showPage'));
      const stack = el('div', 'stack');
      img = el('img'); img.alt = ''; img.decoding = 'async';
      flags = el('div', 'flags'); hl = el('div', 'hl'); hl.hidden = true;
      stack.append(img, flags, hl);
      imgWrap.append(stack);
      pane.append(bar, imgWrap);
      zoom = Math.max(1, Math.min(4, Number(CT.pref.get('zoom', '1.5')) || 1.5)); stack.style.width = (zoom * 100) + '%';
      selectCell = onSelect; onImage = pick;
      CT.on('cell:select', selectCell);
      img.addEventListener('click', onImage);
      CT.on('page:image', () => { if (page) showPage(page); });
      const R = getR();
      const first = R.rows.find(r => r.page) || { page: 1 };
      showPage(first.page || 1);
    },
    unmount() {
      if (selectCell) CT.off('cell:select', selectCell);
      selectCell = null; pane = null;
    },
    refreshFlags() { if (pane) drawFlags(); },
  };
})();
