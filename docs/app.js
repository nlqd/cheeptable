// app.js — the only script loaded at startup. It draws nothing heavy: it wires the drop zone, the language and mode
// preferences, and loads everything else (OCR engine, progress UI, results table, workbench) when it is first needed.
'use strict';

const CT = window.CT = { version: 1, mode: 'guided', lang: 'vi', state: {}, strings: { vi: {}, en: {} }, listeners: {} };

// ── Events: the engine reports, the UI listens ──
CT.on = (type, fn) => { (CT.listeners[type] = CT.listeners[type] || []).push(fn); };
CT.off = (type, fn) => { CT.listeners[type] = (CT.listeners[type] || []).filter(f => f !== fn); };
CT.emit = (type, data) => { (CT.listeners[type] || []).slice().forEach(fn => { try { fn(data); } catch (e) { console.error('[CT]', type, e); } }); };

// ── Preferences (a private window or blocked storage must not break the page) ──
CT.pref = {
  get(key, fallback) { try { return localStorage.getItem('ct.' + key) || fallback; } catch (e) { return fallback; } },
  set(key, value) { try { localStorage.setItem('ct.' + key, value); } catch (e) { /* not persisted */ } },
};

// ── Strings ──
CT.addStrings = (vi, en) => { Object.assign(CT.strings.vi, vi); Object.assign(CT.strings.en, en); };
CT.t = (key, params) => {
  const s = CT.strings[CT.lang][key] ?? CT.strings.vi[key] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? '') : s;
};
CT.addStrings({
  title: 'CheepTable — OCR tiếng Việt miễn phí, không quảng cáo',
  tagline: 'OCR tiếng Việt miễn phí, không quảng cáo: chuyển bảng trong PDF và ảnh sang Excel, ngay trong trình duyệt.',
  badgeFree: 'Miễn phí', badgeNoAds: 'Không quảng cáo', badgeNoSignup: 'Không cần đăng ký', badgeLocal: 'Chạy trong trình duyệt', footerFree: 'Miễn phí, không quảng cáo.',
  modeSimple: 'Đơn giản', modeGuided: 'Từng bước', modeWorkbench: 'Đối chiếu',
  modeSimpleHint: 'Chọn tệp, nhận bảng, tải Excel', modeGuidedHint: 'Bốn bước, có tiến độ chi tiết từng trang',
  modeWorkbenchHint: 'Trang gốc bên cạnh bảng, bấm ô để xem đúng chỗ',
  modeLabel: 'Cách hiển thị', langLabel: 'Ngôn ngữ',
  dropMain: 'Kéo tệp PDF hoặc ảnh vào đây', dropOr: 'hoặc bấm để chọn tệp',
  chooseFile: 'Chọn tệp', formats: 'PDF, JPG, PNG · tối đa 50 MB · hoặc dán ảnh bằng Ctrl+V', dropHere: 'Thả tệp để bắt đầu', optionsLabel: 'Tùy chọn',
  lowmemLabel: 'Tiết kiệm bộ nhớ (bật khi điện thoại bị treo hoặc tải lại giữa chừng)',
  cachedNote: 'Mô hình nhận dạng đã có sẵn trên thiết bị này: bắt đầu ngay, không cần tải lại.',
  crashed: 'Lần trước trang bị đóng đột ngột, có thể do thiếu bộ nhớ. Đã bật chế độ tiết kiệm bộ nhớ (chậm hơn nhưng ổn định hơn); tắt lại trong mục Tùy chọn.',
  privacy: 'Tệp không rời khỏi máy bạn: mọi xử lý diễn ra ngay trong trình duyệt.',
  sizeNote: 'Lần đầu cần tải khoảng {mb} MB mô hình nhận dạng (một lần, được lưu trong trình duyệt).',
  badType: 'Chỉ nhận tệp PDF hoặc ảnh (JPG, PNG, WebP). Tệp “{name}” không phải loại đó.',
  tooBig: 'Tệp quá lớn ({mb} MB). Giới hạn là {max} MB.',
  noFile: 'Chưa chọn tệp nào.', onlyFirst: 'Chỉ xử lý tệp đầu tiên: {name}.',
  loadingEngine: 'Đang nạp bộ xử lý…',
  skip: 'Bỏ qua đến nội dung chính',
}, {
  title: 'CheepTable — Free, ad-free Vietnamese OCR',
  tagline: 'Free, ad-free Vietnamese OCR: turn tables in PDFs and images into Excel, right in your browser.',
  badgeFree: 'Free', badgeNoAds: 'No ads', badgeNoSignup: 'No sign-up', badgeLocal: 'Runs in your browser', footerFree: 'Free, no ads.',
  modeSimple: 'Simple', modeGuided: 'Guided', modeWorkbench: 'Side by side',
  modeSimpleHint: 'Pick a file, get the table, download Excel', modeGuidedHint: 'Four steps with detailed per-page progress',
  modeWorkbenchHint: 'Source page beside the table; click a cell to see it in place',
  modeLabel: 'Layout', langLabel: 'Language',
  dropMain: 'Drop a PDF or an image here', dropOr: 'or click to choose a file',
  chooseFile: 'Choose file', formats: 'PDF, JPG, PNG · up to 50 MB · or paste an image with Ctrl+V', dropHere: 'Drop the file to start', optionsLabel: 'Options',
  lowmemLabel: 'Save memory (turn on if the phone freezes or reloads in the middle)',
  cachedNote: 'The recognition models are already on this device: it starts at once, nothing to download.',
  crashed: 'The page closed suddenly last time, probably for lack of memory. Low-memory mode is on (slower but steadier); switch it off under Options.',
  privacy: 'Your file never leaves your computer: everything is processed in the browser.',
  sizeNote: 'The first visit downloads about {mb} MB of recognition models (once; they stay in the browser).',
  badType: 'Only PDF files or images (JPG, PNG, WebP) are accepted. “{name}” is neither.',
  tooBig: 'This file is too large ({mb} MB). The limit is {max} MB.',
  noFile: 'No file selected.', onlyFirst: 'Only the first file is processed: {name}.',
  loadingEngine: 'Loading the engine…',
  skip: 'Skip to main content',
});

const $ = id => document.getElementById(id);

// ── Loading code and styles on demand ──
CT.loaded = {};
CT.loadScript = (url, ordered = false) => CT.loaded[url] || (CT.loaded[url] = (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await new Promise((ok, fail) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = !ordered;        // ordered scripts download in parallel but run in insertion order
        s.onload = () => ok();
        s.onerror = () => { s.remove(); fail(new Error('Could not load ' + url)); };
        document.head.appendChild(s);
      });
      return;
    } catch (e) {
      if (attempt >= 3) { delete CT.loaded[url]; e.network = true; throw e; }
      CT.emit('engine:retry', { url, attempt });
      await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }
})());
CT.loadCSS = (href) => CT.loaded[href] || (CT.loaded[href] = new Promise((ok, fail) => {
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = href; l.onload = ok; l.onerror = () => fail(new Error('Could not load ' + href));
  document.head.appendChild(l);
}));

CT.ENGINE = {
  cdn: ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.js'],
  local: ['vn_syllable_corrector.js', 'vietnamese_text_fixes_v2.js', 'confidence-tracking.js', 'boq-utils.js', 'boq-viet.js', 'boq-ocr.js',
    'boq-decode.js', 'boq-pool.js', 'boq-wire.js', 'boq-sessions.js', 'boq-onnx.js', 'boq-grid.js', 'boq-arith.js', 'boq-sequence.js', 'boq-extract.js', 'pipeline.js'],
};
// Everything the OCR job needs. Called when the visitor shows intent (pointer over the drop zone, focus, touch) and again,
// harmlessly, when a file is chosen. OpenCV (3.6 MB) and the models are fetched later, when a job really starts.
CT.preloadEngine = () => CT.engine || (CT.engine = (async () => {
  const total = CT.ENGINE.cdn.length + CT.ENGINE.local.length;
  let done = 0;
  const tick = () => CT.emit('engine:progress', { loaded: ++done, total });
  await Promise.all([
    ...CT.ENGINE.cdn.map(u => CT.loadScript(u, true).then(tick)),
    ...CT.ENGINE.local.map(u => CT.loadScript(u, true).then(tick)),
  ]);
})().catch(e => { CT.engine = null; throw e; }));

CT.ensureClipper = () => CT.loadScript('https://cdn.jsdelivr.net/npm/clipper-lib@6.4.2/clipper.js');
// Let the browser paint before a long synchronous step. requestAnimationFrame does not fire in a background tab, so a timer is the fallback.
CT.frame = () => new Promise(done => {
  let fired = false;
  const go = () => { if (!fired) { fired = true; setTimeout(done, 0); } };
  requestAnimationFrame(go);
  setTimeout(go, 80);
});
CT.ensureUI = () => Promise.all([CT.loadCSS('ui.css'), CT.loadScript('job-ui.js')]);

// ── Applying preferences to the page ──
function applyLang() {
  document.documentElement.lang = CT.lang;
  document.title = CT.t('title');
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = CT.t(el.dataset.i18n, el.dataset.mb ? { mb: el.dataset.mb } : undefined); });
  document.querySelectorAll('[data-i18n-attr]').forEach(el => {
    el.dataset.i18nAttr.split(',').forEach(pair => { const [attr, key] = pair.split(':'); el.setAttribute(attr, CT.t(key)); });
  });
  document.querySelectorAll('[data-lang-btn]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.langBtn === CT.lang)));
  CT.emit('lang', CT.lang);
}
function applyMode() {
  document.body.dataset.mode = CT.mode;
  document.querySelectorAll('input[name="mode"]').forEach(r => { r.checked = r.value === CT.mode; });
  const hint = $('modeHint');
  if (hint) hint.textContent = CT.t('mode' + CT.mode[0].toUpperCase() + CT.mode.slice(1) + 'Hint');
  CT.emit('mode', CT.mode);
}
CT.setMode = (m) => { CT.mode = m; CT.pref.set('mode', m); applyMode(); };
CT.setLang = (l) => { CT.lang = l; CT.pref.set('lang', l); applyLang(); applyMode(); };

// ── Messages for the visitor (never alert(): it blocks the page and cannot be read by assistive technology) ──
CT.say = (text, kind = 'info') => {
  const box = $('notice');
  box.textContent = text;
  box.dataset.kind = kind;
  box.hidden = !text;
};

// ── Choosing a file ──
const MAX_MB = 50;
const OK_TYPE = /\.(pdf|jpe?g|png|webp)$/i;
CT.validate = (file) => {
  if (!file) return CT.t('noFile');
  if (!OK_TYPE.test(file.name) && !/^(application\/pdf|image\/(jpeg|png|webp))$/.test(file.type)) return CT.t('badType', { name: file.name });
  const mb = file.size / 1048576;
  if (mb > MAX_MB) return CT.t('tooBig', { mb: mb.toFixed(1), max: MAX_MB });
  return '';
};

CT.start = async (files) => {
  CT.lastFile = [...(files || [])][0] || CT.lastFile;
  const list = [...(files || [])];
  const file = list[0];
  const problem = CT.validate(file);
  if (problem) { CT.say(problem, 'error'); return; }
  CT.say(list.length > 1 ? CT.t('onlyFirst', { name: file.name }) : '', 'info');
  $('fileInput').value = '';              // the same file can be chosen again after a cancel
  CT.showStage('progress');
  try {
    await CT.ensureUI();
    CT.emit('job:begin', { file });
    await CT.preloadEngine();
    await CT.runJob(file);
  } catch (e) {
    if (!CT.state.cancelled) {
      console.error(e);
      CT.emit('job:error', { message: e.message, network: !!e.network });
    }
  }
};

// Run the same file again. Models already downloaded (even partly) are not fetched twice.
CT.retry = () => { if (CT.lastFile) { CT.state.cancelled = false; CT.start([CT.lastFile]); } };

CT.showStage = (name) => {
  ['start', 'progress', 'result'].forEach(s => { const el = $('stage-' + s); if (el) el.hidden = s !== name; });
  document.body.dataset.stage = name;
  CT.emit('stage', name);
};


// ── Start ──
CT.lang = CT.pref.get('lang', 'vi') === 'en' ? 'en' : 'vi';
CT.mode = ['simple', 'guided', 'workbench'].includes(CT.pref.get('mode', 'guided')) ? CT.pref.get('mode', 'guided') : 'guided';
applyLang();
applyMode();

const drop = $('dropzone'), input = $('fileInput');
['pointerenter', 'focusin', 'touchstart'].forEach(ev => drop.addEventListener(ev, () => CT.preloadEngine().catch(() => {}), { once: true, passive: true }));
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('dragover'); CT.start(e.dataTransfer.files); });
input.addEventListener('change', e => CT.start(e.target.files));
document.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', () => CT.setMode(r.value)));
document.querySelectorAll('[data-lang-btn]').forEach(b => b.addEventListener('click', () => CT.setLang(b.dataset.langBtn)));

// ── A tab killed in the middle of a job (usually for lack of memory on a phone) leaves no trace but this flag ──
(() => {
  const was = Number(CT.pref.get('running', '0'));
  if (was && Date.now() - was < 6 * 3600e3) { CT.pref.set('lowmem', '1'); CT.say(CT.t('crashed'), 'info'); }
  CT.pref.set('running', '');
  addEventListener('pagehide', () => CT.pref.set('running', ''));            // closing or leaving normally is not a crash
  ['job:done', 'job:cancel', 'job:error'].forEach(ev => CT.on(ev, () => CT.pref.set('running', '')));
  CT.on('job:begin', () => CT.pref.set('running', String(Date.now())));
})();

const low = $('lowmem');
low.checked = CT.pref.get('lowmem', '') === '1';
low.addEventListener('change', () => CT.pref.set('lowmem', low.checked ? '1' : ''));

// ── Are the models already here? Say so: it is what the visitor wants to know on a phone ──
CT.checkModels = async () => {
  try {
    const kinds = await CTStore.cachedKinds();
    if (kinds.model) { const n = $('modelNote'); n.dataset.i18n = 'cachedNote'; n.textContent = CT.t('cachedNote'); }
  } catch (e) { /* the default note stays */ }
};
CT.checkModels();
CT.on('lang', CT.checkModels);

// ── Drop anywhere on the page, or paste a screenshot ──
let depth = 0;
const dragging = (on) => { document.body.classList.toggle('dragging', on); document.body.dataset.drop = CT.t('dropHere'); };
const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
addEventListener('dragenter', e => { if (hasFiles(e) && document.body.dataset.stage === 'start') { depth++; dragging(true); } });
addEventListener('dragleave', e => { if (hasFiles(e) && --depth <= 0) { depth = 0; dragging(false); } });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); depth = 0; dragging(false);
  if (document.body.dataset.stage === 'start' && !drop.contains(e.target)) CT.start(e.dataTransfer.files);
});
addEventListener('paste', e => {
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length && document.body.dataset.stage === 'start') { e.preventDefault(); CT.start(files); }
});

// Ask the browser to keep the models when it is short of space (the visitor has just chosen a file, so this is a user gesture)
CT.on('job:begin', () => { if (window.CTStore) CTStore.persist().then(p => { CT.state.persisted = p; }); });
