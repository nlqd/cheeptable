# Reproducing CheepTable's results

Three levels, cheapest first. The project is finished; this note says what a fresh clone needs to get its numbers back, and what it cannot.

## 1. The unit tests (a minute, node only)

```
for t in test-arith test-grid test-headers test-labcache test-pages test-results test-sequence test-wire; do node $t.mjs; done
```

Expect every file to end with `all N passed` (13, 43, 5, 4, 25, 19, 10, 8). The other `test-*.mjs` files are probes, not tests.

## 2. The table-page benchmark (about 20 minutes on two lanes)

What it measures: 272 table pages of 157 public documents, each read through the whole app and scored by character 3-gram F1 against the PDF's own text layer, spaces ignored. A page passes at 0.9. The pass rule, the glyph fold and the corrupt-layer rule are in `hillclimb/size/ab_all_report.py`; the page list is `hillclimb/size/labels/page_labels.json` (label `table`).

Final result on the shipped code (`hillclimb/size/results/pages-final.csv`, per page): 272 pages, mean F1 0.9309, 219 at 0.9 or higher.

### Environment

- Python 3.12 (`.tool-versions`) with `pypdfium2` 5.3.0 and `Pillow` 11.3.0; node 24 for the tests.
- Chrome (156 here) at `/opt/google/chrome/chrome`, and `rodney`, a command-line Chrome driver. `hillclimb/ux/e2e.py` calls `rodney connect`, `open`, `waitload` and `js` and nothing else.
- About 2 GB of disk for the corpus and the page pictures.

### Steps (from the repository root)

```
python3 benchmark/fetch.py                         # the 642 corpus files and benchmark/manifest3_t*.json; prints what failed or differs; run it again to retry the failures
huggingface-cli download dzngo/vietocr-models --local-dir hillclimb/size/hosted --include 'paddleocr/*' 'vietocr/cheep-v3/*' 'vietocr/vocab.txt'
cd hillclimb
python3 ux/serve.py 8080 &
for L in 0 1; do /opt/google/chrome/chrome --headless=new --remote-debugging-port=934$L --user-data-dir=/tmp/ab3-profile-$L --no-first-run about:blank & done
for L in 0 1; do RODNEY_HOME=/tmp/ab-all-rodney-$L python3 size/ab_all.py size/repro_lane$L.jsonl --only --lane $L --lanes 2 --labcache cheep-v3 --aball size/aball_repro & done; wait
python3 size/pass_rate.py 'size/repro_lane*.jsonl'          # and size/pass_rate.py size/results/pages-final.csv for the recorded run
python3 size/ab_cmp.py 'size/ab_mark3_lane*.jsonl' 'size/repro_lane*.jsonl'    # per-page changes, if you have an older run to compare with
```

`--labcache cheep-v3` caches each line the recogniser reads by its pixels, so a second run after a code change only reads the lines that moved. Kill Chrome and the server afterwards.

Expect small drift, not identity: another Chrome or pdf.js version, the GPU against the CPU encoder (reads differ in the last digits) and documents that their sites have changed since (see `fetch.py`'s report) all move a few pages across 0.9.

## 3. The contract benchmark

`7. Biểu giá HĐ.pdf` is a private contract and is not in the repository, so this result cannot be reproduced from a clone. Its scoring files are here (`hillclimb/score.py`, `score_full.py`, `golden_v3.xlsx`); the recorded result is 473 of 473 rows found, quantity, price and total all right 1.000, description exact 0.558. Any ruled bill-of-quantities PDF with a golden sheet in the same layout can stand in.

## 4. The recogniser

The 4.8 MB distilled VietOCR (`cheep-v3`) is hosted on Hugging Face and its checksums are pinned in `docs/boq-onnx.js`. How it was built (distillation, quantisation, the training data and the commands) is in `hillclimb/size/FINDINGS-size.md`, section Reproduce, and `export_onnx.py` exports the teacher. The training data, checkpoints and teacher are not in the repository; the recipe needs the teacher VietOCR weights, a GPU and the crawl's text layers (`make_train4.py`).

## What a clone does not have

- The corpus files themselves: third-party documents, fetched by address. A site may have moved or changed a file; `benchmark/sources/sha256.txt` is the checksum of the copy measured.
- The 212 scanned documents are in the corpus but have no text layer, so they were never scored. Whether the app reads scans well is unmeasured.
- Human truth. Every score is against the PDF's text layer, which is wrong on a few pages (look-alike glyphs, an embedded bad OCR layer, `*` for a bullet the picture shows as a dash). The 272-page set was tuned on while the odd half (`crc32(id) % 2 == 1`) was kept unexamined; the final numbers include both halves.
- The audit reads behind `golden_v3.xlsx` (`audit_p*.jsonl` are in `hillclimb/`, no committed script produces them).

## Where the decisions are

`hillclimb/size/FINDINGS-size.md` is the log, newest last: what was tried, what moved the numbers, what did not and why (finer render of small print, re-reading unsure lines, VieSVTR, SLANeXt, PP-OCRv6, a syllable dictionary). `hillclimb/FINDINGS.md`, `RESEARCH.md` and `UX.md` hold the earlier recogniser, research and interface notes.
