# Shrinking the recogniser: 40.7 MB to 8.6 MB (2026-10-17), then to 4.8 MB (2026-10-18)

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

## Second climb (2026-10-18): true labels, more data, narrower CNN: 4.8 MB, better than the original

The first student copied the teacher's reading of the pictures, so it could not beat it. Every training line also has the text it was made from (the PDF text layer, or the rendered string), so the students below learn from that, with the teacher's output distribution as a second, weaker signal. Held-out score added to every run: `bench2` = character error on 4,434 lines of 35 documents of the 52-document corpus (some keys are garbled legacy fonts, so only compare models). Original: contract description error 0.0301, bench2 0.1137.

| run | change | size | contract CER | bench2 | numbers (cells) |
|---|---|---|---|---|---|
| x2 | first climb: teacher labels | 8.2 MB | 0.0305 | 0.1161 | 0.966 |
| y1 | true labels (CE 1.0, KL 0.5) | 8.2 | 0.0301 | 0.1072 | 0.985 |
| y4 | + 64k more real lines, 12k steps | 8.1 | 0.0289 | 0.1039 | 0.985 |
| y5 | + 2-bit attention | 7.5 | 0.0299 | 0.1028 | 0.985 |
| y6 | + CNN 512 to 384 channels | 5.8 | 0.0302 | 0.1037 | 0.985 |
| y9 | CNN 320 channels | 5.1 | 0.0293 | 0.1105 | 0.985 |
| y13 | CNN 320, 20k steps | 5.0 | 0.0290 | 0.1049 | 0.985 |
| y10 | CNN 256 channels | 4.4 | 0.0363 | 0.1125 | 0.985 |
| y14 | y13 + coarser steps (group 128) + stronger rate term | 4.5 | 0.0302 | 0.1053 | 0.985 |
| **y16** | **y14 + new numeric data, teacher's reading kept on numeric lines** | **4.55** | **0.0295** | **0.1072** | 0.981 |

Dropped: FFN 768 (CER 0.0325), CNN 256 channels (0.0363), more teacher weight (y17), the wider CNN (y18, 5.5 MB for no gain).

A trap the cell-level metric missed: the true-label students scored 0.985 on numbers in my cell crops, but in the browser (line boxes cut by the grid reader) the contract numbers fell to 0.93-0.95: they wrote "3.976,875" for "3.976.875" and dropped trailing groups. Cause: synthetic numbers with a decimal comma and three digits, and truth labels for dot-or-comma where the teacher was sure. Fix: realistic number formats and the teacher's reading kept on purely numeric lines (y16). Always judge a candidate in the browser on the contract, not on the cell set alone.

y16 in the browser (contract, 473 rows): CPU 71 s, WebGPU 58 s (original 95/57); numbers 0.966 (0.977 for the first student, 0.968 for the original); description error 0.020 (0.021); exact descriptions 0.482 (0.436). On the 52 documents in the app against the original run with the same page code: 39 documents identical, the other 13 equal on average when scored against their own OCR text layer (word F1 0.420 against 0.420). Review cutoffs recalibrated: description check below 93 and maybe below 95.5 (the model is more confident). Package: `vietocr/cheep-v2/` (model.bin 4.78 MB plus 0.33 MB of graphs); the positional tables are now a formula in the page.

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
- That table's low row recall is mostly the key (one row per text line against one per table row); see the next section for a fairer measure.

## Reading dense tables from pictures: a measured climb

The earlier "row recall under 0.1" was a flaw in the key, not in the extraction: the text layer gives one row per text line, while a grid reader correctly gives one row per table row (the drug list's 5 rows are right). A better yardstick (`capture.py`, `lab.mjs`, `lab_score.py`): 36 table pages of born-digital documents drawn as 200 dpi pictures, read once by the page code and kept, so the extractor can be changed and rescored in seconds. Score = word F1 between the output and the text layer, where recall counts only the text inside the area the page reading covered (titles and notes outside the table are not held against it). Split by document: 26 dev pages, 10 test pages; two papers whose text layer is a legacy font are not scored (22 dev pages scored).

| step | dev word F1 | test word F1 |
|---|---|---|
| start | 0.848 | 0.809 |
| keep spaces in text columns of the unruled-page extractor (it was deleting them) | 0.879 | 0.809 |
| tall text bands split at the least-ink row (justified lines touching each other were read as one garbled line), one typical line height per column; sideways text left alone | 0.924 | 0.857 |
| a grid of fewer than 20 cells is not used (a page with a small box returned nothing) | included above | included above |

Tried and dropped: cutting very wide lines into pieces before reading raised nothing on the pages and tripled the contract's description error (0.021 to 0.067), so it was removed; reading pages at 300 dpi instead of 200 helped some pages by 0.05 to 0.10, hurt others by as much, and costs 2.25 times the pixels (mean +0.007 on 8 pages). The contract after the final change: numbers 0.977, description error 0.021, as before.

Caveats: the key is the text layer of the same documents, the structure score (pair F1, from the same gutter method as the key) did not move and is not trustworthy, and the 36 pages come from the same 35 documents the other checks use.

## A phone photo of a price board that failed (received by Taildrop)

A photo of a service price board (12 vehicle models by 15 jobs, a time row and a price row per job, red banner, warm light, faint rules) came out as 7 rows of invented words ("Contraction", "038000000099"). Causes, all fixed:

1. The grid finder found 13 columns but only 8 rows (the faint horizontal rules were missed), so each grid row held four or more table rows, and a cell's lines were read together as one block. Such a grid is now recognised (most words sit in rows whose median cell has 3 or more lines, or the cells read at average confidence under 60) and the page is read as text instead. A grid row that is only partly crowded is cut into bands by the vertical position of its lines.
2. The bill-of-quantities repairs (row numbers count up, quantity x price = total) ran on every table with six or more columns. On this table they turned 24.000 into 576.000.000. They now run only when the table looks like a bill of quantities (`looksLikeBoq`, moved into `boq-arith.js`).
3. Result: 33 rows with the right step numbers, descriptions, times and prices in most cells; some cells drift one column and a few reads are wrong ("12:000"). Not measured against a key: the photo has no text layer.

## What these numbers do not show

- The model was chosen among about 25 variants on the contract and benchmark set that it is then reported on. The held-out checks above (52 documents) are the independent part, and they agree.
- `golden_v2.xlsx` was corrected using readings from our own audit runs (`make_golden_v2.py`, `audit_p*.jsonl`; the script that produced the audits is not committed). Scores against it can favour our own models' habits.
- `line_bench.py` only scores lines whose characters are in the recogniser's vocabulary and which are at least 5 characters and 25 px wide. Short units and numbers are covered by the contract cells; the diameter sign is not in the vocabulary and is not scored.
- The cell shard (`make_cells.py`) was designed after seeing how the student failed on the contract's cells. The 52-document check has few ruled cells, so it says little about that fix.

## Third climb: crops with no text, and the top of the page (cheep-v3)

What the contract score hid: it counts the 473 numbered rows only. Scoring every row of the sheet (`score_full.py`, `golden_v3.xlsx`: 550 rows, the non-item rows transcribed twice blind from the page pictures) showed that on the live model the title block was cut at the table's column lines ("VIỆT NAM" came out as "Y | YẾT NA | M"), the header of every page was repeated, shaded header cells and ruling stubs came out as invented digit strings ("03800000099"), and page 11 lost its whole last column.

| Cause | Fix | Evidence |
|---|---|---|
| A page-edge shadow counted as a ruled line, so the whole heading was one row cut at the column lines | a horizontal rule belongs to the table only if column rules cross it (joints, as in lattice table readers); the heading is read as whole lines (word-gap cuts) on the first table page only | heading character error 0.049 to 0.000 |
| Column rules were looked for in the central 4 to 96% of the page; page 11's table edge sits at 97% | 2 to 98.5% | numbers all right on the contract 0.966 to 0.979 |
| Header and column-number rows repeat on every page | `boq-headers.js` drops the later copies | extra rows 20 to 2 |
| The recogniser always emits text, so noise gets text | `make_empty.py`: 24,000 crops of paper texture, specks, ruling stubs, underlines, fold marks, shaded cells with the end token as target and no teacher KL; fine-tuned from y16 for 5,000 steps (z1) | rows with 9 or more invented digits over 208 held-out pages: 108 (y16) to 10 (z1); word F1 against the text layer -0.001 (neutral) |

Tried and dropped (each made the contract's description error worse, 0.020 to 0.024 or 0.028): removing ruling remnants at cell edges, dropping speck bands, a narrower ink span. Paper-texture despeckling (a lone dark pixel is not ink) was neutral and kept.

Held-out check of the whole change (page code and z1 together against the live code and y16, 208 page pictures of the 594-document set): word F1 against the text layer +0.032 on 82 pages (better 28, worse 16, same 38; the two largest losses are a noisy table page that now has a clean header and an English math page). Re-run at `bc65b13` plus the text-layer coverage gate (2026-10-20), same 82 pages, 4 lanes with isolated browser state (`RODNEY_HOME`) and an empty read scored 0: **+0.056** (better 35, worse 12, same 35). The y16 arm reproduced the old numbers exactly on all 82 pages, so the gain is in the page code since that run (the z1 arm alone rose +0.024). Across the wider 266-page run (145 pages with a text layer, 133 of them in table-style documents; 58 pages the old selection never scored, 55 of which z1 still reads as nothing) the table mean with empty reads at 0 is **+0.050**, and the paired mean over the 87 pages both arms read is **+0.051**. The old +0.032 was therefore not inflated by the empty-read rule; it was the code at that time. On 58 pages without a text layer, the page code alone (blind judges): new 26, old 15, tie 11, both bad 6. Contract in the browser: 473 of 473 rows, numbers 0.979, description error 0.021 (0.020 before). Review cutoffs unchanged (calibration identical).

Not fixed: `Þ` (the vocabulary lacks it) is read as P, 9 or b; the equation row "A = 1+2+...+8" is read as digits; a glossy coloured bus-timetable board is read as garbage by both models.

## Not done, not known

- No real phone, Safari or Firefox; externalData is only exercised in Chrome. Memory per worker was not measured (estimated 70 to 80 MB against about 250 MB before).
- A model trained on teacher labels inherits the teacher's mistakes; unseen fonts and handwriting are untested. Contract numbers are the held-out result; benchmark lines share documents with the training pages.
- Steps could be coded in 8 bits and the two sinusoid tables (0.4 MB) regenerated in the page: about 0.5 MB more.
- Int2 attention as well (`x5`): 7.6 MB, contract CER 0.0314, agree_err 0.0140. Not adopted: it saves 0.6 MB for about 0.001 of CER.

## Reproduce

`make_data.py` (eval set), `make_train.py`, `make_cells.py`, `label.py` (training data), `kd.py NAME --plan plans/j.json --ffn 1024 --steps 8000 --lam 0.02` (train), `release.sh NAME plans/j.json --ffn 1024` (export, int8 encoder, wire package, check), `onnx_eval.py DIR` (score a package; `ENC=encq` for the int8 encoder). Environments: `venv_train` (torch cu128), `venv_onnx_export` (exports). Training data, checkpoints and packages are not committed.

## What these numbers do not show

Limits of the measurements above, found by an outside review of the repository (2026-10-26) and checked against the scripts:

- `line_bench.py` scores only reference lines whose characters are all in the recogniser's vocabulary, and drops lines under 5 characters or 25 pixels. A letter the model cannot write (`Þ`, the diameter sign, about 28% of the error on the contract) and short units or numbers are therefore never scored there. The contract and page-level runs do count them.
- `make_golden_v2.py` takes the golden text from what the audit readers saw (`seen`) and keys the edits by STT, so test-split descriptions were edited too. The corrected golden is not human truth, and no committed script produces `audit_p*.jsonl`.
- `eval_variants.py` cuts the golden to the STT range of one run, so a variant that misses rows is scored on fewer of them.
- The model was chosen on the same evaluation set it is reported on. The table work (`ab_all_report.py`) splits the documents by `crc32(id) % 2` and keeps the odd half unexamined while fixing; the model comparison above does not.
- A page whose own text layer is a bad embedded OCR layer is left out of the page pass rate by `ab_all_report.py` (two pages so far) and listed, since the yardstick there is the fault.

## Fine-tuning on the crawl's own text layer (a1, a2; 2026-10-26)

`make_train4.py` cuts 109k real lines from the 201 born-digital documents whose id hashes even (labelled table pages and the contract left out), adds 40k rendered lines, 24k empty crops, and the old table-cell and short-cell shards; labels are the PDF text layers, not the teacher. `eval_bench3.py` scores checkpoints on 6,000 lines from the odd half (never trained on). Fine-tuning z1 for 8,000 steps (a2): held-out character error 0.0781 to 0.0736, contract quantities 0.970 to 0.983, description error unchanged. Without the short-cell shards (a1) quantities fell to 0.928, because the new lines are all five characters or longer.

On the 275 labelled table pages a2 is neutral: page pass 0.674 to 0.667, document pass 0.587 to 0.581, mean F1 0.881 to 0.882. Better line reading does not move the pass rate; what keeps pages under 0.9 is text that is never cut out (38 of the 92 failing pages lose over a third of their recall while precision stays high), reference layers with look-alike glyphs, and reading order. a2 was not shipped.

`ab_all_report.py` now folds the look-alike glyphs some fonts put in the layer (ƣ for ư, φ for the diameter sign, superscript 2 and 3): page pass 0.667 to 0.674.

## Page-level faults on the table pages (2026-10-26 to 10-28)

What kept the 275 labelled table pages under 0.9 was mostly not the recogniser but where the page was cut, which text was dropped and which grids were trusted. Page pass 0.674 to 0.807, document pass 0.587 to 0.723, mean F1 0.88 to 0.938; contract unchanged at 473/473 with numbers 1.000. The odd (test) half rose at least as much as the even half (page pass 0.594 to 0.752 against 0.674 to 0.785 on an earlier warm baseline), and every fix is a rule, not a per-document case.

Fixed: headers and footers cut by the real page height, not the lowest word; lone dash and ditto marks kept below the confidence cutoff; small print in tall cells (pitch from a shorter lag, narrower word gaps, minimum ink run 6 to 4); blocks of many short lines split; heading bands split at the blank row between touching accents; a frame across the page counts as a table when it carries a table over; a grid whose column edges are not drawn is a drawing (0.34 to 0.89 on an engineering page); the text below a grid (notes, next heading, a second table) read as rows, with lines under 2 characters or 0.8 confidence dropped as stamp strokes; a page read as text unless the grid finder accepted its grid (the older border detector's boxes swallowed an unruled customs list, 0.48 to 0.99); a picture at least twice as long as wide is limited by its short side, not its long side (0 to 0.91); a sheet wider than 1.5 times its height is scaled by 1.5 times the height, so its cell insets are not five times too wide (0.34 to 0.98).

Wide check against the live code, 1,140 pages sampled from every born-digital document: 434 better, 44 worse. 15 of the worse are prose or journal pages now left out as not a table; the rest lose a few points on letters whose letterhead is trimmed. Pages with prose or a letterhead score lower on the text-layer yardstick by design.

Tried and dropped: a two-row minimum for a frame (it dropped a real carried-over page); reading above the grid on later pages (no page changed); a syllable dictionary built from the crawl's text layers to fix diacritics (36 pages up, 44 down, mean unchanged: the misreads are valid syllables or letter confusions, not tone marks on invalid ones).

Still failing, about 53 pages: near misses at 0.84 to 0.89 where about 12% of the words are misread (common syllables such as công, hành, cấp, sở), corrupt reference layers (price-hcm t2 p13, t4 p11), Cyrillic and `Þ` outside the vocabulary, prose between two tables on one page, dot leaders, and dense bilingual tables with only header rules (port-spct p1).

## Tall cells, footers and other recognisers (2026-10-29 to 10-30)

On the 275 labelled table pages: page pass 0.807 to 0.819, document pass 0.723 to 0.735, mean F1 0.938 to 0.939 from raising the footer limit (`GRID_FOOT_LIMIT` 0.92 to 0.97: 6 pages better, 0 worse), then mean F1 0.933 to 0.935 from a page-wide line pitch (11 pages better, 0 worse, none crossing 0.9; dot54-dieuchinh p1 0.796 to 0.885). The pitch is the median of confident multi-line cell bands (at least 3 samples); a tall cell whose own pitch is missing or 20% off uses it, only if every cut lands in a gap. Contract unchanged at 473/473 numbers 1.000. Description exact moved 0.558 to 0.552 before the footer change was applied; cause not traced.

Tried and dropped: image side limit 2400 to 3600 px (gained 4 pages, lost 2, one fell under 0.9); valley threshold 0.85 for the pitch cut (no change). Scoring against a body-only reference flips 1 page, so the 5% top and bottom filter is not what holds pages back.

Other recognisers, offline on the failing pages:
- PP-OCRv6 small: its dictionary lacks most tone-stacked Vietnamese letters (ả ạ ắ ế ộ ỏ ụ), so "Phụ lục số 06" reads "Ph lc só 06". Unusable.
- SLANeXt (368 MB, 512x512 input) parses a tight crop of a simple table but fails on dense ones (dot54 p1 9x12 grid read as 5x6; port-spct p1 as 4 rows). Rejected.
- Not tried: SenOCR-Vi (about 1B, Vietnamese fine-tune of PaddleOCR-VL) as a labeller or teacher; SVTRv2/OpenOCR as a CTC-only retrain recipe; GLM-OCR (635 MB at q4f16, too big for the page).

Still failing, about 50 pages: small-print misreads (lỏng to lòng, chỉ to chi, nắn to năn), dense unruled tables, corrupt reference layers (price-hcm t2 p13, t4 p11), Cyrillic and `Þ`, bsr p18. These need recogniser work, not grid rules. The 212 scanned documents are not measured yet.

VieSVTR v7 (MLCV lab, UIT; 7.7M parameters, 30.7 MB, CTC, 64 px line height, the same 229 characters as ours; CC BY-NC 4.0), tried 2026-11-23. On the 6,001 held-out lines it reads at character error 0.0633, against 0.0736 for the best fine-tune (a2) and 0.0781 for the shipped model. Put into the engine in place of the shipped read (lab only, run through the app on the 271 scoreable table pages, 2 lanes) it did not help: mean page F1 0.935 to 0.935, 67 pages better and 71 worse, page pass 218 to 212 (3 crossed 0.9 upward, 9 downward). Better line reading again did not move the page pass rate (see a2 above); I did not look into why pages got worse, so the cause is unknown. Not shipped, and the lab code was reverted. Its licence also bars commercial reuse.

Unruled pages, three fixes (2026-11-24), each measured on the 272 scored table pages against the run before it:
- Wrapped lines (`isWrappedLine`): the second and later lines of a description on a page with no drawn grid were dropped as stray marks; now kept and joined to the text above. 4 pages better, 0 worse.
- Lone dash and ditto marks (`docs/boq-marks.js`): the detector never boxes a "-" or a quote mark, which cost statistics tables a third of their cells. Small ink blobs outside every box and on the line of one go to the recogniser, which keeps only what it reads as a mark; close runs on one line are dotted leaders and are dropped (the first version read the leaders of `port-haian-2022` p6 as rows of dashes, 0.873 to 0.788). 8 better, 0 worse.
- A ditto mark inside a detected box is read as "11" or "II"; two such strokes at under 0.7 of the median line height are now `"`. 3 better, 0 worse.
Pages at 0.9 or higher, 215 to 219 of 272; mean F1 0.9298 to 0.9309; contract still 473 of 473, description-exact 0.552 to 0.558.

Second pass over the 53 pages still under 0.9 (missing tokens against the text layer): 1849 words and 914 numbers are recogniser misreads in small print, 4 pages are corrupt layers or junk (0.24 to 0.41), `*` (about 140) is the layer's glyph for a bullet the picture shows as a dash, and the rest is a list of one-off causes (a gazette contents page set as two text columns, a Cyrillic subject list, quote-led lines the detector skips). No remaining class that a rule in the extractor would fix.

Two tests from the conventional-OCR literature (2026-11-25), both on the pages still failing, neither kept:
- Small print from a finer render (lines under 34 px read from a render 1.5 times finer; the lab fed each page as a 300 dpi picture inside a one-page PDF, as a scanner makes it). 74 pages of the 41 documents with a failing page: 0 better, 1 worse. The recogniser takes a line at 32 px, and few lines are under that.
- Re-reading unsure lines (confidence under 0.9) with the box 3 px taller and 3 px shorter. Keeping the most confident reading: 17 pages better, 8 worse, pass unchanged. Keeping the reading two of the three agree on: 14 better, 3 worse, mean F1 0.9309 to 0.9318, 219 to 220 pages at 0.9. About a quarter of the lines on a dense page are unsure, so it adds about half again to the recognition time for one page. Not worth it for a free in-browser tool; the code is in the git history of this note's session only (not committed).
Not tried: a Vietnamese word list or n-gram rescoring of the recogniser's candidates (the survey's lighter family), and a small table-structure model for borderless pages.
