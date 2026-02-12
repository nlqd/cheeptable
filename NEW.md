# BOQ PDF → Excel: Client-Side Lattice Table Extractor

## Project Goal

Build a browser-based tool that extracts tabular data from Vietnamese construction BOQ (Biểu giá hợp đồng) PDFs and exports to Excel. Entirely client-side — no server, no OCR, no ML.

## Target Document Profile

- Vietnamese construction pricing schedules (biểu giá)
- Lattice tables with **explicit drawn borders** (every cell bounded by lines)
- Fixed 6-column schema: STT | Mô tả công việc | Đvt | Khối lượng | Đơn giá | Thành tiền
- Section headers are merged rows spanning all columns
- Tables continue across page breaks
- Text-based PDFs (not scanned), Vietnamese UTF-8
- A4 pages, 5-20 pages typical

## Architecture

```
PDF bytes (user drops file)
  → pdf.js: extract text spans with (x,y,w,h) + operator list for vector graphics
  → Lattice detector (JS): 
      1. Extract horizontal/vertical lines from constructPath + rectangle ops
      2. Cluster line coordinates (snap to grid, ~3pt tolerance)
      3. Build cell bounding boxes from grid intersections
      4. Assign text spans to cells by centroid containment
      5. Classify rows: section header vs data vs summary
  → SheetJS (xlsx): generate .xlsx with proper formatting
  → User downloads file
```

## Starting Point

There is a working POC in `poc.html`. It implements the full pipeline but needs validation and hardening. Start by testing it against the sample PDF.

## Critical Validation Step — Do This First

The entire architecture depends on whether pdf.js exposes table border lines via `getOperatorList()`. Test this immediately:

```js
const page = await pdf.getPage(1);
const opList = await page.getOperatorList();

// Count path operations
let pathOps = 0, rectOps = 0;
for (let i = 0; i < opList.fnArray.length; i++) {
  if (opList.fnArray[i] === pdfjsLib.OPS.constructPath) pathOps++;
  if (opList.fnArray[i] === pdfjsLib.OPS.rectangle) rectOps++;
}
console.log(`Page 1: ${pathOps} path ops, ${rectOps} rectangle ops`);
```

**If lines are found (>20 per page):** Proceed with current architecture.

**If lines are near zero:** The PDF encodes borders differently. Options:
1. Check if borders are thin filled rectangles (width < 2pt) — extract those instead
2. Check `page.getAnnotations()` for table-like annotations
3. Fall back to text-clustering mode (use x-coordinate gaps to infer columns)
4. Escalate to mupdf.wasm (see "Fallback: mupdf" section below)

## Task Breakdown

### Phase 1: Validate & Fix Extraction

1. Test POC against the sample PDF (`uploads/` directory)
2. Log what pdf.js actually returns — text positions, operator types, line counts per page
3. If lattice detection works: verify cell content matches expected values
4. If lattice detection fails: diagnose why (missing lines? wrong coordinate space? y-flip issues?)
5. Fix coordinate transform issues — pdf.js text uses different transform conventions than path ops

Common coordinate pitfalls:
- PDF native coords: y=0 at bottom of page
- pdf.js text content: `transform[4]` = x, `transform[5]` = y (in PDF coords)
- pdf.js viewport can flip y-axis depending on scale/rotation
- Path coordinates in `constructPath` args are in PDF native coords
- Must use consistent coordinate system for text-to-cell matching

### Phase 2: Harden the Table Extractor

Once basic extraction works:

1. **Cross-page continuation**: Detect when a table continues on the next page (same column x-coordinates within tolerance). Merge rows seamlessly.

2. **Section header detection**: Rows where text spans the full table width. These appear as:
   - "1. ĐƯỜNG NGUYỄN ĐÌNH CHIỂU, PHƯỜNG SÀI GÒN:" (street-level)
   - "PHẦN ĐƯỜNG ỐNG" (subsection)
   - "PHẦN LẮP ĐẶT ỐNG VÀ PHỤ TÙNG" (subsection)
   - "TÁI LẬP MẶT ĐƯỜNG NHỰA 12cm Eyc > 155 MPA" (sub-subsection)

3. **Number parsing**: Vietnamese number conventions:
   - `4.330.000` = 4,330,000 (dots are thousands separators)
   - `0,700` = 0.700 (comma is decimal separator)  
   - `15.208.600` = 15,208,600
   - Numbers in columns 4-6 (Khối lượng, Đơn giá, Thành tiền) should be parsed as numeric

4. **Merged cell handling**: Section headers span all 6 columns. Detect by checking if text only appears in 1-2 cells but the row has full-width borders.

5. **Summary row detection**: Look for keywords like "Tổng cộng", "Dự phòng", "Giá hợp đồng"

### Phase 3: Excel Output Quality

Use SheetJS to produce a well-formatted workbook:

1. **Column headers**: STT | Mô tả công việc | Đvt | Khối lượng | Đơn giá (đồng) | Thành tiền (đồng)
2. **Column widths**: [7, 65, 10, 14, 16, 18]
3. **Number formatting**: `#,##0` for integer columns (Đơn giá, Thành tiền), `#,##0.000` for Khối lượng
4. **Section headers**: Bold, colored background, merged across all columns
5. **Summary rows**: Bold, yellow background
6. **Freeze panes**: Row 1 (headers) frozen
7. **Vietnamese text**: Ensure UTF-8 BOM for CSV export

### Phase 4: UI Polish

Single-page app, minimal dependencies:

1. Drag-and-drop PDF input
2. Progress indicator during extraction
3. Extraction stats (pages, rows, lines detected)
4. Pipeline log showing each step
5. Table preview (scrollable, max 200 rows shown)
6. Download buttons: .xlsx and .csv
7. Error states: "no lines found", "no text found", "unexpected column count"

## File Structure

```
boq-extractor/
├── index.html          # Single entry point
├── src/
│   ├── main.js         # App initialization, UI orchestration
│   ├── pdf-extract.js  # pdf.js text + line extraction
│   ├── lattice.js      # Grid detection, cell construction, text assignment
│   ├── classify.js     # Row classification (section/data/summary)
│   ├── numbers.js      # Vietnamese number parser
│   └── export.js       # SheetJS xlsx/csv generation
├── test/
│   ├── test-extract.js # Unit tests for line extraction
│   ├── test-lattice.js # Unit tests for grid building
│   └── test-numbers.js # Unit tests for VN number parsing
└── sample/
    └── (put the sample BOQ PDF here)
```

## Dependencies

Only two external dependencies, both loaded from CDN (or vendored):

```
pdf.js 3.11.174    — PDF parsing, text + operator extraction
xlsx   0.18.5      — Excel file generation (SheetJS community edition)
```

No build tools required. No npm. No bundler. Just static files served by any HTTP server.

For local dev:
```bash
# simplest possible dev server
python3 -m http.server 8080
# or
npx serve .
```

## Key Algorithms

### Line Clustering (snap-to-grid)

```
Input: array of coordinate values (floats)
Output: sorted array of unique cluster centers

1. Round to 0.1pt precision, deduplicate
2. Sort ascending
3. Walk sorted values: if gap to previous cluster > TOLERANCE (3pt), start new cluster
4. Otherwise, update cluster center to running average
```

### Cell Text Assignment

```
For each cell defined by (xLeft, yTop, xRight, yBottom):
  For each text span on the same page:
    centroid_x = span.x + span.width / 2
    centroid_y = span.y
    if centroid is inside cell bbox (with 1.5pt inset padding):
      assign span to cell
  Sort assigned spans by y then x
  Join with space separator
```

### Row Classification

```
For each row of cells:
  if all cells empty → skip
  if only 1-2 cells have content AND content is long text → section header
  if content matches /^(PHẦN|TÁI LẬP|Thủy lượng|ĐƯỜNG|\d+\.\s*ĐƯỜNG)/i → section header
  if content contains "Tổng cộng" or "Dự phòng" → summary
  if first cell is an integer → data row
  if cells match column header pattern (Stt, Mô tả, Đvt...) → skip (repeated header)
```

## Fallback: mupdf.wasm

If pdf.js doesn't expose enough vector graphics data for your PDF, you'll need mupdf. Here's the path:

```bash
npm install mupdf
```

mupdf's npm package includes a WASM build. Key API:

```js
import * as mupdf from "mupdf";

const doc = mupdf.Document.openDocument(buffer, "application/pdf");
const page = doc.loadPage(0);

// This is the critical method — gets structured path data
const drawings = page.getDrawings(); 
// Returns array of {type, rect, items[{type:"l", p1, p2},...]}

// Text with positions
const blocks = page.toStructuredText("preserve-whitespace").getBlocks();
```

`page.getDrawings()` is what Camelot uses under the hood via PyMuPDF. It gives you actual line segments with coordinates — exactly what the lattice detector needs.

If you go this route, replace only the extraction layer (pdf-extract.js). The lattice detector, classifier, and export layers stay the same.

## Testing Checklist

Against the sample BOQ PDF, verify:

- [ ] All 473 data rows extracted
- [ ] 8 street sections correctly identified
- [ ] STT numbers are sequential 1-473
- [ ] Subsections detected (PHẦN ĐƯỜNG ỐNG, PHẦN LẮP ĐẶT, etc.)
- [ ] Vietnamese diacritics preserved (ệ, ổ, ứ, ừ, ơ, ả, ẵ)
- [ ] Numbers parsed correctly: `15.208.600` → 15208600
- [ ] Decimal numbers preserved: `0,700` → 0.700
- [ ] Grand total matches: 1,681,493,000 đồng
- [ ] Excel opens correctly in both Excel and LibreOffice
- [ ] No data leaves the browser (verify in Network tab)

## What NOT To Do

- Do NOT use Tesseract or any OCR — the PDF is text-based
- Do NOT use any ML/deep learning models — the tables have explicit borders
- Do NOT add a server/backend — everything runs client-side
- Do NOT use canvas rendering to "see" the PDF — work with the structural data directly
- Do NOT add npm/webpack/vite unless strictly necessary — keep it simple static files
- Do NOT try to handle scanned PDFs — out of scope
- Do NOT try to handle borderless/stream tables — out of scope for v1

