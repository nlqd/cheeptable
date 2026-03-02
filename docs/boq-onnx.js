// boq-onnx.js — ONNX browser OCR: PaddleOCR detection + VietOCR recognition
// Mirrors ocr_server.py hybrid pipeline entirely client-side.
'use strict';

// ── Configuration ──
const ONNX_MODEL_BASE = 'https://huggingface.co/dzngo/vietocr-models/resolve/main';
const ONNX_MODELS = {
  det:     `${ONNX_MODEL_BASE}/paddleocr/det_v3.onnx`,
  encoder: `${ONNX_MODEL_BASE}/vietocr/encoder_fp16.onnx`,
  decoder: `${ONNX_MODEL_BASE}/vietocr/decoder_fp16.onnx`,
  vocab:   `${ONNX_MODEL_BASE}/vietocr/vocab.txt`,
};
const CACHE_NAME = 'boq-onnx-models-v1';

// VietOCR special tokens
const SOS = 1, EOS = 2;

// DB post-processing parameters (match PaddleOCR defaults)
const DB_THRESH = 0.3;
const DB_BOX_THRESH = 0.6;
const DB_UNCLIP_RATIO = 2.0;
const DB_MAX_CANDIDATES = 1000;
const DB_MIN_SIZE = 3;

// Detection preprocessing
const DET_MAX_SIDE = 960;
const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD  = [0.229, 0.224, 0.225];

// Regex from ocr_server.py
const _NUMERIC_RE  = /^[\d\s.,:()\[\]%/=+\-xX*]+$/;
const _OPERATOR_RE = /[><=]/;
const _DIAMETER_RE = /(?<![A-Za-z\d])([Pp2b])([1-9]\d{1,3})\b/g;
const _DIAMETER_CONF_THRESHOLD = 0.975;
const _TAIL_1 = new Set([
  'thế','trị','nhau','lại','năm','tháng','nha','thuận','trước',
  'nghệ','thể','nhất','trận','chính','đội','nam','tế','là',
  'tc','th','tp','tm','tt','ch','ban','hh','hhh','thuy',
  'thị','thanh','khác','t','l','m','la','mm',
]);
const _TAIL_2 = new Set(['thế trị','thế trước','th tp']);
const _TAIL_RAW = new Set(['(m','(s','(S','(m2','(m3']);
const _YEAR_TAIL_RE = /^(?:(?:19|20)\d{2}|19|20)$/;
const _PHRASE_SUBS = [
  [/phui mương ống/g, 'phui muông ống'],
  [/căn khí nén\b/g,  'cần khi nền'],
  [/đấu nối/g,        'đầu nối'],
  [/Bửng chận/g,      'Bừng chận'],
  [/ôtô tự đồ/g,      'ôtô tự đổ'],
  [/\bUPVC\b/g,        'uPVC'],
];

// ── State ──
let _detSession = null;
let _encSession = null;
let _decSession = null;
let _vocab = null;       // array of chars, index = token id
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

async function initOnnxOCR(progressCb) {
  if (onnxReady || onnxLoading) return onnxReady;
  onnxLoading = true;

  try {
    if (typeof ort === 'undefined') {
      throw new Error('onnxruntime-web not loaded');
    }

    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';

    const backend = (navigator.gpu) ? 'webgpu' : 'wasm';
    const opts = { executionProviders: [backend, 'wasm'] };

    if (progressCb) progressCb('Loading ONNX models (77 MB first time)...');

    // Load all models in parallel
    const [detBuf, encBuf, decBuf, vocabResp] = await Promise.all([
      _loadCached(ONNX_MODELS.det).then(r => r.arrayBuffer()),
      _loadCached(ONNX_MODELS.encoder).then(r => r.arrayBuffer()),
      _loadCached(ONNX_MODELS.decoder).then(r => r.arrayBuffer()),
      _loadCached(ONNX_MODELS.vocab).then(r => r.text()),
    ]);

    if (progressCb) progressCb('Creating ONNX sessions...');

    [_detSession, _encSession, _decSession] = await Promise.all([
      ort.InferenceSession.create(detBuf, opts),
      ort.InferenceSession.create(encBuf, opts),
      ort.InferenceSession.create(decBuf, opts),
    ]);

    _vocab = vocabResp.split('\n').filter(l => l.length > 0 || l === '');
    // Ensure empty lines map to space character (index for space in vocab)
    _vocab = vocabResp.split('\n').map(l => l === '' ? '' : l);

    onnxReady = true;
    console.log(`[ONNX] Ready. Backend: ${backend}, vocab: ${_vocab.length} tokens`);
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

async function _detectTextBoxes(canvas) {
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

function _preprocessVietOCR(canvas, x0, y0, x1, y1) {
  const cropW = x1 - x0, cropH = y1 - y0;
  if (cropW <= 0 || cropH <= 0) return null;

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

async function _recognizeBox(canvas, box) {
  const imgTensor = _preprocessVietOCR(canvas, box.x0, box.y0, box.x1, box.y1);
  if (!imgTensor) return { text: '', confidence: 0 };

  // Encode
  const encResult = await _encSession.run({ image: imgTensor });
  const memory = encResult.memory;
  imgTensor.dispose();

  // Greedy decode
  const tokenIds = [SOS];
  const maxLen = 128;
  const probs = [];

  for (let step = 0; step < maxLen; step++) {
    const tgtData = new BigInt64Array(tokenIds.map(t => BigInt(t)));
    const tgtTensor = new ort.Tensor('int64', tgtData, [tokenIds.length, 1]);

    const decResult = await _decSession.run({ tokens: tgtTensor, memory });
    const logits = decResult.logits.data; // Float32Array [vocab_size]
    tgtTensor.dispose();

    // Softmax + argmax
    let maxVal = -Infinity, maxIdx = 0;
    for (let j = 0; j < logits.length; j++) {
      if (logits[j] > maxVal) { maxVal = logits[j]; maxIdx = j; }
    }

    decResult.logits.dispose();

    if (maxIdx === EOS) break;
    tokenIds.push(maxIdx);

    // Track probability for confidence (softmax of max)
    let expSum = 0;
    for (let j = 0; j < logits.length; j++) expSum += Math.exp(logits[j] - maxVal);
    probs.push(1.0 / expSum);

    // Yield to main thread every 10 steps
    if (step % 10 === 9) await yieldToMain();
  }

  memory.dispose();

  // Decode tokens to string
  const text = tokenIds.slice(1).map(id => _vocab[id] || '').join('');
  const confidence = probs.length > 0
    ? probs.reduce((a, b) => a + b, 0) / probs.length
    : 0;

  return { text, confidence };
}

// ── Post-processing (mirrors ocr_server.py fixes) ──
// On BE, PaddleOCR English rec provides an independent word count (pWc) to detect
// VietOCR hallucinations. On FE we don't have PaddleOCR rec, so we estimate the
// expected word count from the crop's pixel width.
// At 200 DPI, Vietnamese runs ~50-70px per word (5-6 chars × ~10-12px).
const _PX_PER_WORD = 55;

function _postProcess(vText, cropWidthPx, detScore) {
  const estWc = Math.max(1, Math.round(cropWidthPx / _PX_PER_WORD));

  // Fix 1: word count clipping — cap VietOCR output to estimated + 2 words
  let vWords = vText.split(/\s+/).filter(Boolean);
  if (vWords.length > estWc + 3) {
    vWords = vWords.slice(0, estWc + 2);
  }

  // Fix 4: tail token stripping — remove known hallucinated trailing words
  if (vWords.length > estWc) {
    if (vWords.length >= 2) {
      const t2 = vWords.slice(-2).join(' ').toLowerCase();
      if (_TAIL_2.has(t2)) vWords = vWords.slice(0, -2);
    }
    if (vWords.length > estWc && vWords.length > 0) {
      const raw = vWords[vWords.length - 1];
      const t1 = raw.toLowerCase().replace(/[.,!?()\[\]]/g, '');
      if (_TAIL_RAW.has(raw) || _TAIL_1.has(t1) || _YEAR_TAIL_RE.test(t1)) {
        vWords = vWords.slice(0, -1);
      }
    }
  }

  let result = vWords.join(' ');

  // Fix 2: operator fallback — skipped on FE (no independent text source)

  // Fix 3: diameter symbol correction — DISABLED on FE.
  // Detection score is not a valid proxy for PaddleOCR rec confidence.
  // detScore is ~0.95-0.99 for all boxes, so the threshold fires on every "2XX" number.
  // BE uses PaddleOCR per-character rec confidence where Þ glyphs score uniquely low.

  // Fix 5: strip spurious wrapping quotes
  if (result.length >= 2 && result.startsWith('"') && result.endsWith('"')) {
    result = result.slice(1, -1);
  }

  // Fix 6: phrase-level diacritic corrections
  for (const [pat, repl] of _PHRASE_SUBS) {
    result = result.replace(pat, repl);
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

  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const cropW = box.x1 - box.x0, cropH = box.y1 - box.y0;
    if (cropW < 5 || cropH < 5) continue;

    const { text: rawText, confidence } = await _recognizeBox(canvas, box);
    if (!rawText.trim() || confidence < 0.65) continue;

    const text = _postProcess(rawText, cropW, box.score);
    if (!text.trim()) continue;

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

    // Progress feedback
    if (i % 5 === 0) await yieldToMain();
  }

  perfEnd(`ONNX OCR page ${pageNum}`);
  console.log(`[ONNX] Page ${pageNum}: ${words.length} words recognized`);
  return { words, lines: [] };
}
