// boq-ocr.js — OCR functions: Tesseract.js, hybrid server, OpenCV border detection
'use strict';

// ── OpenCV.js Border Detection ──
async function detectTableBorders(canvas) {
  if (!opencvReady || typeof cv === 'undefined') {
    log('OpenCV.js not ready, skipping border detection', 'warn');
    return { cells: [], lines: { horizontal: [], vertical: [] } };
  }

  try {
    perfStart('OpenCV border detection');

    // 1. Load canvas to OpenCV Mat
    const src = cv.imread(canvas);
    const gray = new cv.Mat();
    const binary = new cv.Mat();
    await yieldToMain();

    // 2. Convert to grayscale
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    await yieldToMain();

    // 3. Adaptive thresholding (better for scanned docs)
    cv.adaptiveThreshold(
      gray, binary,
      255,
      cv.ADAPTIVE_THRESH_MEAN_C,
      cv.THRESH_BINARY_INV,
      15,  // Block size (odd number)
      2    // C constant (subtracted from mean)
    );
    await yieldToMain();

    // 4. Morphological operations to extract lines
    const scale = 20; // Kernel size divisor (lower = detect thinner lines)

    // Horizontal lines
    const hKernelSize = new cv.Size(Math.floor(binary.cols / scale), 1);
    const hKernel = cv.getStructuringElement(cv.MORPH_RECT, hKernelSize);
    const horizontal = new cv.Mat();
    cv.morphologyEx(binary, horizontal, cv.MORPH_OPEN, hKernel);
    await yieldToMain();

    // Vertical lines
    const vKernelSize = new cv.Size(1, Math.floor(binary.rows / scale));
    const vKernel = cv.getStructuringElement(cv.MORPH_RECT, vKernelSize);
    const vertical = new cv.Mat();
    cv.morphologyEx(binary, vertical, cv.MORPH_OPEN, vKernel);
    await yieldToMain();

    // 5. Combine horizontal and vertical
    const grid = new cv.Mat();
    cv.add(horizontal, vertical, grid);

    // Optional: Dilate grid to close small gaps
    const dilateKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
    cv.dilate(grid, grid, dilateKernel);
    await yieldToMain();

    // 6. Find contours (table cells)
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(
      grid,
      contours,
      hierarchy,
      cv.RETR_TREE,
      cv.CHAIN_APPROX_SIMPLE
    );

    // 7. Extract cell bounding boxes
    const cells = [];
    const minCellArea = 2000; // Increased to 2000 for better performance
    const maxCellArea = (binary.cols * binary.rows) * 0.25; // Filter large boxes
    const MAX_CELLS = 400; // Increased to 400 to capture full table (typical page: 50 rows × 6 cols = 300 cells)

    console.log(`[Border Detection] Found ${contours.size()} contours`);

    for (let i = 0; i < contours.size(); i++) {
      const rect = cv.boundingRect(contours.get(i));
      const area = rect.width * rect.height;

      // More strict filtering: area + aspect ratio
      const aspectRatio = rect.width / rect.height;

      if (area > minCellArea &&
          area < maxCellArea &&
          rect.width > 20 &&   // Increased from 10
          rect.height > 10 &&  // Increased from 5
          aspectRatio < 20 &&  // Avoid very wide cells
          aspectRatio > 0.1) { // Avoid very tall cells
        cells.push({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          area: area
        });
      }
    }

    // Sort cells by area (largest first) and keep top 200
    cells.sort((a, b) => b.area - a.area);
    const filteredCells = cells.slice(0, MAX_CELLS);

    console.log(`[Border Detection] Filtered to ${filteredCells.length} cells (min area: ${minCellArea}px²)`);

    // Update cells reference
    cells.length = 0;
    cells.push(...filteredCells);

    // 8. Extract line coordinates using HoughLinesP
    const hLines = [];
    const vLines = [];

    const hLinesData = new cv.Mat();
    cv.HoughLinesP(horizontal, hLinesData, 1, Math.PI / 180, 50, 100, 20);

    for (let i = 0; i < hLinesData.rows; i++) {
      const x1 = hLinesData.data32S[i * 4];
      const y1 = hLinesData.data32S[i * 4 + 1];
      const x2 = hLinesData.data32S[i * 4 + 2];
      const y2 = hLinesData.data32S[i * 4 + 3];
      hLines.push({ x1, y1, x2, y2, type: 'horizontal' });
    }

    const vLinesData = new cv.Mat();
    cv.HoughLinesP(vertical, vLinesData, 1, Math.PI / 180, 50, 100, 20);

    for (let i = 0; i < vLinesData.rows; i++) {
      const x1 = vLinesData.data32S[i * 4];
      const y1 = vLinesData.data32S[i * 4 + 1];
      const x2 = vLinesData.data32S[i * 4 + 2];
      const y2 = vLinesData.data32S[i * 4 + 3];
      vLines.push({ x1, y1, x2, y2, type: 'vertical' });
    }

    // 9. Cleanup memory
    src.delete(); gray.delete(); binary.delete();
    horizontal.delete(); vertical.delete(); grid.delete();
    contours.delete(); hierarchy.delete();
    hKernel.delete(); vKernel.delete(); dilateKernel.delete();
    hLinesData.delete(); vLinesData.delete();

    perfEnd('OpenCV border detection');

    log(`✓ Detected ${cells.length} cells, ${hLines.length} horizontal lines, ${vLines.length} vertical lines`, 'ok');
    return { cells, lines: { horizontal: hLines, vertical: vLines } };

  } catch (err) {
    log(`✗ OpenCV.js error: ${err.message}`, 'err');
    console.error('Border detection failed:', err);
    return { cells: [], lines: { horizontal: [], vertical: [] } };
  }
}

// Map OCR words to detected cells

// ── Tesseract OCR Functions ──
async function initTesseract() {
  let currentPage = null;
  const worker = await Tesseract.createWorker('vie', 1, {
    langPath: 'https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_best',  // Use tessdata_best models (higher accuracy)
    gzip: false,  // tessdata_best files are not gzipped
    logger: m => {
      // Detailed profiling of Tesseract stages
      if (m.status === 'loading language traineddata') {
        perfStart('Tesseract: load traineddata');
        log(`Loading tessdata_best Vietnamese model...`, 'warn');
      } else if (m.status === 'loaded language traineddata') {
        perfEnd('Tesseract: load traineddata');
      } else if (m.status === 'initializing tesseract') {
        perfStart('Tesseract: initialize engine');
      } else if (m.status === 'initialized tesseract') {
        perfEnd('Tesseract: initialize engine');
      } else if (m.status === 'recognizing text') {
        const pageLabel = `Tesseract: recognize page ${currentPage}`;
        if (!perfTimings[pageLabel]) {
          perfStart(pageLabel);
        }
        // Update progress bar with fine-grained OCR progress
        if (m.progress !== undefined && totalPDFPages > 0) {
          // Calculate overall progress:
          // - Each page gets 80% / totalPages of the bar
          // - Within each page, show progress from 0% to 100%
          const pageWeight = 80 / totalPDFPages;
          const completedPages = currentOCRPage - 1; // 0-indexed, so page 1 is index 0
          const baseProgress = (completedPages / totalPDFPages) * 80;
          const pageProgress = (m.progress * pageWeight);
          const totalProgress = Math.min(baseProgress + pageProgress, 80);

          $('pbar').style.width = `${totalProgress.toFixed(1)}%`;

          if (m.progress < 1) {
            const progressPct = (m.progress * 100).toFixed(0);
            $('progressText').textContent = `Processing page ${currentPage} of ${totalPDFPages}... (${progressPct}%)`;
          }
        }
      } else if (m.status === 'recognized text') {
        const pageLabel = `Tesseract: recognize page ${currentPage}`;
        perfEnd(pageLabel);
      }
    }
  });

  // Store reference to update current page
  worker._currentPage = 0;
  const originalRecognize = worker.recognize.bind(worker);
  worker.recognize = async function(...args) {
    currentPage = worker._currentPage++;
    return originalRecognize(...args);
  };

  // Configure Tesseract for better Vietnamese recognition
  await worker.setParameters({
    tessedit_pageseg_mode: '3',  // Fully automatic page segmentation (no OSD)
    tessedit_ocr_engine_mode: '1', // Neural nets LSTM engine only
    preserve_interword_spaces: '1'
  });

  return worker;
}

async function initSyllableCorrector() {
  const corrector = new VietnameseSyllableCorrector();
  const loaded = await corrector.loadModel('vn_syllable_model.json');
  if (loaded) {
    log('Syllable language model loaded successfully', 'ok');
  } else {
    log('Warning: Syllable model failed to load, using dictionary only', 'warn');
  }
  return corrector;
}

async function renderPageToCanvas(page, scale) {
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = vp.width;
  canvas.height = vp.height;
  const ctx = canvas.getContext('2d');

  // Render the page with high quality
  await page.render({ canvasContext: ctx, viewport: vp }).promise;

  // No preprocessing - Tesseract works better with original high-DPI images
  return canvas;
}

// Timeout wrapper for OCR to detect hangs
async function ocrPageWithTimeout(canvas, pageNum, timeoutMs = 30000) {
  return new Promise(async (resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`OCR timeout after ${timeoutMs}ms on page ${pageNum}`));
    }, timeoutMs);

    try {
      const result = await ocrPage(canvas, pageNum);
      clearTimeout(timeoutId);
      resolve(result);
    } catch (error) {
      clearTimeout(timeoutId);
      reject(error);
    }
  });
}

async function ocrPage(canvas, pageNum) {
  const { data } = await tesseractWorker.recognize(canvas);
  const s = OCR_SCALE;

  const words = data.words
    .filter(w => w.text.trim() && w.confidence > 30)
    .map(w => ({
      text: w.text.trim(),
      x: w.bbox.x0 / s,
      y: w.bbox.y0 / s,
      x1: w.bbox.x1 / s,
      y1: w.bbox.y1 / s,
      width: (w.bbox.x1 - w.bbox.x0) / s,
      height: (w.bbox.y1 - w.bbox.y0) / s,
      confidence: w.confidence,
      page: pageNum
    }));

  const lines = data.lines
    .filter(l => l.text.trim())
    .map(l => ({
      text: l.text.trim(),
      x: l.bbox.x0 / s,
      y: l.bbox.y0 / s,
      x1: l.bbox.x1 / s,
      y1: l.bbox.y1 / s,
      words: l.words.filter(w => w.text.trim()).map(w => ({
        text: w.text.trim(),
        x: w.bbox.x0 / s,
        y: w.bbox.y0 / s,
        x1: w.bbox.x1 / s,
        y1: w.bbox.y1 / s,
        confidence: w.confidence
      })),
      confidence: l.confidence,
      page: pageNum
    }));

  return { words, lines };
}

// ── Hybrid OCR Server (PaddleOCR detection + EasyOCR Vietnamese) ──
async function ocrPageWithServer(canvas, pageNum) {
  // Canvas → base64 PNG (lossless — preserves fine Vietnamese diacritic strokes for EasyOCR)
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  const b64  = await new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload  = () => res(reader.result.split(',')[1]);
    reader.onerror = rej;
    reader.readAsDataURL(blob);
  });

  const resp = await fetch(`${OCR_SERVER_URL}/ocr`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body:    JSON.stringify({ image: b64, page: pageNum }),
    signal:  AbortSignal.timeout(120000)
  });
  if (resp.status === 401) { clearAuthToken(); throw new Error('Unauthorized — token cleared'); }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.error) throw new Error(data.error);

  // Server bbox is in canvas-pixel coords → divide by OCR_SCALE to get PDF points
  // Server confidence is 0–1 → multiply by 100 to match Tesseract scale
  const words = (data.words || []).map(w => ({
    text:       w.text,
    x:          w.bbox[0] / OCR_SCALE,
    y:          w.bbox[1] / OCR_SCALE,
    x1:         w.bbox[2] / OCR_SCALE,
    y1:         w.bbox[3] / OCR_SCALE,
    width:      (w.bbox[2] - w.bbox[0]) / OCR_SCALE,
    height:     (w.bbox[3] - w.bbox[1]) / OCR_SCALE,
    confidence: w.confidence * 100,
    src:        w.src || 'server',
    page:       pageNum
  }));

  return { words, lines: [] };
}

