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

## Not done, not known

- No real phone, Safari or Firefox; externalData is only exercised in Chrome. Memory per worker was not measured (estimated 70 to 80 MB against about 250 MB before).
- A model trained on teacher labels inherits the teacher's mistakes; unseen fonts and handwriting are untested. Contract numbers are the held-out result; benchmark lines share documents with the training pages.
- Steps could be coded in 8 bits and the two sinusoid tables (0.4 MB) regenerated in the page: about 0.5 MB more.
- Int2 attention (`x5`) was tried last; see the run log.

## Reproduce

`make_data.py` (eval set), `make_train.py`, `make_cells.py`, `label.py` (training data), `kd.py NAME --plan plans/j.json --ffn 1024 --steps 8000 --lam 0.02` (train), `release.sh NAME plans/j.json --ffn 1024` (export, int8 encoder, wire package, check), `onnx_eval.py DIR` (score a package; `ENC=encq` for the int8 encoder). Environments: `venv_train` (torch cu128), `venv_onnx_export` (exports). Training data, checkpoints and packages are not committed.
