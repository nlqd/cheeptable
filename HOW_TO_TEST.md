# How to Test the Vietnamese OCR App

## Quick Start (30 seconds)

```bash
# 1. Start the server
cd /home/dungngo/experiments/vietocr
python3 -m http.server 8080

# 2. Open in browser
http://localhost:8080/new.html

# 3. Click "Try Sample PDF" button
# → Should extract 10 rows with Vietnamese diacritics
```

**Expected Result:**
- Row 1: "bảng kê giá vật liệu xây dựng" ✓
- Row 5: "1. Xi **măng** Holcim" ✓
- Row 6: "2. Sắt **thép** Hòa Phát" ✓
- All Vietnamese diacritics present ✓

---

## Testing Methods

### Method 1: Manual Browser Test (Easiest)

**Steps:**
1. Start server: `python3 -m http.server 8080`
2. Open: http://localhost:8080/new.html
3. Click "Try Sample PDF" or drag your own PDF
4. Wait for processing (should be instant for 1KB test file)
5. Verify table has Vietnamese diacritics

**What to Check:**
- ✓ All rows extracted (should see 10 rows)
- ✓ Vietnamese diacritics present (ả, ê, ă, ơ, ư, đ, etc.)
- ✓ Table structure preserved (columns aligned)
- ✓ Download Excel button works

---

### Method 2: Automated Test Suite

**Run all 35 automated tests:**

```bash
cd /home/dungngo/experiments/vietocr

# Make sure mock API is running (optional but recommended)
python3 simple_mock_api.py &

# Run comprehensive tests
node test_comprehensive.mjs
```

**Expected Output:**
```
✅ ALL TESTS PASSED
Total tests: 35
Passed: 35 ✅
Failed: 0 ❌
Pass rate: 100.0%
```

**What's Tested:**
- Application loading (4 tests)
- PDF processing (2 tests)
- VPS API integration (3 tests)
- Data extraction (3 tests)
- Vietnamese accuracy (9 tests)
- Error handling (6 tests)
- Bug fixes (8 tests)

---

### Method 3: Browser Automation (Rodney)

**Automated browser testing:**

```bash
# Start servers
python3 -m http.server 8080 &
python3 simple_mock_api.py &

# Run browser test
rodney start
rodney open http://localhost:8080/new.html
rodney file '#fileInput' sample.pdf

# Wait a moment, then extract results
sleep 3
rodney js 'document.body.innerText' | grep -A 10 "TABLE PREVIEW"

# Stop browser
rodney stop
```

**Expected to see:**
```
TABLE PREVIEW (10 ROWS)
#	Col 1	Col 2	Col 3	Col 4
1	bảng kê giá vật liệu xây dựng			
2	dự án: xây dựng nhà ở cao tầng			
...
```

---

### Method 4: Test Your Own PDF (4.8MB file)

**⚠️ WARNING:** Large PDF will hang in browser (known issue)

If you want to test your real 4.8MB, 11-page PDF:

```bash
# Option A: Use command-line OCR (works)
cd /home/dungngo/experiments/vietocr

# Extract page 1 image
pdfimages /path/to/your.pdf /tmp/page -j

# Rotate it
convert /tmp/page-000.jpg -rotate 270 /tmp/page1_rotated.jpg

# OCR it
tesseract /tmp/page1_rotated.jpg /tmp/output -l vie --psm 6

# View results
cat /tmp/output.txt
```

**Option B: Try in browser (may hang)**
1. Open http://localhost:8080/new.html
2. Upload your 4.8MB PDF
3. ⚠️ If it hangs, wait 5 min then refresh
4. Check browser console (F12) for errors

**Known Issue:** 
- App hangs on large scanned PDFs (rotated images)
- Needs timeout fix + page rotation handling
- See REAL_PDF_TEST_REPORT.md for details

---

## Testing Different Scenarios

### Test 1: Small Text-Based PDF ✅ Works
- File: sample.pdf (1.1KB, 1 page)
- Expected: Instant processing, 10 rows, perfect diacritics
- Status: ✅ **Production Ready**

### Test 2: Large Scanned PDF ❌ Hangs
- File: Your 4.8MB, 11-page PDF
- Expected: Hangs during OCR on page 1
- Status: ❌ **Needs fixes** (see issues below)

### Test 3: Without VPS API ✅ Works
- Stop mock API: `pkill -f simple_mock_api.py`
- Test: Upload sample.pdf
- Expected: Falls back to dictionary + syllable model
- Accuracy: ~75% (vs 100% with VPS API)

### Test 4: Custom Dictionary ✅ Works
1. Click "⚙️ ADVANCED: CUSTOM DICTIONARY"
2. Add Vietnamese words (e.g., "Xi măng", "Sắt thép")
3. Export to see JSON format
4. Import a JSON file with custom words
5. Process PDF - custom words should be preserved

---

## Quick Verification Checklist

**After any code changes, verify:**

```bash
# 1. Automated tests pass
node test_comprehensive.mjs
# → Should see: 35/35 tests passing

# 2. Small PDF works in browser
# Open http://localhost:8080/new.html
# Click "Try Sample PDF"
# → Should see 10 rows with Vietnamese diacritics

# 3. No console errors
# Open browser DevTools (F12) → Console
# → Should see no red errors (warnings OK)

# 4. Download works
# Click "Download Excel (.xlsx)"
# → Should download file with Vietnamese text
```

---

## Testing the Bbox Hypothesis (Advanced)

If you want to test the bbox-based OCR approach:

```bash
# Option 1: Run the iteration test we just did
cd /tmp
bash /tmp/final_bbox_comparison.sh

# Expected: +2.2% improvement with manual bboxes

# Option 2: Test with proper table detection (when installed)
# Install PaddleOCR first:
pip3 install paddleocr

# Then run:
python3 << 'EOF'
from paddleocr import PPStructure
structure = PPStructure(lang='vi')
result = structure('/tmp/page1_rotated.jpg')
for item in result:
    if item['type'] == 'table':
        print(f"Found table with {len(item['res']['cells'])} cells")
EOF
```

---

## Performance Testing

**Small PDF (1.1KB):**
- Expected: < 1 second
- Test: `time` command while processing

**Large PDF (4.8MB, 11 pages):**
- Expected: Currently hangs (timeout needed)
- With fixes: ~30-60 seconds expected
- Test: Monitor with browser DevTools → Performance

---

## Troubleshooting

### Issue: "Try Sample PDF" button doesn't work
**Fix:** 
```bash
ls -lh sample.pdf
# Should show 1.1KB file
# If 4.8MB, revert: git checkout sample.pdf
```

### Issue: No Vietnamese diacritics in output
**Check:**
1. VPS API running? `curl http://localhost:5001/health`
2. Browser console errors? (F12 → Console)
3. Vietnamese dictionary loaded? Check page source includes `vietnamese_text_fixes_v2.js`

### Issue: Tests fail with "Module not found"
**Fix:**
```bash
npm install  # Install test dependencies
```

### Issue: Browser shows blank page
**Check:**
1. Server running? `curl http://localhost:8080/new.html`
2. Check browser console (F12) for JavaScript errors
3. Try different browser (Chrome recommended)

---

## Testing Production Deployment

**Before deploying to Netlify/Vercel/GitHub Pages:**

1. **Test locally first:**
   ```bash
   python3 -m http.server 8080
   # Open http://localhost:8080/new.html
   # Verify everything works
   ```

2. **Test required files are present:**
   ```bash
   ls -lh new.html confidence-tracking.js vietnamese_text_fixes_v2.js \
          vn_syllable_corrector.js vn_syllable_model.json
   # All 5 files should exist
   ```

3. **Test without VPS API** (production won't have it):
   ```bash
   pkill -f simple_mock_api.py  # Stop mock API
   # Test app still works (uses fallback)
   ```

4. **Test CDN dependencies load:**
   ```bash
   curl -I https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
   # Should return 200 OK
   ```

---

## Test Data

**Included Test Files:**
- `sample.pdf` (1.1KB) - Small test, instant results
- `ground_truth_rows.txt` - Expected output for accuracy testing

**Your Real Data:**
- Large 4.8MB PDF - Currently hangs (see REAL_PDF_TEST_REPORT.md)
- Needs rotation fix + timeout implementation

---

## Next Steps After Testing

**If small PDF works (✅ it does):**
→ Deploy to production (Netlify/Vercel)

**If you need large PDF support:**
→ Implement fixes from REAL_PDF_TEST_REPORT.md:
  1. Add OCR timeout (2 min/page)
  2. Handle page rotation (270°)
  3. Add progress feedback
  4. Implement cancel button

**If you want bbox improvement:**
→ Implement PaddleOCR integration:
  1. Install: `pip3 install paddleocr`
  2. Create API endpoint
  3. Test bbox detection
  4. Expect +10-15% accuracy

---

## Quick Test Commands

```bash
# Full test suite
python3 -m http.server 8080 &
python3 simple_mock_api.py &
node test_comprehensive.mjs
pkill -f "http.server"
pkill -f "simple_mock_api"

# Browser test
python3 -m http.server 8080 &
open http://localhost:8080/new.html  # or visit in browser
# Click "Try Sample PDF"

# Command-line OCR test
pdftotext sample.pdf - | head -10
```

---

**Need help?** Check these docs:
- `README.md` - Full deployment guide
- `SECURITY_FIXES_APPLIED.md` - What was fixed
- `TABLE_OCR_RESEARCH.md` - Future improvements
- `BBOX_ITERATION_RESULTS.md` - Bbox testing details
