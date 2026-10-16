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
  title: 'CheepTable — Chuyển bảng PDF tiếng Việt sang Excel',
  modeSimple: 'Đơn giản', modeGuided: 'Từng bước', modeWorkbench: 'Đối chiếu',
  modeSimpleHint: 'Chọn tệp, nhận bảng, tải Excel', modeGuidedHint: 'Bốn bước, có tiến độ chi tiết từng trang',
  modeWorkbenchHint: 'Trang gốc bên cạnh bảng, bấm ô để xem đúng chỗ',
  modeLabel: 'Cách hiển thị', langLabel: 'Ngôn ngữ',
  sampleBtn: 'Thử với tệp mẫu', dropMain: 'Kéo tệp PDF hoặc ảnh vào đây', dropOr: 'hoặc bấm để chọn tệp',
  privacy: 'Tệp không rời khỏi máy bạn: mọi xử lý diễn ra ngay trong trình duyệt.',
  sizeNote: 'Lần đầu cần tải khoảng {mb} MB mô hình nhận dạng (một lần, được lưu trong trình duyệt).',
  badType: 'Chỉ nhận tệp PDF hoặc ảnh (JPG, PNG, WebP). Tệp “{name}” không phải loại đó.',
  tooBig: 'Tệp quá lớn ({mb} MB). Giới hạn là {max} MB.',
  noFile: 'Chưa chọn tệp nào.', onlyFirst: 'Chỉ xử lý tệp đầu tiên: {name}.',
  loadingEngine: 'Đang nạp bộ xử lý…',
  skip: 'Bỏ qua đến nội dung chính',
}, {
  title: 'CheepTable — Vietnamese PDF tables to Excel',
  modeSimple: 'Simple', modeGuided: 'Guided', modeWorkbench: 'Side by side',
  modeSimpleHint: 'Pick a file, get the table, download Excel', modeGuidedHint: 'Four steps with detailed per-page progress',
  modeWorkbenchHint: 'Source page beside the table; click a cell to see it in place',
  modeLabel: 'Layout', langLabel: 'Language',
  sampleBtn: 'Try the sample file', dropMain: 'Drop a PDF or an image here', dropOr: 'or click to choose a file',
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
CT.loadScript = (url, ordered = false) => CT.loaded[url] || (CT.loaded[url] = new Promise((ok, fail) => {
  const s = document.createElement('script');
  s.src = url;
  s.async = !ordered;        // ordered scripts download in parallel but run in insertion order
  s.onload = ok;
  s.onerror = () => { delete CT.loaded[url]; fail(new Error('Could not load ' + url)); };
  document.head.appendChild(s);
}));
CT.loadCSS = (href) => CT.loaded[href] || (CT.loaded[href] = new Promise((ok, fail) => {
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = href; l.onload = ok; l.onerror = () => fail(new Error('Could not load ' + href));
  document.head.appendChild(l);
}));

CT.ENGINE = {
  cdn: ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.js'],
  local: ['vn_syllable_corrector.js', 'vietnamese_text_fixes_v2.js', 'confidence-tracking.js', 'boq-utils.js', 'boq-viet.js', 'boq-ocr.js',
    'boq-decode.js', 'boq-pool.js', 'boq-onnx.js', 'boq-grid.js', 'boq-arith.js', 'boq-sequence.js', 'boq-extract.js', 'pipeline.js'],
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
      CT.emit('job:error', { message: e.message });
    }
  }
};

CT.showStage = (name) => {
  ['start', 'progress', 'result'].forEach(s => { const el = $('stage-' + s); if (el) el.hidden = s !== name; });
  document.body.dataset.stage = name;
  CT.emit('stage', name);
};

CT.loadSample = async () => {
  const res = await fetch('sample.pdf');
  if (!res.ok) { CT.say(CT.t('badType', { name: 'sample.pdf' }), 'error'); return; }
  CT.start([new File([await res.blob()], 'sample.pdf', { type: 'application/pdf' })]);
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
$('sampleBtn').addEventListener('click', CT.loadSample);
document.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', () => CT.setMode(r.value)));
document.querySelectorAll('[data-lang-btn]').forEach(b => b.addEventListener('click', () => CT.setLang(b.dataset.langBtn)));
