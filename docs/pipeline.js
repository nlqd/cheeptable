// pipeline.js — runs one job: PDF or image in, table rows out. It does not touch the page; it reports through CT.emit so any
// layout (simple, guided, side by side) can show live progress. Loaded with the OCR engine, never at startup.
'use strict';

// ── Config the engine files expect as globals ──
const LINE_TOLERANCE = 3;
const MIN_LINE_LEN = 10;
const CELL_PAD = 1.5;
const OCR_SCALE = 200 / 72;
const CELL_MATCH_MARGIN_PX   = 30;
const ORPHAN_NEAREST_CELL_PX = 100;
const ROW_Y_THRESHOLD_PX     = 10;
const IMAGE_MAX_SIDE_PX = 2400;   // photos are scaled down to about the size of a 200 dpi page

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const perfStart = () => {};
const perfEnd = () => {};

// Stubs for globals the older extraction files still reference
const OCR_SERVER_URL = '';
let ocrServerAvailable = false;
let vpsApiAvailable = false;
let diacriticCache = {};
let debugData = { ocrWords: [], ocrLines: [], pdfMetadata: null };
function authHeaders() { return {}; }
function clearAuthToken() {}
function showVizPanel() {}

// State the extraction and review files read
let extractedRows = [];
let currentOCRPage = 0;
let totalPDFPages = 0;
let opencvReady = false;
let syllableCorrector = null;
let pdfDoc = null;
let rowFlags = {};
let flagList = [];
let currFlagIdx = -1;
let onnxBackendAvailable = null;

function log(msg, cls = '') {
  (CT.logs = CT.logs || []).push({ msg, cls, at: Date.now() });
  console.debug('[CT]', msg);
}

// ── OpenCV.js: cv.imread exists before the WASM runtime has started, so it is no readiness signal; cv.then() fires once it is up ──
CT.opencv = () => CT.loadScript('opencv.js').then(() => new Promise(ok => {
  cv.then(() => { opencvReady = true; log('OpenCV.js loaded', 'ok'); ok(); });
}));

// ── A picture as a one-page document, with the few methods the pipeline calls on a pdf.js page ──
async function imageAsPdf(file) {
  const bitmap = await createImageBitmap(file);
  const k = Math.min(1, IMAGE_MAX_SIDE_PX / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * k), h = Math.round(bitmap.height * k);
  const page = {
    getViewport: ({ scale }) => ({ width: w / OCR_SCALE * scale, height: h / OCR_SCALE * scale, scale }),
    getTextContent: async () => ({ items: [] }),
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    render: ({ canvasContext, viewport }) => ({ promise: Promise.resolve(canvasContext.drawImage(bitmap, 0, 0, viewport.width, viewport.height)) }),
    cleanup() { bitmap.close(); },
  };
  return { numPages: 1, getPage: async () => page };
}

const isImageFile = (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name);
const cancelled = () => CT.state.cancelled === true;

function thumbOf(canvas, width = 168) {
  const t = document.createElement('canvas');
  t.width = width;
  t.height = Math.round(canvas.height * width / canvas.width);
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return t;
}

// ── The job ──
CT.runJob = async function (file) {
  Object.values((CT.state && CT.state.pages) || {}).forEach(pg => URL.revokeObjectURL(pg.url));
  CT.state = { cancelled: false, done: false, pages: {}, startedAt: performance.now() };
  extractedRows = [];
  const cvReady = CT.opencv().catch(e => log('OpenCV failed: ' + e.message, 'err'));
  CT.emit('job:start', { name: file.name, size: file.size });

  const pdf = isImageFile(file)
    ? await imageAsPdf(file)
    : await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  pdfDoc = pdf;
  const numPages = pdf.numPages;
  totalPDFPages = numPages;
  CT.emit('pdf:loaded', { pages: numPages });
  log('PDF loaded: ' + numPages + ' pages', 'ok');

  const allTextItems = [], allLines = [];
  const allOcrWords = [], allOcrLines = [], allBorderCells = [];
  let poolReady = null;
  let ocrPageCount = 0;

  for (let p = 1; p <= numPages; p++) {
    if (cancelled()) { CT.emit('job:cancel'); return; }
    CT.emit('page:start', { page: p, pages: numPages });
    await CT.frame();

    const page = await pdf.getPage(p);
    const pageH = page.getViewport({ scale: 1.0 }).height;
    const tc = await page.getTextContent();
    const pageText = tc.items.filter(it => it.str.trim()).map(it => ({
      str: it.str, x: it.transform[4], y: pageH - it.transform[5], width: it.width,
      height: Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || 10, page: p,
    }));

    if (pageText.length > 0) {
      const pageLines = extractLines(await page.getOperatorList(), pageH, p);
      log('  Page ' + p + ': ' + pageText.length + ' text spans, ' + pageLines.length + ' lines (native)');
      allTextItems.push(...pageText);
      allLines.push(...pageLines);
      CT.emit('page:done', { page: p, kind: 'text', words: pageText.length });
    } else {
      if (!onnxBackendAvailable) {
        CT.emit('models:start', {});
        const ok = await initOnnxOCR((msg) => CT.emit('models:status', { message: msg }));
        if (!ok) throw (CT.state.initError || new Error('ONNX initialization failed'));
        onnxBackendAvailable = true;
        CT.emit('models:ready', { gpu: _encoderOnGpu });
      }
      await cvReady;
      if (!poolReady) poolReady = startOcrPool();   // workers start while the page is rendered and its grid is found

      CT.emit('page:status', { page: p, status: 'render' });
      await CT.frame();
      const canvas = await renderPageToCanvas(page, OCR_SCALE);
      CT.emit('page:render', { page: p, thumb: thumbOf(canvas), width: canvas.width, height: canvas.height });
      canvas.toBlob(b => { if (b) { CT.state.pages[p] = { url: URL.createObjectURL(b), width: canvas.width, height: canvas.height }; CT.emit('page:image', { page: p }); } }, 'image/jpeg', 0.75);

      // Ruled tables: read the cells of the drawn grid directly. Anything else: text detector.
      CT.emit('page:status', { page: p, status: 'grid' });
      await CT.frame();
      let borderData = { cells: [], lines: { horizontal: [], vertical: [] } };
      const grid = opencvReady ? await findGrid(canvas) : null;
      if (!grid && opencvReady) {
        borderData = await detectTableBorders(canvas);
      }
      CT.emit('page:grid', { page: p, mode: grid ? 'grid' : 'detector', cols: grid ? grid.xs.length - 1 : 0, rows: grid ? grid.ys.length - 1 : 0 });

      currentOCRPage = p;
      try {
        CT.emit('page:status', { page: p, status: 'read' });
        let ocrResult;
        for (let attempt = 1; ; attempt++) {       // one automatic second try, on fresh workers, before the page is given up
          try {
            await poolReady;                       // reads must not start on the page thread by accident
            ocrResult = grid ? await ocrPageWithGrid(canvas, p, grid) : await ocrPageWithOnnx(canvas, p);
            break;
          } catch (err) {
            if (cancelled() || attempt >= 2) throw err;
            log('  Page ' + p + ': retrying after ' + err.message, 'warn');
            CT.emit('page:retry', { page: p, message: err.message });
            stopOcrPool(); poolReady = startOcrPool();
          }
        }
        if (grid) {
          log('  Page ' + p + ': ruled grid ' + (grid.xs.length - 1) + ' columns x ' + (grid.ys.length - 1) + ' rows', 'ok');
          borderData = { cells: ocrResult.cells, lines: { horizontal: [], vertical: [] } };
        }
        ocrPageCount++;
        const pageWords = ocrResult.words;
        log('  Page ' + p + ': ' + pageWords.length + ' OCR words', 'ok');
        allOcrWords.push(...pageWords);
        allOcrLines.push(...ocrResult.lines);
        if (borderData && borderData.cells.length > 0) {
          allBorderCells.push(...borderData.cells.map(cell => ({
            x: cell.x / OCR_SCALE, y: cell.y / OCR_SCALE, width: cell.width / OCR_SCALE, height: cell.height / OCR_SCALE,
            area: cell.area / (OCR_SCALE * OCR_SCALE), row: cell.row, col: cell.col, page: p,
          })));
        }
        CT.emit('page:done', { page: p, kind: grid ? 'grid' : 'detector', words: pageWords.length });
      } catch (error) {
        if (cancelled()) { CT.emit('job:cancel'); return; }
        log('  Page ' + p + ': OCR error - ' + error.message, 'err');
        console.error('[OCR Error] Page ' + p + ':', error);
        (CT.state.failedPages = CT.state.failedPages || []).push(p);
        CT.emit('page:error', { page: p, message: error.message });
        continue;
      }
    }
    page.cleanup();
  }

  stopOcrPool();
  if (cancelled()) { CT.emit('job:cancel'); return; }

  // Pass 2: table extraction
  CT.emit('build:start', {});
  await CT.frame();
  let rows;
  if (allOcrWords.length > 0) {
    log('OCR total: ' + allOcrWords.length + ' words across ' + ocrPageCount + ' pages', 'ok');
    rows = await ocrTableExtract(allOcrLines, allOcrWords, allBorderCells);
    const seq = repairNumbering(rows).fixed;
    if (seq > 0) log('Fixed ' + seq + ' misread row numbers (they count up by one)', 'ok');
    const { fixed } = repairArithmetic(rows);
    if (fixed > 0) log('Fixed misread numbers in ' + fixed + ' rows (qty x price = total)', 'ok');
    CT.emit('build:fixes', { numbering: seq, arithmetic: fixed });
  } else if (allLines.length > 20) {
    log('Using LATTICE mode (lines detected)', 'ok');
    rows = await latticeExtract(allTextItems, allLines, numPages);
  } else {
    log('Using alternative table detection method...', 'ok');
    rows = await textClusterExtract(allTextItems);
  }

  extractedRows = rows;
  CT.state.done = true;
  CT.state.pageCount = numPages;
  CT.state.fileName = file.name;
  log('Extracted ' + rows.length + ' rows', 'ok');
  CT.emit('job:done', { rows, pages: numPages, fileName: file.name });
};

CT.cancel = () => {
  CT.state.cancelled = true;
  stopOcrPool();          // workers stop at once; reads in flight fail and the page loop sees the flag
  CT.emit('job:cancel');
};
