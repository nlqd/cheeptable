# Hillclimb findings (2026-10-15)

## Golden audit
`golden_v2.xlsx` fixes 61 description cells of `golden.xlsx` (every change is in `golden_changes.tsv`).
Numbers and units were right on every row, and quantity x price = total holds on all 473 rows.
The wrong text was systematic, not random:
- "búa cần khi nền" should be "búa căn khí nén"
- "muông" should be "mương"
- "Ống coi hộng" should be "Ống cơi họng"
- "Bừng chận" should be "Bửng chận"
- "(ống mới)" should be "(ống mồi)"
- one "Manchon Þ100" should be "Þ150"
Four readers audited the pages independently and agreed; I checked three of the claims on zoomed crops.

## Bias found in the existing code
- `_PHRASE_SUBS` in `docs/boq-onnx.js` rewrote correct readings into those golden mistakes.
- The word clip (`_PX_PER_WORD = 55`) truncated correct lines, because Vietnamese words average about 40 px here.
- `eval_direct.py` builds rows with column positions measured on this one PDF, so its 99% is not comparable to the app.
- The old golden flattered the server pipeline: exact description matches 56.7% against golden.xlsx, 52.0% against golden_v2.xlsx.

## Method
- Tuning and held-out parts are split by distinct description text, not by page (`score.py`).
- A second, unseen document with a different layout, fonts and vocabulary (`make_synth.py`).
- Recognition is scored per table cell, independent of the app's row building (`grid.py`, `recog.py`).

## Result (VietOCR, description character error, tuning / held-out)
| recipe | real contract | synthetic document |
|---|---|---|
| tight crop, as the detector gives it | 0.120 / 0.108 | 0.032 / 0.029 |
| plus 10 px white margin left and right | 0.024 / 0.036 | 0.012 / 0.012 |

In the real browser model (onnxruntime-web, WASM, the app's own `_recognizeBox`) on 30 sample crops: 0.133 without the margin, 0.034 with it.

Rejected:
- chunking long lines: better on the tuning part, worse held-out
- beam search: no gain, slower
- voting over several paddings: no gain
- vertical padding: worse
- the app's word clip and tail strip: 0.024 becomes 0.234

## Detector settings (found by running the real app, WASM, 2 real pages + unseen synthetic doc)
The app dropped about half of the description lines. The DB box threshold (0.6) and the 960 px detector side were both too strict for dense scanned tables; 1280 px with 0.5 recovers them (neither change alone does; probe in `det_probe.js`).
Description error, app: real pages 3-4 0.433 -> 0.123; synthetic doc 0.435 -> 0.262 (rows found stays 90 of 120, so the app's row building still loses a quarter of rows on an unseen layout).

## Grid-only prototype (`grid_extract.py`: ruled-line cells + VietOCR per text line, no detector)
| document | rows found | description error | numbers all3 |
|---|---|---|---|
| real pages 3-4 | 95/95 | 0.034 (tuning 0.020, held-out 0.059) | 1.000 |
| synthetic, unseen | 120/120 | 0.024 | 0.950 |
| full contract, 11 pages | 470/473 | 0.065 | 0.947 |
Torch on CPU, 4 s per page. Only works for tables with ruled lines. The detector is 2.4 MB of the ~79 MB download, so removing it saves little size.
Earlier numbers in this file's scoring helper runs used a trimmed golden that openpyxl `delete_rows` had damaged; rebuilt by copying rows.

## Number repair (`arith_repair.py`, ported to `docs/boq-arith.js`)
qty x price = total holds on every row. Rows that already satisfy it are never touched; otherwise a single-character fix is accepted only if it is the one fix that works, or one field is solved from the other two when its OCR text is clearly the closest. Edited numbers must be well-formed (dots group thousands, comma is the decimal mark), otherwise several spellings of the same fix compete.
Rows with all three numbers right: contract 0.947 -> 0.968, synthetic 0.950 -> 0.992; no row that was right got worse (JS port, `eval_repair.py --js`).

## int8 encoder (`quant_encoder.py`)
Static QDQ int8, first conv kept float: 29.8 MB against 55 MB fp16. Full contract (calibrated on the synthetic doc, so the contract is held out): numbers 0.945 vs 0.947 fp32, description error 0.065 vs 0.065. Dynamic int8 emits ConvInteger, which onnxruntime-web (WASM) does not implement, so it cannot be used. Quantizing only the convolutions saves almost nothing (53 MB). The int8 file must be uploaded to the model repo as `vietocr/encoder_int8.onnx`; until it exists the app falls back to fp16. Staged in `models_out/` (not committed).

## Whole app, headless Chrome, WASM (grid path + int8 encoder + number repair)
| document | rows found | numbers all right | description error |
|---|---|---|---|
| contract, 11 pages (old app, March run) | 454/473 | 0.833 | 0.395 |
| contract, 11 pages (now) | 471/473 | 0.962 | 0.063 (tuning 0.066, held-out 0.056) |
| synthetic, unseen (detector path, 1280/0.5) | 90/120 | 0.750 | 0.262 |
| synthetic, unseen (now) | 119/120 | 0.975 | 0.046 |
Cost: about 2.6 minutes per page on WASM in headless Chrome (the full contract took 29 minutes). Recognition time is dominated by the decoder, which recomputes the whole sequence at every step (no key/value cache), so a long description line takes several seconds.
A bug found on the way: the old table builder re-guessed columns from geometry and merged words closer than 10 pt across a column line, which pulled right-aligned prices into the neighbouring cell (synthetic numbers 0.70). Grid words now carry their cell and skip that logic.

## Round 2: where the remaining errors came from
66% of the description error sat in 15 rows. They were not merged rows: the row-number (STT) column was misread (`7` as `1`: 27 -> 21, 127 -> 121), so two rows shared a number and the scorer paired the wrong texts; plus junk rows made of ruling fragments read as the digit 1.
- Column lines now need to be at least 0.4 x as strong as the strongest vertical line, ignoring the page-edge shadow (a fixed 25 px threshold gave 14 columns on a short table). Stable for any value from 0.2 to 0.5.
- An ink run that fills the whole cell height and is narrower than half its height is a ruling fragment and is skipped.
- `docs/boq-sequence.js`: row numbers count up by one; a number is repaired only when the expected next number is one confusable digit away.
- Tried and dropped: merging cells across a missing separator (changed nothing on this contract).
Python prototype on the contract (`grid_extract.py` + the JS repairs): 473/473 rows, STT 473/473 in order, numbers 0.977, description error 0.024.
Whole app (browser, WASM): contract 472/473, STT 472/473, numbers 0.966, description error 0.029 (tuning 0.031, held-out 0.026); synthetic 120/120, numbers 0.975, description error 0.029 (was 0.046).
Not done on purpose: mapping `P`/`2`/`b` before a diameter back to the glyph `Þ`. It would be fitted to this contract's font and would corrupt real "P150" in other documents. It accounts for about 125 of the remaining description error characters; "đổ" read as "đồ" accounts for 44.

## Not measured
- Borderless tables: the grid path returns nothing there and the detector path runs as before; only the contract and the synthetic document (both ruled) were tested.
- WebGPU: the new backend check (adapter must have `shader-f16`) was written after seeing fp16 models return only `<pad>` tokens under a WebGPU adapter without f16; I did not run a machine with working f16 shaders.
- A real second scanned document from a different supplier.
- docs.opencv.org answers scripted browsers with a Cloudflare challenge page, so `cv` never loads there; the harness uses a pinned local copy (`vendor/`, not committed).

## Remaining errors
The diameter sign Þ read as 2, P or b (about 75 cells), and "đổ" read as "đồ". Section headings and rows where two ruled lines are faint (two logical rows in one grid row).
