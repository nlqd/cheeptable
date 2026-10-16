// boq-onnx.js — ONNX browser OCR: PaddleOCR detection + VietOCR recognition
// Mirrors ocr_server.py hybrid pipeline entirely client-side.
'use strict';

// ── Configuration ──
const ONNX_MODEL_BASE = 'https://huggingface.co/dzngo/vietocr-models/resolve/main';
const ONNX_MODELS = {
  det:     `${ONNX_MODEL_BASE}/paddleocr/det_v3.onnx`,
  encoder: `${ONNX_MODEL_BASE}/vietocr/encoder_fp16.onnx`,
  // 30 MB instead of 55 MB. Static int8 (QDQ) with the first conv kept float; on the 473-row contract it matches fp32
  // (description error 0.065, numbers 0.945 vs 0.947). Dynamic int8 would need ConvInteger, which onnxruntime-web lacks.
  // Runs on the WASM backend only; WebGPU keeps the fp16 encoder.
  encoderInt8: `${ONNX_MODEL_BASE}/vietocr/encoder_int8.onnx`,
  // 55 MB, for WebGPU: fp16 weights, fp32 compute (cast folded at load). About 8 ms per line against 80-340 ms on the CPU.
  encoderGpu: `${ONNX_MODEL_BASE}/vietocr/encoder_fp16w.onnx`,
  // Same graphs with the weights stored as int8 and a per-row scale (hillclimb/weight_only.py), computed in fp32: about half
  // the size and no measurable accuracy change (description error 0.0218 vs 0.0220 on 576 lines).
  encoderGpuW8: `${ONNX_MODEL_BASE}/vietocr/encoder_w8.onnx`,
  decoderInitW8: `${ONNX_MODEL_BASE}/vietocr/decoder_init_w8.onnx`,
  decoderStepW8: `${ONNX_MODEL_BASE}/vietocr/decoder_step_w8.onnx`,
  decoder: `${ONNX_MODEL_BASE}/vietocr/decoder_fp16.onnx`,
  // Cached decoder for the WASM backend (two graphs, 19.6 MB together, same output as the plain one): weights are
  // stored as fp16 and cast to fp32 when the session loads, which is faster on CPU than computing in fp16.
  decoderInit: `${ONNX_MODEL_BASE}/vietocr/decoder_init_fp16w.onnx`,
  decoderStep: `${ONNX_MODEL_BASE}/vietocr/decoder_step_fp16w.onnx`,
  vocab:   `${ONNX_MODEL_BASE}/vietocr/vocab.txt`,
};
const CACHE_NAME = 'boq-onnx-models-v1';

// DB post-processing parameters. PaddleOCR defaults are box 0.6 and side 960; on dense scanned tables that
// dropped about half of the description lines. Both needed to change: 960 px with box 0.5 or 1280 px with
// box 0.6 recovered almost nothing (probe: hillclimb/det_probe.js).
const DB_THRESH = 0.3;
const DB_BOX_THRESH = 0.5;
const DB_UNCLIP_RATIO = 2.0;
const DB_MAX_CANDIDATES = 1000;
const DB_MIN_SIZE = 3;

// Detection preprocessing
const DET_MAX_SIDE = 1280;
const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD  = [0.229, 0.224, 0.225];

const _NUMERIC_RE  = /^[\d\s.,:()\[\]%/=+\-xX*]+$/;

// ── State ──
let _detSession = null;
let _encSession = null;
let _dec = null;         // { plain } or { init, step } sessions, see boq-decode.js
let _decoderUrls = null; // the same, as URLs, for the workers
let _vocab = null;       // array of chars, index = token id
let _pool = null;        // OcrPool of single-threaded workers (WASM backend only), or null
let _encoderUrl = null;  // the CPU encoder model in use, so the workers load the same one
let _encoderOnGpu = false; // true: the page encodes on WebGPU and the workers only decode
let onnxReady = false;
let onnxLoading = false;

// yieldToMain() is provided by boq-utils.js

// ── Model Loading ──

async function _loadCached(url) {
  try {
    const cache = await caches.open(CACHE_NAME);
    let resp = await cache.match(url);
    if (!resp) {
      resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
      await cache.put(url, resp.clone());
    }
    return resp;
  } catch (e) {
    // Cache API unavailable (e.g. file:// protocol), fall back to direct fetch
    return fetch(url);
  }
}

// WebGPU runs the encoder when the browser has an adapter. That model stores fp16 weights and computes in fp32, so
// it needs no shader-f16 (the fp16 models returned only <pad> tokens on an adapter without it). The decoder always
// runs on the CPU in WASM: with its key/value cache it is cheap, and a GPU round trip per token is not.
async function _hasGpu() {
  try {
    return !!(navigator.gpu && await navigator.gpu.requestAdapter());
  } catch (e) {
    return false;
  }
}

async function _modelSession(url, opts) {
  const resp = await _loadCached(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return ort.InferenceSession.create(await resp.arrayBuffer(), opts);
}

async function _createEncoder(gpu) {
  if (gpu) {
    for (const url of [ONNX_MODELS.encoderGpuW8, ONNX_MODELS.encoderGpu]) {
      try {
        const session = await _modelSession(url, { executionProviders: ['webgpu'] });
        _encoderOnGpu = true;
        return session;
      } catch (e) {
        console.warn('[ONNX] GPU encoder unavailable from ' + url + ':', e);
      }
    }
  }
  const wasm = { executionProviders: ['wasm'] };
  try {
    const session = await _modelSession(ONNX_MODELS.encoderInt8, wasm);
    _encoderUrl = ONNX_MODELS.encoderInt8;
    return session;
  } catch (e) {
    console.warn('[ONNX] int8 encoder unavailable, using fp16:', e);
  }
  _encoderUrl = ONNX_MODELS.encoder;
  return _modelSession(ONNX_MODELS.encoder, wasm);
}

// One encoder run at a time on the GPU session; reads are queued behind each other.
let _gpuQueue = Promise.resolve();
function _gpuEncode(tensor) {
  const run = _gpuQueue.then(() => _encSession.run({ image: tensor }));
  _gpuQueue = run.catch(() => {});
  return run.then(out => out.memory);
}

// Cell reads are independent, so on the WASM backend (single-threaded in a normal page) several workers read in
// parallel. Measured on 24 cores: a long line takes 4.4 s alone; workers divide the page's reads between them.
// Falls back to reading on the page thread when workers cannot start.
// Each worker holds its own copy of the models, about 250 MB, so the count is capped. Two pages took 330 s with 1
// worker, 165 s with 2, 90 s with 4 and 60 s with 8; past 4 the gain flattens.
function _workerCount() {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(_encoderOnGpu ? 3 : 6, Math.floor(cores / 2)));   // decode-only workers are cheap
}

// Started when a scanned page needs OCR and stopped once all pages are read, so the memory is given back.
async function startOcrPool() {
  if (_pool || typeof OcrPool === 'undefined') return;
  try {
    _pool = await OcrPool.create(_workerCount(), {
      wasmPaths: ort.env.wasm.wasmPaths, cacheName: CACHE_NAME,
      encoderUrl: _encoderOnGpu ? null : _encoderUrl, decoder: _decoderUrls, vocab: _vocab,
    });
  } catch (e) {
    console.warn('[ONNX] worker pool unavailable, reading on the page thread:', e);
  }
}

function stopOcrPool() {
  if (_pool) _pool.close();
  _pool = null;
}

async function _createDecoder(opts) {
  const pairs = [[ONNX_MODELS.decoderInitW8, ONNX_MODELS.decoderStepW8], [ONNX_MODELS.decoderInit, ONNX_MODELS.decoderStep]];
  for (const [initUrl, stepUrl] of pairs) {
    try {
      const [init, step] = await Promise.all([_modelSession(initUrl, opts), _modelSession(stepUrl, opts)]);
      _decoderUrls = { init: initUrl, step: stepUrl };
      return { init, step };
    } catch (e) {
      console.warn('[ONNX] cached decoder unavailable from ' + stepUrl + ':', e);
    }
  }
  _decoderUrls = { plain: ONNX_MODELS.decoder };
  return { plain: await _modelSession(ONNX_MODELS.decoder, opts) };
}

async function initOnnxOCR(progressCb) {
  if (onnxReady || onnxLoading) return onnxReady;
  onnxLoading = true;

  try {
    if (typeof ort === 'undefined') {
      throw new Error('onnxruntime-web not loaded');
    }

    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';

    const gpu = await _hasGpu();
    const opts = { executionProviders: ['wasm'] };

    if (progressCb) progressCb(`Loading ONNX models (${gpu ? '41' : '43'} MB first time)...`);

    // Download everything in parallel (it fills the cache), then create the sessions one after another: the first
    // sessions initialise the WASM runtime, and doing that from several places at once fails ("multiple calls to initWasm()").
    const candidates = [ONNX_MODELS.vocab, ONNX_MODELS.decoderInitW8, ONNX_MODELS.decoderStepW8,
      gpu ? ONNX_MODELS.encoderGpuW8 : ONNX_MODELS.encoderInt8];
    await Promise.all(candidates.map(u => _loadCached(u).catch(() => null)));

    if (progressCb) progressCb('Creating ONNX sessions...');

    _dec = await _createDecoder(opts);
    _encSession = await _createEncoder(gpu);
    const vocabResp = await (await _loadCached(ONNX_MODELS.vocab)).text();

    _vocab = vocabResp.split('\n').filter(l => l.length > 0 || l === '');
    // Ensure empty lines map to space character (index for space in vocab)
    _vocab = vocabResp.split('\n').map(l => l === '' ? '' : l);

    onnxReady = true;
    console.log(`[ONNX] Ready. Encoder: ${_encoderOnGpu ? 'WebGPU' : 'WASM'}, vocab: ${_vocab.length} tokens`);
    return true;

  } catch (e) {
    console.error('[ONNX] Init failed:', e);
    onnxReady = false;
    return false;
  } finally {
    onnxLoading = false;
  }
}

// ── PaddleOCR Detection ──

function _preprocessDetection(canvas) {
  const srcW = canvas.width, srcH = canvas.height;

  // Resize: limit longest side to DET_MAX_SIDE, round dims to multiple of 32
  let ratio = 1.0;
  if (Math.max(srcH, srcW) > DET_MAX_SIDE) {
    ratio = DET_MAX_SIDE / Math.max(srcH, srcW);
  }
  let resizeH = Math.max(Math.round(srcH * ratio / 32) * 32, 32);
  let resizeW = Math.max(Math.round(srcW * ratio / 32) * 32, 32);

  // Resize canvas
  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = resizeW;
  tmpCanvas.height = resizeH;
  const ctx = tmpCanvas.getContext('2d');
  ctx.drawImage(canvas, 0, 0, resizeW, resizeH);
  const imgData = ctx.getImageData(0, 0, resizeW, resizeH);
  const px = imgData.data;

  // Normalize to CHW with ImageNet stats
  const data = new Float32Array(3 * resizeH * resizeW);
  for (let y = 0; y < resizeH; y++) {
    for (let x = 0; x < resizeW; x++) {
      const si = (y * resizeW + x) * 4;
      for (let c = 0; c < 3; c++) {
        const di = c * resizeH * resizeW + y * resizeW + x;
        data[di] = (px[si + c] / 255.0 - DET_MEAN[c]) / DET_STD[c];
      }
    }
  }

  return {
    tensor: new ort.Tensor('float32', data, [1, 3, resizeH, resizeW]),
    resizeH, resizeW, srcH, srcW,
    ratioH: srcH / resizeH,
    ratioW: srcW / resizeW,
  };
}

function _boxScoreFast(probMap, w, h, points) {
  // Axis-aligned bounding rect of the 4 points
  let xmin = w, xmax = 0, ymin = h, ymax = 0;
  for (const [px, py] of points) {
    xmin = Math.min(xmin, px); xmax = Math.max(xmax, px);
    ymin = Math.min(ymin, py); ymax = Math.max(ymax, py);
  }
  xmin = Math.max(0, Math.floor(xmin));
  xmax = Math.min(w - 1, Math.ceil(xmax));
  ymin = Math.max(0, Math.floor(ymin));
  ymax = Math.min(h - 1, Math.ceil(ymax));

  let sum = 0, count = 0;
  for (let y = ymin; y <= ymax; y++) {
    for (let x = xmin; x <= xmax; x++) {
      // Simple: just average the probmap in the bbox (skip polygon mask for speed)
      sum += probMap[y * w + x];
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

function _clipperOffset(points, distance) {
  if (typeof ClipperLib === 'undefined') {
    // Fallback: simple expansion without Clipper
    return _simpleExpand(points, distance);
  }
  const co = new ClipperLib.ClipperOffset();
  const scale = 1000;
  const path = points.map(p => ({ X: Math.round(p[0] * scale), Y: Math.round(p[1] * scale) }));
  co.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const solution = new ClipperLib.Paths();
  co.Execute(solution, distance * scale);
  if (solution.length === 0 || solution[0].length === 0) return points;
  return solution[0].map(p => [p.X / scale, p.Y / scale]);
}

function _simpleExpand(points, distance) {
  // Fallback: expand axis-aligned bounding box by distance
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const [x, y] of points) {
    xmin = Math.min(xmin, x); xmax = Math.max(xmax, x);
    ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
  }
  xmin -= distance; ymin -= distance;
  xmax += distance; ymax += distance;
  return [[xmin, ymin], [xmax, ymin], [xmax, ymax], [xmin, ymax]];
}

function _orderPoints(pts) {
  // Order: top-left, top-right, bottom-right, bottom-left
  pts.sort((a, b) => a[1] - b[1]); // sort by y
  const top = pts.slice(0, 2).sort((a, b) => a[0] - b[0]);
  const bot = pts.slice(2, 4).sort((a, b) => b[0] - a[0]);
  return [top[0], top[1], bot[0], bot[1]];
}

/**
 * Split a tall detection box into sub-rows using horizontal projection profile.
 * Works at original image resolution where row gaps are 5-10px wide (vs 1-2px
 * at detection resolution), making gap detection much more reliable.
 */
function _splitByProjection(canvas, box, expectedRowH) {
  const { x0, y0, x1, y1 } = box;
  const w = x1 - x0, h = y1 - y0;

  // Extract region from the original canvas
  const tmpC = document.createElement('canvas');
  tmpC.width = w; tmpC.height = h;
  const ctx = tmpC.getContext('2d');
  ctx.drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  const px = imgData.data;

  // Compute average brightness per row (0=black, 255=white)
  const rowBright = new Float32Array(h);
  for (let r = 0; r < h; r++) {
    let sum = 0;
    for (let c = 0; c < w; c++) {
      const i = (r * w + c) * 4;
      sum += px[i] + px[i + 1] + px[i + 2];
    }
    rowBright[r] = sum / (w * 3);
  }

  // Smooth to blur out thin gridlines (1-2px dark lines)
  const sm = new Float32Array(h);
  const WIN = 3;
  for (let i = 0; i < h; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - WIN); j <= Math.min(h - 1, i + WIN); j++) {
      s += rowBright[j]; c++;
    }
    sm[i] = s / c;
  }

  // Adaptive gap threshold: gap rows are close to white (page background).
  // maxB - 20 catches rows that are nearly as bright as the brightest (gap) rows.
  // Floor at 200 to avoid false gaps in dark regions.
  let maxB = 0;
  for (let i = 0; i < h; i++) maxB = Math.max(maxB, sm[i]);
  const gapThresh = Math.max(200, maxB - 20);

  // Find gap bands: consecutive bright rows, at least MIN_GAP px wide
  const MIN_GAP = 3;
  const gapBands = []; // split Y positions (gap centers)
  let inGap = false, gapStart = 0;
  for (let i = 0; i < h; i++) {
    if (sm[i] >= gapThresh) {
      if (!inGap) { gapStart = i; inGap = true; }
    } else {
      if (inGap) {
        if (i - gapStart >= MIN_GAP) {
          gapBands.push(Math.round((gapStart + i) / 2));
        }
        inGap = false;
      }
    }
  }
  // Trailing gap at bottom edge — don't add (that's just box padding)

  if (gapBands.length === 0) return [box];

  // Filter: splits must be at least expectedRowH * 0.4 apart
  const MIN_SEG = Math.round(expectedRowH * 0.4);
  const filtered = [gapBands[0]];
  for (let i = 1; i < gapBands.length; i++) {
    if (gapBands[i] - filtered[filtered.length - 1] >= MIN_SEG) {
      filtered.push(gapBands[i]);
    }
  }

  // Create sub-boxes
  const result = [];
  const MIN_BOX_H = 8;
  let prevY = 0;
  for (const splitY of filtered) {
    if (splitY - prevY >= MIN_BOX_H) {
      result.push({ x0, y0: y0 + prevY, x1, y1: y0 + splitY, score: box.score });
    }
    prevY = splitY;
  }
  if (h - prevY >= MIN_BOX_H) {
    result.push({ x0, y0: y0 + prevY, x1, y1, score: box.score });
  }

  return result.length > 0 ? result : [box];
}

// The text detector (2.4 MB) is only needed on pages without a ruled grid, so it is fetched the first time one appears.
async function _detectTextBoxes(canvas) {
  if (!_detSession) _detSession = await _modelSession(ONNX_MODELS.det, { executionProviders: ['wasm'] });
  const pre = _preprocessDetection(canvas);

  const result = await _detSession.run({ x: pre.tensor });
  // Output is probability map (1, 1, H, W)
  const output = result[Object.keys(result)[0]];
  const probMap = output.data; // Float32Array
  const pH = pre.resizeH, pW = pre.resizeW;

  // DB post-processing using OpenCV.js
  if (!opencvReady || typeof cv === 'undefined') {
    console.warn('[ONNX] OpenCV.js not ready, skipping detection post-processing');
    return [];
  }

  // Binarize
  const binMat = new cv.Mat(pH, pW, cv.CV_8UC1);
  for (let i = 0; i < probMap.length; i++) {
    binMat.data[i] = probMap[i] > DB_THRESH ? 255 : 0;
  }

  // Find contours
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(binMat, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  const boxes = [];
  const n = Math.min(contours.size(), DB_MAX_CANDIDATES);

  for (let i = 0; i < n; i++) {
    const contour = contours.get(i);
    const rect = cv.minAreaRect(contour);
    const sside = Math.min(rect.size.width, rect.size.height);
    if (sside < DB_MIN_SIZE) continue;

    // Get 4 corner points
    const pts4 = cv.RotatedRect.points(rect);
    const ptsArr = pts4.map(p => [p.x, p.y]);

    // Score
    const score = _boxScoreFast(probMap, pW, pH, ptsArr);
    if (score < DB_BOX_THRESH) continue;

    // Unclip
    const area = cv.contourArea(contour);
    const perimeter = cv.arcLength(contour, true);
    if (perimeter <= 0) continue;
    const distance = area * DB_UNCLIP_RATIO / perimeter;
    const expanded = _clipperOffset(ptsArr, distance);

    // Get final bounding box — use axis-aligned for simplicity
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const [x, y] of expanded) {
      xmin = Math.min(xmin, x); xmax = Math.max(xmax, x);
      ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
    }

    const fw = xmax - xmin, fh = ymax - ymin;
    if (Math.min(fw, fh) < DB_MIN_SIZE + 2) continue;

    // Scale back to original image coordinates
    boxes.push({
      x0: Math.max(0, Math.round(xmin * pre.ratioW)),
      y0: Math.max(0, Math.round(ymin * pre.ratioH)),
      x1: Math.min(pre.srcW, Math.round(xmax * pre.ratioW)),
      y1: Math.min(pre.srcH, Math.round(ymax * pre.ratioH)),
      score,
    });
  }

  // Cleanup
  binMat.delete(); contours.delete(); hierarchy.delete();
  output.dispose();
  pre.tensor.dispose();

  // ── Split tall boxes using original-image horizontal projection ──
  // The prob map at detection resolution (~0.41x) can't resolve narrow row gaps.
  // Instead, analyze the original canvas brightness per row where gaps are 5-10px wide.
  const ROW_H_EST = 30; // expected single table row height at 200 DPI (~11pt row)
  const splitBoxes = [];
  for (const box of boxes) {
    const bh = box.y1 - box.y0;
    if (bh <= ROW_H_EST * 1.4) {
      splitBoxes.push(box);
    } else {
      splitBoxes.push(..._splitByProjection(canvas, box, ROW_H_EST));
    }
  }

  // Sort by y then x (reading order)
  splitBoxes.sort((a, b) => {
    const dy = a.y0 - b.y0;
    return Math.abs(dy) > 10 ? dy : a.x0 - b.x0;
  });

  return splitBoxes;
}

// ── VietOCR Recognition ──

// White margin added left and right of every line crop. Detector boxes hug the ink, and VietOCR reads
// tight crops far worse (measured on the 11-page contract: character error 0.12 -> 0.024 with 10 px).
const VIETOCR_PAD_PX = 10;

function _preprocessVietOCR(canvas, x0, y0, x1, y1) {
  const rawW = x1 - x0, cropH = y1 - y0;
  if (rawW <= 0 || cropH <= 0) return null;
  const pad = VIETOCR_PAD_PX;
  const cropW = rawW + 2 * pad;

  // Source: the crop centred on a white canvas, so neighbouring ink and gridlines never enter the margin
  const padded = document.createElement('canvas');
  padded.width = cropW;
  padded.height = cropH;
  const pctx = padded.getContext('2d');
  pctx.fillStyle = '#fff';
  pctx.fillRect(0, 0, cropW, cropH);
  pctx.drawImage(canvas, x0, y0, rawW, cropH, pad, 0, rawW, cropH);
  canvas = padded;
  x0 = 0; y0 = 0;

  // Resize to height=32, proportional width, round to mult of 10, clamp [32, 512]
  let newW = Math.round(32 * cropW / cropH);
  newW = Math.ceil(newW / 10) * 10;
  newW = Math.max(32, Math.min(512, newW));

  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = newW;
  tmpCanvas.height = 32;
  const ctx = tmpCanvas.getContext('2d');
  ctx.drawImage(canvas, x0, y0, cropW, cropH, 0, 0, newW, 32);

  // Trim right-side blank padding (mirror _trim_right_padding from ocr_server.py)
  const imgData = ctx.getImageData(0, 0, newW, 32);
  const px = imgData.data;
  let lastNonBlank = 0;
  for (let col = newW - 1; col >= 0; col--) {
    let allWhite = true;
    for (let row = 0; row < 32; row++) {
      const i = (row * newW + col) * 4;
      if (px[i] < 245 || px[i+1] < 245 || px[i+2] < 245) {
        allWhite = false;
        break;
      }
    }
    if (!allWhite) { lastNonBlank = col; break; }
  }
  let trimmedW = Math.max(4, lastNonBlank + 1);
  trimmedW = Math.ceil(trimmedW / 10) * 10;
  trimmedW = Math.max(32, Math.min(512, trimmedW));

  // Re-read at trimmed width if different
  let finalW = trimmedW;
  let finalCtx = ctx;
  let finalCanvas = tmpCanvas;
  if (trimmedW < newW) {
    finalCanvas = document.createElement('canvas');
    finalCanvas.width = trimmedW;
    finalCanvas.height = 32;
    finalCtx = finalCanvas.getContext('2d');
    finalCtx.drawImage(canvas, x0, y0, cropW, cropH, 0, 0, trimmedW, 32);
    finalW = trimmedW;
  }

  const finalData = finalCtx.getImageData(0, 0, finalW, 32);
  const fpx = finalData.data;

  // To CHW float32, /255 (VietOCR uses simple normalization, NOT ImageNet)
  const data = new Float32Array(3 * 32 * finalW);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < finalW; x++) {
      const si = (y * finalW + x) * 4;
      for (let c = 0; c < 3; c++) {
        data[c * 32 * finalW + y * finalW + x] = fpx[si + c] / 255.0;
      }
    }
  }

  return new ort.Tensor('float32', data, [1, 3, 32, finalW]);
}

// All crops of a page at once: with a worker pool they are read in parallel, otherwise one after another.
async function _recognizeBoxes(canvas, boxes) {
  if (_pool) return Promise.all(boxes.map(b => _recognizeBox(canvas, b)));
  const out = [];
  for (const b of boxes) out.push(await _recognizeBox(canvas, b));
  return out;
}

async function _recognizeBox(canvas, box) {
  const imgTensor = _preprocessVietOCR(canvas, box.x0, box.y0, box.x1, box.y1);
  if (!imgTensor) return { text: '', confidence: 0 };

  if (_encoderOnGpu) {
    const memory = await _gpuEncode(imgTensor);
    imgTensor.dispose();
    if (_pool) return _pool.decodeMemory(new Float32Array(memory.data), [...memory.dims]);   // onnxruntime owns memory.data
    const result = await vietocrDecodeMemory(_dec, memory, _vocab, yieldToMain);
    memory.dispose();
    return result;
  }
  if (_pool) return _pool.recognize(imgTensor);   // the tensor's buffer is handed to a worker
  const result = await vietocrDecode(_encSession, _dec, imgTensor, _vocab, yieldToMain);
  imgTensor.dispose();
  return result;
}

// ── Post-processing (mirrors ocr_server.py fixes) ──
// Post-processing was removed on purpose. It clipped lines to a words-per-pixel estimate, stripped a list of
// trailing words and rewrote phrases to match the first golden file. Vietnamese words average about 40 px here,
// not 55, so the clip cut correct lines, and the phrase rewrites turned right readings into the golden file's
// mistakes. With padded crops the plain VietOCR read is better on both the tuning and the held-out descriptions.
function _postProcess(vText) {
  let result = vText;
  // Strip spurious wrapping quotes
  if (result.length >= 2 && result.startsWith('"') && result.endsWith('"')) {
    result = result.slice(1, -1);
  }
  return result;
}

// ── Main Pipeline ──

async function ocrPageWithOnnx(canvas, pageNum) {
  if (!onnxReady) throw new Error('ONNX models not loaded');

  perfStart(`ONNX OCR page ${pageNum}`);

  // 1. Detection
  perfStart(`ONNX detection page ${pageNum}`);
  const boxes = await _detectTextBoxes(canvas);
  perfEnd(`ONNX detection page ${pageNum}`);

  console.log(`[ONNX] Page ${pageNum}: ${boxes.length} text boxes detected`);

  // 2. Recognition per box
  const s = OCR_SCALE;
  const words = [];

  const usable = boxes.filter(b => b.x1 - b.x0 >= 5 && b.y1 - b.y0 >= 5);
  const reads = await _recognizeBoxes(canvas, usable);

  usable.forEach((box, i) => {
    const { text: rawText, confidence } = reads[i];
    if (!rawText.trim() || confidence < 0.65) return;

    const text = _postProcess(rawText);
    if (!text.trim()) return;

    words.push({
      text:       text.trim(),
      x:          box.x0 / s,
      y:          box.y0 / s,
      x1:         box.x1 / s,
      y1:         box.y1 / s,
      width:      (box.x1 - box.x0) / s,
      height:     (box.y1 - box.y0) / s,
      confidence: confidence * 100,
      src:        _NUMERIC_RE.test(text.trim()) ? 'onnx-num' : 'onnx-viet',
      page:       pageNum,
    });
  });

  perfEnd(`ONNX OCR page ${pageNum}`);
  console.log(`[ONNX] Page ${pageNum}: ${words.length} words recognized`);
  return { words, lines: [] };
}

// ── Crop Re-OCR (for recovering missed small text in narrow cells) ──
// Skip detection entirely — we already know the cell bounds from OpenCV.
// Run recognition directly on the cell crop to avoid border-line false positives.

async function reOcrCropOnnx(canvas, sx, sy, sw, sh) {
  if (sw < 4 || sh < 4) return { text: '', confidence: 0 };

  // Recognize the entire crop region as a single text box
  const rec = await _recognizeBox(canvas, { x0: sx, y0: sy, x1: sx + sw, y1: sy + sh });
  return rec;  // { text, confidence }
}
