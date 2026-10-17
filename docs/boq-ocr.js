// boq-ocr.js — page rendering and OpenCV border detection (the fallback for tables that are not a ruled grid)
'use strict';

// ── OpenCV.js Border Detection ──
async function detectTableBorders(canvas) {
  if (!opencvReady || typeof cv === 'undefined') {
    log('OpenCV.js not ready, skipping border detection', 'warn');
    return { cells: [], lines: { horizontal: [], vertical: [] } };
  }

  const live = [];                         // every matrix made here, freed on every path out
  const own = (m) => { live.push(m); return m; };
  try {
    perfStart('OpenCV border detection');

    // 1. Load canvas to OpenCV Mat
    const src = own(cv.imread(canvas));
    const gray = own(new cv.Mat());
    const binary = own(new cv.Mat());
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
    const hKernel = own(cv.getStructuringElement(cv.MORPH_RECT, hKernelSize));
    const horizontal = own(new cv.Mat());
    cv.morphologyEx(binary, horizontal, cv.MORPH_OPEN, hKernel);
    await yieldToMain();

    // Vertical lines
    const vKernelSize = new cv.Size(1, Math.floor(binary.rows / scale));
    const vKernel = own(cv.getStructuringElement(cv.MORPH_RECT, vKernelSize));
    const vertical = own(new cv.Mat());
    cv.morphologyEx(binary, vertical, cv.MORPH_OPEN, vKernel);
    await yieldToMain();

    // 5. Combine horizontal and vertical
    const grid = own(new cv.Mat());
    cv.add(horizontal, vertical, grid);

    // Optional: Dilate grid to close small gaps
    const dilateKernel = own(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2)));
    cv.dilate(grid, grid, dilateKernel);
    await yieldToMain();

    // 6. Find contours (table cells)
    const contours = own(new cv.MatVector());
    const hierarchy = own(new cv.Mat());
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
      const contour = contours.get(i);
      const rect = cv.boundingRect(contour);
      contour.delete();
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

    const hLinesData = own(new cv.Mat());
    cv.HoughLinesP(horizontal, hLinesData, 1, Math.PI / 180, 50, 100, 20);

    for (let i = 0; i < hLinesData.rows; i++) {
      const x1 = hLinesData.data32S[i * 4];
      const y1 = hLinesData.data32S[i * 4 + 1];
      const x2 = hLinesData.data32S[i * 4 + 2];
      const y2 = hLinesData.data32S[i * 4 + 3];
      hLines.push({ x1, y1, x2, y2, type: 'horizontal' });
    }

    const vLinesData = own(new cv.Mat());
    cv.HoughLinesP(vertical, vLinesData, 1, Math.PI / 180, 50, 100, 20);

    for (let i = 0; i < vLinesData.rows; i++) {
      const x1 = vLinesData.data32S[i * 4];
      const y1 = vLinesData.data32S[i * 4 + 1];
      const x2 = vLinesData.data32S[i * 4 + 2];
      const y2 = vLinesData.data32S[i * 4 + 3];
      vLines.push({ x1, y1, x2, y2, type: 'vertical' });
    }

    perfEnd('OpenCV border detection');

    log(`✓ Detected ${cells.length} cells, ${hLines.length} horizontal lines, ${vLines.length} vertical lines`, 'ok');
    return { cells, lines: { horizontal: hLines, vertical: vLines } };

  } catch (err) {
    log(`✗ OpenCV.js error: ${err.message}`, 'err');
    console.error('Border detection failed:', err);
    return { cells: [], lines: { horizontal: [], vertical: [] } };
  } finally {
    live.forEach(m => { try { m.delete(); } catch (e) { /* already freed */ } });
  }
}

async function renderPageToCanvas(page, scale) {
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = vp.width;
  canvas.height = vp.height;
  const ctx = canvas.getContext('2d');

  // Render the page with high quality
  await page.render({ canvasContext: ctx, viewport: vp }).promise;

  return canvas;
}

