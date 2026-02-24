# PDF Table OCR → Excel

Extracts tables from scanned PDFs with Vietnamese text support. Runs entirely in the browser — no data uploaded.

**Stack:** pdf.js · Tesseract.js · PaddleOCR + VietOCR (server) · SheetJS

**Serve:** `python3 -m http.server 8080` → open `http://localhost:8080/new.html`

**OCR server:** `source venv_paddle311/bin/activate && python3 ocr_server.py`

Auth token is set once in the browser and stored in localStorage.
