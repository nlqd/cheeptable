# Vietnamese OCR PDF Table Extractor

100% client-side Vietnamese OCR for extracting tables from construction PDFs. No data uploaded, everything runs in the browser.

## Quick Start

```bash
# Serve locally
python3 -m http.server 8080

# Open in browser
http://localhost:8080/new.html

# Test with sample
Drop sample.pdf or click "Try Sample PDF"
```

## Production Files

### Core Application
- **new.html** - Main single-page application (~1500 lines)
  - PDF.js for PDF parsing
  - Tesseract.js for OCR (Vietnamese tessdata_best)
  - Multi-stage Vietnamese diacritic restoration
  - Excel/CSV export with SheetJS

### Vietnamese Correction Pipeline
- **confidence-tracking.js** - Metadata tracking for corrections
- **vietnamese_text_fixes_v2.js** - Text normalization & spacing fixes
- **vn_syllable_corrector.js** - Syllable-based language model
- **vn_syllable_model.json** - Pre-trained syllable probabilities

### Testing & Development
- **test_comprehensive.mjs** - Automated test suite (35 tests)
- **simple_mock_api.py** - Mock VPS API for testing integration
- **sample.pdf** - Vietnamese construction materials pricing table

## Features

✅ **Client-side OCR** - No server upload, complete privacy
✅ **Vietnamese-optimized** - Multi-stage diacritic restoration
✅ **Table extraction** - Lattice, spatial, and pipe-based algorithms
✅ **Custom dictionary** - Import/export domain-specific terms
✅ **Live editing** - Edit cells before export
✅ **Excel export** - Download as .xlsx with formatting

## Architecture

### Correction Pipeline (4 stages)

1. **VPS API** (optional, 94% accuracy target)
   - Transformer-based diacritic restoration
   - Falls back if unavailable
   - Currently: mock API for testing

2. **Dictionary Lookup**
   - 375+ Vietnamese construction terms
   - Custom dictionary support
   - Diacritic-agnostic fuzzy matching

3. **Syllable Model**
   - Statistical language model
   - Vietnamese syllable probabilities
   - Context-aware correction

4. **Original Text**
   - Fallback if no corrections found
   - Preserves original OCR output

### Table Extraction (3 strategies)

1. **Lattice-based** (for text PDFs with embedded fonts)
   - Analyzes embedded text positions
   - Detects vertical/horizontal lines
   - Grid-based cell assignment

2. **Spatial clustering** (for OCR text)
   - Groups text by coordinates
   - Row detection by Y-position
   - Column detection by X-histogram

3. **Pipe-based** (for simple tables)
   - Detects pipe characters (|)
   - Splits on delimiters
   - Fallback for basic formats

## Testing

```bash
# Install dependencies
npm install

# Run comprehensive tests
node test_comprehensive.mjs

# Expected: 35/35 tests passing (100%)
```

### Test Coverage
- Application loading (4 tests)
- PDF processing (2 tests)
- VPS API integration (3 tests)
- Data extraction (3 tests)
- Accuracy validation (9 tests)
- Error handling (6 tests)
- Cache functionality (1 test)
- Bug fixes verification (7 tests)

## Known Issues (See Code Review)

### Critical (Must fix before production)
1. Hardcoded VPS API URL (`localhost:5001`)
2. Missing input sanitization for custom dictionary (XSS risk)
3. Levenshtein unbounded strings (DoS risk)
4. ReDoS vulnerability in Vietnamese regex patterns
5. Race condition in Tesseract worker initialization

### Medium Priority
6. Inefficient O(n) dictionary lookup
7. Cache LRU eviction uses "newest" not "recently used"
8. Inconsistent error handling patterns
9. Missing debouncing on file input
10. Memory leak in diacriticCache

### Low Priority
11. Code duplication in cell correction
12. Magic numbers not extracted to constants
13. Missing accessibility attributes
14. Long functions (>100 lines)
15. Incomplete Vietnamese connector list

**Full code review**: See agent output af8d9d6

## Configuration

### VPS API (Optional)

To use real transformer-based correction:

1. Deploy `viet_diacritic_api.py` on VPS with GPU
2. Update `new.html` line 169:
   ```javascript
   const VPS_API_URL = 'https://api.yourdomain.com/restore';
   ```
3. Configure CORS headers on VPS API

**Note**: Transformer models require 2-4GB RAM + GPU for acceptable performance. Not recommended for cheap VPS. Client-side correction works well without VPS API.

### Custom Dictionary

1. Click "⚙️ ADVANCED: CUSTOM DICTIONARY"
2. Add domain-specific terms (e.g., "Xi măng", "Sắt thép")
3. Export/import as JSON
4. Persists to localStorage

## Performance

- **Small PDF** (<10 pages): Fast
- **Medium PDF** (10-50 pages): Acceptable
- **Large PDF** (>50 pages): Limited by 50MB browser limit

## Browser Support

- Chrome 90+ (recommended)
- Firefox 88+
- Safari 14+
- Edge 90+

Requires ES6, Async/Await, Web Workers, localStorage

## Dependencies (CDN)

- PDF.js 4.10.38
- Tesseract.js 5.x (Vietnamese tessdata_best)
- SheetJS (xlsx) - latest
- vietnamese_text_fixes_v2.js (bundled)

## License

See project root

## Contributing

Before submitting changes:
1. Run `node test_comprehensive.mjs` (all tests must pass)
2. Test with sample.pdf (verify Vietnamese diacritics)
3. Check browser console for errors
4. Address critical security issues from code review

## Deployment

### Static Hosting (Recommended)
```bash
# Upload to any static host (Netlify, Vercel, GitHub Pages, etc.)
new.html
confidence-tracking.js
vietnamese_text_fixes_v2.js
vn_syllable_corrector.js
vn_syllable_model.json
```

### With VPS API (Advanced)
```bash
# VPS: Install dependencies (requires GPU)
pip3 install transformers torch

# VPS: Run API server
python3 viet_diacritic_api.py

# VPS: Configure systemd, nginx reverse proxy
# Frontend: Update VPS_API_URL in new.html
```

**Cost estimate**:
- Static hosting: $0 (Netlify free tier)
- VPS with GPU: $20-50/month minimum
- VPS without GPU: Unusably slow (1-10s per request)

## Development

```bash
# Local server
python3 -m http.server 8080

# Open browser
http://localhost:8080/new.html

# Watch console for errors
# Drop test PDFs to verify extraction
```

## Troubleshooting

**Q: OCR not detecting Vietnamese characters?**
A: Check browser console for Tesseract loading errors. CDN may be blocked.

**Q: Diacritics missing in output?**
A: Verify vietnamese_text_fixes_v2.js loads. Check correction pipeline in confidence metadata.

**Q: Table columns misaligned?**
A: Try different extraction strategy. Check PDF source (scanned vs text).

**Q: Export button disabled?**
A: Must have at least 1 row extracted. Check extraction stats panel.

**Q: VPS API timeout?**
A: Falls back to client-side correction. Check API URL and CORS settings.

---

**Status**: Production-ready after security fixes
**Last tested**: 2025-02-12
**Test pass rate**: 35/35 (100%)
**Code quality**: B+ (7/10)
