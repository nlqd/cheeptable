// job-ui.js — live progress for a running job. Loaded when a file is chosen (not at startup). It only listens to CT events,
// batches DOM writes to animation frames, and shows: bytes of the model download, a strip of pages whose image fills in
// as cells are read, a transcript of what was just recognised, elapsed time and an ETA from measured throughput.
'use strict';

CT.addStrings({
  jobTitle: 'Đang xử lý “{name}”', stepFile: 'Chọn tệp', stepRead: 'Nhận dạng', stepCheck: 'Kiểm tra', stepDownload: 'Tải Excel',
  stEngine: 'Đang nạp bộ xử lý ({n}/{m})…', stModels: 'Đang tải mô hình nhận dạng: {a} / {b} MB', stModelsCached: 'Đang khởi động mô hình…',
  stSessions: 'Đang khởi động mô hình…', stOpen: 'Đang mở tệp…',
  stRender: 'Trang {p}/{n}: đang dựng ảnh trang', stGrid: 'Trang {p}/{n}: đang tìm khung bảng', stRead: 'Trang {p}/{n}: đã đọc {d}/{t} ô',
  stText: 'Trang {p}/{n}: lấy chữ có sẵn trong PDF', stBuild: 'Đang dựng bảng và kiểm tra số liệu…',
  pagesLbl: 'Trang {p}/{n}', cellsLbl: '{d}/{t} ô', elapsed: 'Đã chạy {t}', eta: 'còn khoảng {t}', etaWait: 'đang ước lượng thời gian…', dlRate: '{r} MB/giây',
  secs: '{n} giây', mins: '{m} phút {s} giây', minsOnly: '{m} phút',
  pgWait: 'chờ', pgRender: 'dựng ảnh', pgGrid: 'tìm khung', pgRead: 'đang đọc', pgDone: 'xong', pgText: 'chữ có sẵn', pgError: 'lỗi',
  cancel: 'Hủy', cancelled: 'Đã hủy. Bạn có thể chọn tệp khác.', again: 'Chọn tệp khác',
  failed: 'Không xử lý được tệp: {msg}', retryHint: 'Thử tệp nhỏ hơn, tải lại trang, hoặc dùng trình duyệt khác.',
  barLabel: 'Tiến độ xử lý', announceDone: 'Đã xong bước nhận dạng.', announcePct: 'Đã được {p} phần trăm.',
  pageImg: 'Ảnh trang {p}',
  retrying: 'Kết nối chập chờn, đang thử lại ({a}/{m})…', pageRetry: 'Trang {p} gặp lỗi, đang thử lại…', retryBtn: 'Thử lại',
  netFailed: 'Không tải được dữ liệu cần thiết, có thể do mạng chập chờn. Phần đã tải được giữ lại nên lần thử lại sẽ nhanh hơn.',
}, {
  jobTitle: 'Processing “{name}”', stepFile: 'Choose file', stepRead: 'Recognise', stepCheck: 'Review', stepDownload: 'Download Excel',
  stEngine: 'Loading the engine ({n}/{m})…', stModels: 'Downloading recognition models: {a} / {b} MB', stModelsCached: 'Starting the models…',
  stSessions: 'Starting the models…', stOpen: 'Opening the file…',
  stRender: 'Page {p}/{n}: rendering the page', stGrid: 'Page {p}/{n}: finding the table frame', stRead: 'Page {p}/{n}: read {d}/{t} cells',
  stText: 'Page {p}/{n}: taking the text already in the PDF', stBuild: 'Building the table and checking the numbers…',
  pagesLbl: 'Page {p}/{n}', cellsLbl: '{d}/{t} cells', elapsed: 'Running {t}', eta: 'about {t} left', etaWait: 'estimating the time left…', dlRate: '{r} MB/s',
  secs: '{n} s', mins: '{m} min {s} s', minsOnly: '{m} min',
  pgWait: 'waiting', pgRender: 'rendering', pgGrid: 'finding frame', pgRead: 'reading', pgDone: 'done', pgText: 'embedded text', pgError: 'error',
  cancel: 'Cancel', cancelled: 'Cancelled. You can choose another file.', again: 'Choose another file',
  failed: 'The file could not be processed: {msg}', retryHint: 'Try a smaller file, reload the page, or use another browser.',
  barLabel: 'Processing progress', announceDone: 'Recognition finished.', announcePct: '{p} percent done.',
  pageImg: 'Page {p} image',
  retrying: 'The connection is unstable, trying again ({a}/{m})…', pageRetry: 'Page {p} hit an error, trying again…', retryBtn: 'Try again',
  netFailed: 'The data needed could not be downloaded, probably because of an unstable connection. What was already downloaded is kept, so trying again will be faster.',
});

(() => {
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const mb = (bytes) => (bytes / 1048576).toFixed(1).replace('.', CT.lang === 'vi' ? ',' : '.');
  const fmt = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return CT.t('secs', { n: s });
    const m = Math.floor(s / 60);
    return s % 60 ? CT.t('mins', { m, s: s % 60 }) : CT.t('minsOnly', { m });
  };

  // ── Job state the UI is drawn from ──
  let S, ui, raf = 0, ticker = 0, lastAnnounce = { stage: '', pct: -1 };
  const fresh = (file) => ({
    file, t0: performance.now(), stage: 'engine', engine: { n: 0, m: 0 }, models: new Map(), modelsCached: false, pages: new Map(), numPages: 0,
    cur: 0, reads: [], readTotal: {}, transcript: [], pending: [], text: '', pct: 0,
  });

  // ── DOM ──
  function build() {
    const root = $('stage-progress');
    root.textContent = '';
    const head = el('div', 'jobhead');
    head.append(Object.assign(el('h2', '', ''), { id: 'jobTitle', tabIndex: -1 }));
    const steps = el('ol', 'steps');
    ['stepFile', 'stepRead', 'stepCheck', 'stepDownload'].forEach((k, i) => {
      const li = el('li', i === 0 ? 'done' : i === 1 ? 'now' : '');
      li.append(el('span', 'n', String(i + 1)), el('span', '', ''));
      li.dataset.key = k;
      steps.append(li);
    });
    const status = el('p', 'status'); status.id = 'jobStatus';
    const bar = el('div', 'bar'); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', '0');
    bar.append(el('span'));
    const meters = el('p', 'meters');
    const mPages = el('span'), mCells = el('span'), mElapsed = el('span'), mEta = el('span');
    meters.append(mPages, mCells, mElapsed, mEta);
    const models = el('div', 'models'); models.hidden = true;
    const mBar = el('div', 'minibar'); mBar.append(el('span')); models.append(el('span', 'mtext'), mBar);
    const pages = el('ol', 'pages'); pages.setAttribute('aria-label', '');
    const tick = el('div', 'ticker'); tick.setAttribute('aria-hidden', 'true');
    const live = el('p', 'sr'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
    const cancel = el('button', 'btn quiet', ''); cancel.type = 'button'; cancel.id = 'cancelBtn'; cancel.addEventListener('click', () => CT.cancel());
    const end = el('div', 'endmsg'); end.hidden = true;
    head.append(steps);
    root.append(head, status, bar, meters, models, pages, tick, live, cancel, end);
    ui = { head, title: head.firstChild, steps, status, bar, barFill: bar.firstChild, mPages, mCells, mElapsed, mEta, models, mText: models.firstChild, mFill: mBar.firstChild, pages, tick, live, cancel, end };
    root.dataset.progress = '';
    ui.cancel.textContent = CT.t('cancel');
    ui.bar.setAttribute('aria-label', CT.t('barLabel'));
    ui.title.textContent = CT.t('jobTitle', { name: S.file.name });
    steps.querySelectorAll('li').forEach(li => { li.lastChild.textContent = CT.t(li.dataset.key); });
  }

  function pageItem(p) {
    let it = S.pages.get(p);
    if (it) return it;
    const li = el('li', 'pg');
    const box = el('div', 'thumb');
    const label = el('div', 'pgl');
    const name = el('span', 'pgn', CT.t('pagesLbl', { p, n: S.numPages }));
    const state = el('span', 'pgs', CT.t('pgWait'));
    label.append(name, state);
    li.append(box, label);
    it = { li, box, state, base: null, over: null, scale: 1, status: 'wait', done: 0, total: 0, kind: '' };
    S.pages.set(p, it);
    ui.pages.append(li);
    return it;
  }

  // ── Progress arithmetic ──
  function pageFraction(it) {
    if (it.status === 'done') return 1;
    if (it.status === 'render') return 0.04;
    if (it.status === 'grid') return 0.08;
    if (it.status === 'read') return 0.1 + 0.88 * (it.total ? it.done / it.total : 0);
    return 0;
  }
  function modelsFraction() {
    if (S.modelsCached || !S.models.size) return S.modelsReady || S.modelsCached ? 1 : 0;
    let a = 0, b = 0;
    S.models.forEach(m => { a += m.loaded; b += m.total; });
    return b ? a / b : 0;
  }
  function overall() {
    const prep = Math.min(1, 0.25 * (S.engine.m ? S.engine.n / S.engine.m : 0) + 0.75 * modelsFraction());
    const pages = S.numPages ? [...Array(S.numPages).keys()].reduce((s, i) => s + (S.pages.get(i + 1) ? pageFraction(S.pages.get(i + 1)) : 0), 0) / S.numPages : 0;
    if (S.stage === 'build') return 0.96;
    if (S.stage === 'done') return 1;
    return Math.min(0.95, 0.1 * prep + 0.86 * pages);
  }
  // Throughput from the last few seconds of reads; the total is known for pages seen so far and guessed for the rest.
  function eta(now) {
    S.reads = S.reads.filter(t => now - t < 8000);
    const totals = Object.values(S.readTotal);
    if (!totals.length || S.reads.length < 8) return null;
    const rate = S.reads.length / Math.min(8000, now - S.reads[0] + 1) * 1000;
    const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
    let remaining = 0;
    for (let p = 1; p <= S.numPages; p++) {
      const it = S.pages.get(p);
      if (it && it.status === 'done') continue;
      remaining += it && it.total ? Math.max(0, it.total - it.done) : avg;
    }
    return remaining / rate * 1000 + 2000;
  }

  // ── Drawing (batched) ──
  function schedule() { if (!raf) raf = requestAnimationFrame(draw); }
  function statusText() {
    const p = S.cur, n = S.numPages, it = S.pages.get(p);
    switch (S.stage) {
      case 'engine': return CT.t('stEngine', { n: S.engine.n, m: S.engine.m });
      case 'models': {
        let a = 0, b = 0; S.models.forEach(m => { a += m.loaded; b += m.total; });
        return b > 1000 ? CT.t('stModels', { a: mb(a), b: mb(b) }) : CT.t('stSessions');
      }
      case 'open': return CT.t('stOpen');
      case 'build': return CT.t('stBuild');
      default:
        if (!it) return CT.t('stOpen');
        if (it.status === 'render') return CT.t('stRender', { p, n });
        if (it.status === 'grid') return CT.t('stGrid', { p, n });
        if (it.status === 'text') return CT.t('stText', { p, n });
        return CT.t('stRead', { p, n, d: it.done, t: it.total });
    }
  }
  const STATE_LABEL = { wait: 'pgWait', render: 'pgRender', grid: 'pgGrid', read: 'pgRead', done: 'pgDone', text: 'pgText', error: 'pgError' };
  function draw() {
    raf = 0;
    if (!S) return;
    const now = performance.now();
    const pct = Math.round(overall() * 100);
    ui.barFill.style.width = pct + '%';
    const busy = S.stage !== 'done' && (S.stage === 'build' || S.stage === 'open' || [...S.pages.values()].some(i => i.status === 'render' || i.status === 'grid'));
    if (busy) ui.bar.setAttribute('data-busy', ''); else ui.bar.removeAttribute('data-busy');
    ui.bar.setAttribute('aria-valuenow', String(pct));
    const note = S.notice && now < S.noticeUntil ? S.notice : null;
    ui.status.textContent = note || statusText();
    ui.status.dataset.warn = note ? '1' : '';
    const doneCells = [...S.pages.values()].reduce((s, i) => s + i.done, 0), allCells = [...S.pages.values()].reduce((s, i) => s + i.total, 0);
    ui.mPages.textContent = S.numPages ? CT.t('pagesLbl', { p: Math.max(S.cur, 1), n: S.numPages }) : '';
    ui.mCells.textContent = allCells ? CT.t('cellsLbl', { d: doneCells, t: allCells }) : '';
    ui.mElapsed.textContent = CT.t('elapsed', { t: fmt(now - S.t0) });
    const e = eta(now);
    ui.mEta.textContent = S.stage === 'read' || S.stage === 'pages' ? (e == null ? CT.t('etaWait') : CT.t('eta', { t: fmt(e) })) : '';
    if (S.stage === 'models' && S.dl && S.dl.length > 3) {                 // download: rate over the last 3 s and time left
      const [t1, b1] = S.dl[0], [t2, b2] = S.dl[S.dl.length - 1];
      let total = 0; S.models.forEach(m => { total += m.total; });
      const rate = (b2 - b1) / Math.max(1, t2 - t1) * 1000;
      if (rate > 1000 && total > b2) ui.mEta.textContent = CT.t('dlRate', { r: mb(rate) }) + ' · ' + CT.t('eta', { t: fmt((total - b2) / rate * 1000) });
    }

    // download of the models
    if (S.stage === 'models' && S.models.size && !S.modelsCached) {
      let a = 0, b = 0; S.models.forEach(m => { a += m.loaded; b += m.total; });
      ui.models.hidden = false;
      ui.mText.textContent = CT.t('stModels', { a: mb(a), b: mb(b) });
      ui.mFill.style.width = (b ? a / b * 100 : 0) + '%';
    } else ui.models.hidden = true;

    // pages: labels and live boxes on the thumbnails
    S.pages.forEach((it) => {
      const label = CT.t(STATE_LABEL[it.status]) + (it.status === 'read' && it.total ? ' ' + it.done + '/' + it.total : '');
      if (it.state.textContent !== label) it.state.textContent = label;
      it.li.dataset.status = it.status;
    });
    S.pending.splice(0).forEach(r => {
      const it = S.pages.get(r.page);
      if (!it || !it.over) return;
      const g = it.over.getContext('2d');
      g.fillStyle = r.conf >= 0.85 ? 'rgba(4,120,87,.55)' : 'rgba(217,119,6,.75)';
      const b = r.box, k = it.scale;
      g.fillRect(b.x0 * k, b.y0 * k, Math.max(1, (b.x1 - b.x0) * k), Math.max(1.5, (b.y1 - b.y0) * k));
    });
    if (S.transcriptDirty) {
      S.transcriptDirty = false;
      ui.tick.textContent = '';
      S.transcript.forEach(t => ui.tick.append(el('span', '', t)));
    }

    // spoken updates: only when the stage changes or progress crosses a 10% step
    const step = Math.floor(pct / 10) * 10;
    if (S.stage !== lastAnnounce.stage || (step !== lastAnnounce.pct && step > 0 && step < 100)) {
      ui.live.textContent = S.stage !== lastAnnounce.stage ? statusText() : CT.t('announcePct', { p: step });
      lastAnnounce = { stage: S.stage, pct: step };
    }
  }

  // ── Events ──
  CT.on('job:begin', ({ file }) => {
    clearInterval(ticker);
    S = fresh(file);
    lastAnnounce = { stage: '', pct: -1 };
    build();
    ui.title.focus({ preventScroll: true });
    ticker = setInterval(schedule, 250);       // elapsed time and ETA move even between engine events
    schedule();
  });
  CT.on('engine:progress', (e) => { if (!S) return; S.engine = { n: e.loaded, m: e.total }; S.stage = 'engine'; schedule(); });
  CT.on('job:start', () => { if (!S) return; S.stage = 'open'; schedule(); });
  CT.on('pdf:loaded', (e) => { if (!S) return; S.numPages = e.pages; S.stage = 'pages'; for (let p = 1; p <= e.pages; p++) pageItem(p); schedule(); });
  CT.on('models:start', () => { if (!S) return; S.stage = 'models'; schedule(); });
  CT.on('model:progress', (e) => {
    if (!S) return;
    if (e.cached) { S.modelsCached = true; } else {
      const m = S.models.get(e.url) || { loaded: 0, total: e.total };
      m.loaded = e.loaded; m.total = e.total; S.models.set(e.url, m);
      const now = performance.now(), got = [...S.models.values()].reduce((s, x) => s + x.loaded, 0);
      (S.dl = S.dl || []).push([now, got]);
      S.dl = S.dl.filter(([t]) => now - t < 3000);
    }
    schedule();
  });
  CT.on('models:ready', () => { if (!S) return; S.modelsReady = true; S.stage = 'pages'; schedule(); });
  CT.on('page:start', ({ page }) => { if (!S) return; S.cur = page; S.stage = 'pages'; pageItem(page); schedule(); });
  CT.on('page:status', ({ page, status }) => { if (!S) return; pageItem(page).status = status; S.cur = page; schedule(); });
  CT.on('page:render', ({ page, thumb, width }) => {
    if (!S) return;
    const it = pageItem(page);
    thumb.className = 'base'; thumb.setAttribute('role', 'img'); thumb.setAttribute('aria-label', CT.t('pageImg', { p: page }));
    const over = document.createElement('canvas'); over.width = thumb.width; over.height = thumb.height; over.className = 'over'; over.setAttribute('aria-hidden', 'true');
    it.box.textContent = ''; it.box.append(thumb, over);
    it.base = thumb; it.over = over; it.scale = thumb.width / width;
    schedule();
  });
  CT.on('page:grid', ({ page }) => { if (!S) return; pageItem(page).status = 'read'; schedule(); });
  CT.on('page:reads', ({ page, total }) => { if (!S) return; const it = pageItem(page); it.total = total; it.done = 0; it.status = 'read'; S.readTotal[page] = total; schedule(); });
  CT.on('read', (r) => {
    if (!S) return;
    const it = pageItem(r.page);
    it.done = r.done; it.total = r.total;
    S.reads.push(performance.now());
    S.pending.push(r);
    const text = (r.text || '').trim();
    if (text) { S.transcript.push(text.length > 38 ? text.slice(0, 37) + '…' : text); if (S.transcript.length > 6) S.transcript.shift(); S.transcriptDirty = true; }
    schedule();
  });
  CT.on('page:done', ({ page, kind }) => { if (!S) return; const it = pageItem(page); it.status = kind === 'text' ? 'text' : 'done'; if (kind === 'text') it.done = it.total = 0; schedule(); });
  CT.on('page:error', ({ page }) => { if (!S) return; pageItem(page).status = 'error'; schedule(); });
  const warn = (text) => { if (!S) return; S.notice = text; S.noticeUntil = performance.now() + 5000; if (ui) ui.live.textContent = text; schedule(); };
  CT.on('model:retry', (e) => warn(CT.t('retrying', { a: e.attempt, m: e.max })));
  CT.on('engine:retry', (e) => warn(CT.t('retrying', { a: e.attempt, m: 3 })));
  CT.on('page:retry', (e) => warn(CT.t('pageRetry', { p: e.page })));
  CT.on('build:start', () => { if (!S) return; S.stage = 'build'; ui.steps.children[1].className = 'now'; schedule(); });

  CT.ensureResults = () => Promise.all([CT.loadScript('results-core.js', true), CT.loadScript('results.js', true), CT.mode === 'workbench' ? CT.loadScript('workbench.js') : null]);
  CT.on('build:fixes', (f) => { CT.state.fixes = f; });
  CT.on('job:done', async (data) => {
    if (!S) return;
    S.stage = 'done'; schedule();
    clearInterval(ticker);
    await CT.ensureResults();
    ui.steps.children[1].className = 'done'; ui.steps.children[2].className = 'now';
    CT.showStage('result');
    CT.emit('results:render', data);
  });
  const finish = (message, kind) => {
    clearInterval(ticker);
    if (!ui) { CT.say(message, kind); CT.showStage('start'); return; }
    ui.cancel.hidden = true;
    ui.end.hidden = false;
    ui.end.textContent = '';
    ui.end.append(el('p', kind === 'error' ? 'bad' : '', message));
    const row = el('div', 'endbtns');
    const other = el('button', kind === 'error' ? 'btn quiet' : 'btn', CT.t('again')); other.type = 'button';
    other.addEventListener('click', () => { CT.showStage('start'); $('fileInput').focus(); });
    if (kind === 'error' && CT.lastFile) {
      const retry = el('button', 'btn', CT.t('retryBtn')); retry.type = 'button';
      retry.addEventListener('click', () => CT.retry());
      row.append(retry, other);
      ui.end.append(row);
      retry.focus();
    } else { row.append(other); ui.end.append(row); other.focus(); }
  };
  CT.on('job:cancel', () => { if (S && !S.finished) { S.finished = true; finish(CT.t('cancelled'), 'info'); } });
  CT.on('job:error', ({ message, network }) => { if (S) { S.finished = true; finish(network ? CT.t('netFailed') : CT.t('failed', { msg: message }) + ' ' + CT.t('retryHint'), 'error'); } });
  CT.on('lang', () => { if (S && ui) { ui.cancel.textContent = CT.t('cancel'); ui.title.textContent = CT.t('jobTitle', { name: S.file.name }); ui.steps.querySelectorAll('li').forEach(li => { li.lastChild.textContent = CT.t(li.dataset.key); }); schedule(); } });
})();
