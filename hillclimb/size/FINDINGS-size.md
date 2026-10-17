# Shrinking the recogniser: 40.7 MB to 8.6 MB (2026-10-17)

Goal from the user: the models must not be larger than 15 MB (40 MB takes too long to download), with little loss of accuracy.
Result: a distilled, quantised VietOCR of 8.6 MB (all three graphs, one entropy-coded file) that matches the 40.7 MB production models on the 473-row contract, in the browser, on both the CPU and the WebGPU path.

## Baseline and the measuring set

Teacher: VietOCR vgg_transformer, 37.65M parameters (VGG19-bn 20.0M, transformer encoder 7.9M, decoder 9.4M), shipped as 40.7 MB (int8 encoder 29.8 MB, int8-weight decoder 10.9 MB).

Fixed evaluation set (`make_data.py`, `evalkit.py`), 3,513 crops read by greedy decoding:
- the 473 golden rows of the contract, five cells each (description, unit, quantity, price, total), cut by the grid reader at 3x, with the ruling-line remnants the real pipeline leaves in;
- 1,148 text lines from the 12 born-digital public PDFs, clean and degraded ("rough"), answer = the PDF text layer.
The contract and the benchmark pages used here are held out of every training set. `agree_err` is the character error against the teacher's own reads (what compression changed), measured on all 3,513 crops; the teacher's noise floor (CPU against GPU, 5 reads in 3,513 differ) is 0.0014 of reads.

Teacher on this set: contract description CER 0.0301, quantity/price/total all right 0.962 (no arithmetic repair), benchmark lines 0.0226 clean and 0.0435 rough.

## What was tried, in order

1. Post-training quantisation, one module group at a time (per-row round to nearest, `exp1.py`). Int8 is harmless everywhere. Int4 is harmless for the 512-wide convolutions, attention and embeddings (disagreement 0.1 to 0.8%), but the early convolutions cost 3.8% and the decoder FFN collapses into runaway decoding. Int3 breaks the FFNs. The codes of an int4 grid have about 2.6 bits of entropy, so an entropy coder is worth having.
2. Distillation with quantisation-aware training (`kd.py`): the student starts as the teacher, learns from the teacher's output distribution on the teacher's own prefixes, plus the encoder output (mean squared error). Weights go through a learned-step fake quantiser (one step per row, or per 64/128 weights), steps trained with a tenfold learning rate and rounded to fp16 so training sees what ships. Training data: 63k lines (25k real lines from public PDFs, 40k rendered with 92 fonts and degraded) labelled by the teacher itself, no human labels. Fifteen minutes of training per variant on one RTX 4070 Ti SUPER. This alone brought int3/int4 to the teacher's accuracy: 15.3 MB at CER 0.0283 (`q_c`).
3. A rate penalty on the codes (log-magnitude proxy for entropy) trims the FFNs further; per-weight entropy of the convolutions barely moves.
4. Structure. Dropping 2 or 4 of the eight 512x512 convolutions, or cutting them to 320/384 channels, costs 1 to 2 points of description CER (`s1` to `s3`, `q_e`) even though numbers hold. Halving the FFN width (2048 to 1024) costs 0.2 points and saves 2 MB (`v1`). Four instead of six layers hurts numbers (`v2`). Kept: FFN 1024, everything else as is.
5. Two bits for the 512 convolutions and the FFNs, three for attention, six for the first convolutions (`x1`, `x2`): 8.2 MB estimated, CER 0.0305.

## A failure the metric hid, and the fix

Early students read a lone right-aligned quantity such as "2" as "1990002" (7 cells, all in the quantity column; quantity accuracy fell 1.5 points while descriptions looked fine). The cause was the training data: the contract's cell crops are wide, mostly white, with ruling-line remnants at the edges, and training had only tight text lines. A shard of 30,000 synthetic cell-like crops (right/left/centre aligned, numbers, units, short text, edge lines) fixed it (`make_cells.py`): numbers went from 0.943 to 0.970 all-right.

## Results (evaluation set; teacher: CER 0.0301, numbers 0.962, rough 0.0435)

| run | what | size (est.) | contract CER | numbers all right | lines clean / rough | agree_err |
|---|---|---|---|---|---|---|
| q_a | int4 (dec FFN int6), 3,000 steps | 20.0 MB | 0.0281 | 0.958 | 0.0204 / 0.0422 | 0.0049 |
| q_c | int3 convs and encoder FFN | 15.3 MB | 0.0283 | 0.949 | 0.0210 / 0.0401 | 0.0071 |
| u_f1 | all int3, rate penalty, cell shard | 13.8 MB | 0.0277 | 0.970 | 0.0203 / 0.0409 | 0.0071 |
| v3 | int2 convolutions | 11.3 MB | 0.0291 | 0.973 | 0.0204 / 0.0400 | 0.0103 |
| x3 | v3, 8,000 steps, rate 0.02 | 10.6 MB | 0.0289 | 0.962 | 0.0198 / 0.0388 | 0.0088 |
| x1 | FFN 1024, int2 FFN | 8.5 MB | 0.0310 | 0.966 | 0.0192 / 0.0380 | 0.0122 |
| **x2** | **x1 with 4-bit first convolutions** | **8.2 MB** | **0.0305** | **0.966** | **0.0192 / 0.0383** | 0.0131 |
| s3 | CNN pruned (320 wide, 2 convs dropped), int3 | 10.0 MB | 0.0464 | 0.975 | 0.0208 / 0.0535 | 0.0255 |

Paired bootstrap of x2 against the teacher (`paired.py`): contract description CER +0.0004, 95% interval [-0.0031, +0.0029] over 473 rows, so no difference can be shown; benchmark lines -0.0043 [-0.0069, -0.0019] over 12 documents (the same documents contributed other pages to training, so this one may be optimistic).

## Shipping format (`build_wire.py`, `docs/boq-wire.js`, `docs/boq-sessions.js`)

- Each large weight in the exported fp32 graphs lies exactly on a grid (codes times a step per group), so codes and steps are recovered from the float values; nothing depends on which exporter produced the file. The graph keeps its weights as external-data initializers followed by Cast, Mul, Reshape (and Transpose): ONNX Runtime folds them when the session opens.
- Codes are entropy coded per tensor with a static rANS coder (14-bit probabilities); the size is within 1% of the order-0 entropy. Steps and the small tensors are fp16. Decoding all 31M weights takes about 0.3 s in node.
- One file, `model.bin` (8.62 MB), plus four small graph files (enc, encq, init, step: 0.35 MB). The page rebuilds the external-data arrays and passes them to `InferenceSession.create(..., { externalData })`.
- CPU path (`encq`): statically quantised int8 convolutions, the transformer layers stay fp32. The int8 convolution weights and their per-row steps are rebuilt in the page from the same codes (`requant`), so they cost no extra download. Quantising the transformer layers as well (the old production recipe) is 30% faster but raises the description CER from 0.029 to 0.038 and is not used. Calibration crops: 160 training crops (`calib.npz`).
- GPU path (`enc`): float32 compute, same weights.
- The decoder is the cached one (init + step) as before; the number of layers is read from the graph.
- Files live under a versioned path (`vietocr/cheep-v1/`) because the browser caches by URL.

Dequantised model, ONNX Runtime, same 3,513 crops: wire package reproduces the torch result (CER 0.0306 float, 0.0302 with int8 convolutions; agree_err 0.0131 and 0.0124).

## In the browser (full 11-page contract, rows as the engine delivers them, `e2e.py` + `score.py`)

| | download | time | rows found | numbers all right | description CER | exact descriptions |
|---|---|---|---|---|---|---|
| production (int8 encoder, int8-weight decoder) CPU | 40.7 MB | 99 s | 473 | 0.968 | 0.022 | 0.438 |
| production, WebGPU | 40.7 MB | 57 s | 473 | 0.968 | 0.022 | 0.457 |
| x2 CPU (int8 convolutions) | 8.6 MB | 95 s | 473 | 0.977 | 0.021 | 0.436 |
| x2 WebGPU | 8.6 MB | 57 s | 473 | 0.979 | 0.021 | 0.431 |

The same model with float convolutions on CPU took 156 s; the int8 convolutions are what brings it back to 95 s.

## Review flags

The student is more confident (median description confidence 93.5 against 92.5), so the old cutoffs flagged fewer cells. Recalibrated on the contract (`flags_calib.py`) to flag as many cells as before: check below 91 (16.5% of cells, 96% really wrong), maybe below 93 (40%, 87%). Numbers: cutoff 80 kept.

## A second, larger check: 52 public documents (`benchmark/manifest2.json`, held out of all training)

Collected by an agent: price lists, forms, timetables, financial statements, legal text, papers, medical lists, old scans, borderless tables. 35 born-digital, 17 scanned. The PDFs are not committed.

- Line reading (`bench2.py`, 4,434 lines from the 35 born-digital documents, clean and degraded, answer = text layer; some text layers are garbled legacy fonts, so absolute errors are high): teacher 0.1137, student x2 0.1161, difference +0.0024, 95% interval over documents [-0.0046, +0.0140]. Not distinguishable. Per category the student is better on price lists (-0.007) and legal text (-0.002) and worse on forms (+0.038, driven by one customs form whose text is rows of placeholder "XXXX" where the count of repeated letters is misread).
- The whole app on the first 3 pages of each document (`corpus_e2e.py`): no errors or crashes. All 35 born-digital documents give rows. Of the 17 scans, 10 give rows and 7 report "no table": five 1948 gazette pages (prose, expected) and two scanned financial statements with ruled tables (not expected, not yet investigated). "Gives rows" is coverage only, there is no answer key for the structure.

## Bugs found with the 52-document corpus (and fixed)

Two scanned financial statements first looked like "no table found". Reading why turned up five problems in the page logic, none of them in the recogniser:

1. A scanned page that carries an OCR text layer was treated as a born-digital page: its (unreliable) text was used as it stood and its ruling lines, being pixels, were never seen. Such a page is now recognised by one image covering nearly the whole page and is read from the picture.
2. A file with both kinds of page (a statement with scanned signature pages) kept only the scanned pages' rows. Each kind now goes through its own extractor and the rows are merged in page order.
3. The detector path (pages with no ruled grid) returned no text lines, so the line-based extractors had nothing to work on and produced zero rows. Lines are now built from the detected boxes.
4. The extractor was chosen once per file: 27 cells found in two small boxes on two pages made the whole 6-page file "grid", and the other four pages vanished (6 rows instead of 135). The choice is now per page.
5. Born-digital pages never became tables at all: every line came out as one cell (87 rows with one cell each for a price list). Columns are now found from the gutters between the boxes of a text layer, with the ruling lines as the second choice. A page where fewer than three rows, or fewer than one in five, have two or more cells is left out, and if no page is a table the app says so (a gazette scan or a letter now ends in "no table" instead of a column of lines).

Also: the quantity x price = total check was applied to any table with six or more columns (117 false flags on a score list); it now runs only on a bill of quantities. A cleanup of mine had deleted three cell helpers still used by the unruled-table path; `hillclimb/ux/undefined_names.sh` now catches that kind of slip.

Not measured: the structure of these tables has no answer key. On the first six pages of the 52 documents, 40 give a table and none fail; the 12 without one are short documents whose pages are not tables or have layouts the gutter method does not split (checked by hand on two). The contract's rows are byte-identical before and after.

## The student against the original model, in the whole app, on the 52 documents

Both models packaged the same way (the original with fp16 weights, same int8 convolutions) and run through the same page code over the first 6 pages of every document (`ab.sh`, `ab_report.py`).

- 40 of 52 documents give identical output: they come from a text layer and no model is involved.
- The 12 that use the recogniser: the two scanned financial statements differ by 0.017 and 0.006 of characters, the legal scans by 0.007 to 0.118, the 1948 French-Vietnamese gazette scans by 0.14 to 0.24, a receipt form by 0.17. Differing says nothing about which is right, and old print is hard for both.
- Where the answer is known (`ab_pages.py`): 11 table pages of born-digital documents turned into pictures at 200 dpi, the text-layer table as the key. Student: mean row recall 0.416, character error 0.406, same cell count in 0.674 of matched rows. Original: 0.414, 0.401, 0.674. Page by page they are within 0.005 of each other except one drug list (both fail: 5 rows out of 52). So the smaller model is as good as the original on these pages.
- The same table shows how weak the picture path is on dense tables, for either model: recall under 0.1 on a price list, a score list and a land-price table, 0.38 on a timetable, 0 on one paper. Row splitting and merging, not the text, dominates the error there. This is the next thing to work on.

## What these numbers do not show

- The model was chosen among about 25 variants on the contract and benchmark set that it is then reported on. The held-out checks above (52 documents) are the independent part, and they agree.
- `golden_v2.xlsx` was corrected using readings from our own audit runs (`make_golden_v2.py`, `audit_p*.jsonl`; the script that produced the audits is not committed). Scores against it can favour our own models' habits.
- `line_bench.py` only scores lines whose characters are in the recogniser's vocabulary and which are at least 5 characters and 25 px wide. Short units and numbers are covered by the contract cells; the diameter sign is not in the vocabulary and is not scored.
- The cell shard (`make_cells.py`) was designed after seeing how the student failed on the contract's cells. The 52-document check has few ruled cells, so it says little about that fix.

## Not done, not known

- No real phone, Safari or Firefox; externalData is only exercised in Chrome. Memory per worker was not measured (estimated 70 to 80 MB against about 250 MB before).
- A model trained on teacher labels inherits the teacher's mistakes; unseen fonts and handwriting are untested. Contract numbers are the held-out result; benchmark lines share documents with the training pages.
- Steps could be coded in 8 bits and the two sinusoid tables (0.4 MB) regenerated in the page: about 0.5 MB more.
- Int2 attention as well (`x5`): 7.6 MB, contract CER 0.0314, agree_err 0.0140. Not adopted: it saves 0.6 MB for about 0.001 of CER.

## Reproduce

`make_data.py` (eval set), `make_train.py`, `make_cells.py`, `label.py` (training data), `kd.py NAME --plan plans/j.json --ffn 1024 --steps 8000 --lam 0.02` (train), `release.sh NAME plans/j.json --ffn 1024` (export, int8 encoder, wire package, check), `onnx_eval.py DIR` (score a package; `ENC=encq` for the int8 encoder). Environments: `venv_train` (torch cu128), `venv_onnx_export` (exports). Training data, checkpoints and packages are not committed.
