# CheepTable

Free Vietnamese OCR that turns tables in PDFs and photos into Excel, entirely in the browser: no server, no account, no upload. Live at https://ocr.dzungngo.com (GitHub Pages, `docs/`).

Run locally: `python3 hillclimb/ux/serve.py 8080`, then open http://localhost:8080/docs/index.html

Tests: `node test-grid.mjs`, and likewise `test-arith`, `test-sequence`, `test-results`, `test-wire`. Browser checks are in `hillclimb/ux/`.

The recogniser is an 8.6 MB distilled VietOCR hosted on Hugging Face (`dzngo/vietocr-models`); how it was built and measured is in `hillclimb/size/FINDINGS-size.md`. Other measurements and research are in `hillclimb/`.
