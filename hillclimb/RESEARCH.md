# Continuing the climb: generic Vietnamese document OCR in the browser (2026-10-16)

What we know, what we measured this round, what the literature says, and a ranked measurement programme.
Facts from our own runs are marked **measured**. Findings from the web are marked **reported** and carry a source; where three
research agents found nothing, this file says "not found" and does not fill the gap.

## 1. Where we stand (measured)

One real document (11-page bill of quantities, 473 rows) plus one synthetic document. Full contract, whole app, hosted models:

| path | time | rows found | all three numbers right | description error (CER) |
|---|---|---|---|---|
| WebGPU encoder | 60 s | 472/473 | 0.966 | 0.029 |
| CPU (int8 encoder, workers) | 106 s | 472/473 | 0.960 | 0.031 |

Everything above is one document. Claims about "generic" documents are not supported until section 5 step 1 exists.

## 2. What breaks first on other documents (measured)

Degradation sweep (`robust_sweep.py`): the two real pages 3-4 (95 rows), degraded after rendering, read by the grid pipeline
(prototype without the number repair, so numbers are the raw read). Baseline: 95/95 rows, numbers 1.000, CER 0.034.

| degradation | rows found | numbers right | CER |
|---|---|---|---|
| rotation 0.5 deg (also 1, 2, 3 deg) | **0/95** | 0 | 1.00 |
| blur sigma 1 | 95 | 0.937 | 0.030 |
| blur sigma 2 | **3/95** | 0 | 1.00 |
| resolution x0.75 | 95 | 0.937 | 0.024 |
| resolution x0.5 | 85 | 0.432 | 0.327 |
| resolution x0.35 | 26 | 0 | 1.11 |
| JPEG q50 | 95 | 0.863 | 0.027 |
| JPEG q15 | 91 | 0.695 | 0.094 |
| contrast x0.5 | 95 | 0.800 | 0.023 |
| contrast x0.3 | **0/95** | 0 | 1.00 |
| shadow gradient | 95 | 1.000 | 0.025 |
| noise sigma 15 | 95 | 0.832 | 0.025 |
| noise sigma 30 | 95 | 0.863 | 0.055 |

Readings:
- **Skew is the cliff.** Half a degree removes the grid completely (the line detector needs perfectly horizontal and vertical lines). Real scans are routinely skewed by 0.5-2 deg.
- **Contrast and blur collapse the grid** the same way (fixed adaptive-threshold constants).
- **Digits are the fragile part**, not letters: mild noise, JPEG, blur or contrast loss cost 6-20 points of number accuracy while description CER barely moves. The app's arithmetic repair (not in this sweep) recovers part of it.
- Text CER is robust to everything except resolution below about x0.5 and heavy noise.

## 3. Where the remaining errors are (measured, contract, GPU path)

Description error 0.029 = 525 error characters in 17,875 reference characters.

| class | share of error | examples |
|---|---|---|
| digits and the diameter sign spill-over | 41% | `Þ27 -> 227`, `Þ150 -> 2150`, `1x2 -> lx2`, `5cm -> Scm` |
| diameter sign Þ itself | 25% | `Þ -> P`, `2`, `b` |
| tone or diacritic only | 18% | `ổ -> ồ`, `ặ -> ậ`, `ỡ -> õ` |
| symbols | 14% | `" -> ?`, `>= -> -?`, `= -> ?` |
| missing or extra characters | 3% | |

- The recogniser's vocabulary has 229 characters. **Þ is the only reference character outside it** (130 chars, 0.73% of reference characters), yet words containing it hold **28%** of all error. The other 72% is confusion between in-vocabulary characters. Fixing Þ alone would take CER from about 0.029 to about 0.021.
- Row numbers: the earlier "structural" errors were misread row numbers (7 read as 1), now repaired by the count-up rule.
- Two independent encoders (int8 CPU, fp32 GPU) disagree on 24% of rows; those rows contain 41% of all rows with an error. So disagreement is a usable but incomplete uncertainty signal: it cannot see errors both paths share (Þ is the big one).

## 4. What the literature says (reported; three research agents, about 70 searches)

Recognition
- No public benchmark compares VietOCR, PaddleOCR and docTR on the same Vietnamese data (not found). VietOCR reports 0.880 full-line accuracy for vgg_transformer on the author's mostly synthetic 10M-image set (github.com/pbcquoc/vietocr).
- **PP-OCRv5 latin recogniser cannot be used as-is**: its dictionary lacks 90 of the 146 Vietnamese letters (ạ ậ ổ ồ ỏ ợ ự ữ ệ ...). It would need fine-tuning with an extended dictionary.
- Vision-language OCR models (MDPBench Vietnamese scores, arXiv 2603.28130): olmOCR2 84.0, dots.ocr 79.1, PaddleOCR-VL-1.5 78.9, Qwen3-VL-8B 73.4, GLM-OCR 69.2. Only GLM-OCR has a browser build (q4f16, about 635 MB) and it is the weakest of these; nothing here fits the download budget. Not an option for the browser; possible later as an optional server mode.
- Gains reported for Vietnamese are for handwriting only: syllable-trigram rescoring 1.02% CER on VNOnDB; hybrid candidate scoring 0.5 CER points. Evidence for printed text: not found.
- Evidence that synthetic Vietnamese pre-training transfers to real scans: not found. Validate on real held-out documents only.
- Datasets: **MDPBench** (3,400 images, 17 languages, Apache-2.0 on its card) holds Vietnamese photographed and digital pages and is the best public held-out candidate. VinText (2,000 scene-text images, research only). No open printed-scan, legal or form set with line transcriptions was found.

Tables and layout
- Models with ONNX and a plausible browser path: SLANet_plus 6.9 MB (RapidAI/RapidTable export; no public TEDS), DocLayout-YOLO 75 MB, PP-LCNet document-orientation classifier 7 MB, UVDoc dewarping about 31 MB. Too large: SLANeXt 351 MB, PP-DocLayout about 124 MB. TableFormer, UniTable, TATR: no ONNX or browser path confirmed.
- Only models trained on WTW (LORE, TSRFormer, SEMv2) are shown to cover bordered, borderless and distorted tables; no weights or sizes were found for a browser. Separator-based methods are skew-sensitive.
- No Vietnamese table-structure dataset was found (MC-OCR and UIT-MLReceipts are receipts with field labels).

Evaluation and engineering
- Normalise reference and hypothesis to NFC and strip zero-width characters before scoring. Report a diacritic-only error rate (strip tone and vowel marks from both, compare the two CERs).
- Resample whole documents or pages (cluster bootstrap), not lines, and use paired comparisons (Kaldi `compute-wer-bootci`, Bisani and Ney 2004). A sample size for detecting a 1-point CER change: not found. Inference: with one document it is not detectable at document level; plan for 30 or more.
- ORT-web: int8 on WebGPU was measured at about 1.6 s against 140-188 ms for fp16/fp32 on one Apple M3 (missing integer kernels), which matches our split (int8 on WASM, fp32-compute on WebGPU). `shader-f16` support is about 99% on Chromium OS but 0% on Qualcomm Adreno 6xx; our GPU encoder does not need it. Firefox 141 (Windows) and Safari 26 reportedly ship WebGPU; Android details conflict.
- Cheap production gains with some evidence: test-time augmentation by padding or blur (one paper, +4 points on a multimodal model), ROVER-style voting over several reads (one paper, 44% CER cut on Maltese with 5 fine-tuned streams). Re-reading only low-confidence cells and Vietnamese syllable lexicons: not found (a lexicon is cheap: about 6-7k valid syllables).

## 5. Measurement programme, ranked by expected gain per effort

Each step names the hypothesis and the number that decides it.

1. **Build the benchmark before climbing further.** At least 30 documents across the axes that matter (ruled / partly ruled / borderless; clean scan / phone photo / low-resolution fax; forms, invoices, legal text, bills of quantities; stamps over text). Sources: MDPBench Vietnamese subset, your own scans, and the existing pages degraded by known amounts (known ground truth for free). Metrics: line CER on NFC text, diacritic-only CER, digit error rate, row F1 and an invariant pass rate (quantity x price = total, row numbers count up: free labels), latency and memory per page. Report cluster-bootstrap 95% intervals per document. Decision rule: a change ships only if the paired improvement interval excludes zero.
2. **Deskew and orientation.** Hypothesis: rows found returns to the baseline for rotations up to 3 deg. Method: estimate skew from the ruling lines (Hough or projection-profile search over about -5..+5 deg, OpenCV.js, no download), rotate, then re-run the rotation sweep; add the 7 MB orientation classifier only if 90/180 deg pages appear. Metric: rows found and CER versus angle. Cost: about half a day.
3. **Contrast and blur normalisation before grid detection.** Hypothesis: the contrast x0.3 and blur sigma 2 collapses disappear when the adaptive threshold is set from image statistics (or CLAHE is applied first). Metric: the same sweep. Cost: half a day.
4. **Digit robustness.** Hypothesis: most of the 6-20 point number loss under mild degradation is recoverable by re-reading only low-confidence numeric cells with shifted/padded crops and voting, and by the arithmetic repair. Measure first: digit confusion matrix, calibration (error rate by confidence decile, AUROC), and what share of lost rows the repair already recovers under each degradation. Cost: 1-2 days.
5. **Borderless tables, measured on a benchmark we can make today.** Erase the ruling lines from our own pages (ground truth unchanged) to get borderless twins of every test page. Compare, on rows found and cell exactness: (a) whitespace-valley column and row separators from the projection code we already have, accepted or rejected by the invariants; (b) SLANet_plus (6.9 MB ONNX) as a structure proposer filtered by the same invariants. Only add a model if (a) loses clearly. Cost: 2-4 days.
6. **Glyph coverage and fine-tuning of the recogniser.** Facts: Þ is the only out-of-vocabulary character and carries 28% of error; tone marks carry 18%. Options in order of cost: (a) a switchable output mapping for the diameter sign (cheap, document-specific, needs your decision); (b) fine-tune VietOCR with an extended vocabulary on synthetic lines (TextRecognitionDataGenerator or SynthTIGER, fonts that contain Þ, plus augmentation matching section 2) mixed with real crops; a 16 GB local GPU is enough. Hypothesis: CER 0.029 -> 0.02 or lower on a real held-out set. Risk: no published Vietnamese synthetic-to-real transfer evidence, so the held-out real set from step 1 is what decides. Cost: 3-5 days.
7. **Syllable-lexicon rescoring.** Measure the ceiling first: what share of tone-mark errors produce a string that is not a valid Vietnamese syllable (needs a syllable list, cheap). If under half, skip. If over half, rescore beam candidates against the lexicon. Evidence is handwriting only. Cost: 1 day to measure, 1-2 days to build.
8. **Device and browser matrix.** Measure latency, memory and correctness on Safari 26, Firefox 141+, an Android phone and a machine without WebGPU. Hypothesis: the fp32-compute GPU encoder works wherever an adapter exists and the CPU path covers the rest. Check per-op profile with `ort.env.webgpu.profiling`. Cost: 1 day.
9. **Layout analysis for multi-column pages** (DocLayout-YOLO, 75 MB). Lowest priority: it pushes the download over budget and no ruled-table failure comes from it. Revisit when benchmark documents show multi-column text.
10. **Encoder-disagreement as an uncertainty signal** (section 3: flags 24% of rows holding 41% of the erroneous rows). Cheap to use in the review UI to highlight rows to check; useless for shared errors. Only worth shipping if it speeds up human review (measure review time).

Not recommended: any vision-language model in the browser (none fits, and the one that does scores below the current recogniser on Vietnamese); more workers or more quantisation for speed (the run is already 1-2 minutes).

## 6. Decisions that need the owner
- Þ mapping option: on by default, off by default, or skipped in favour of fine-tuning (step 6).
- Which real documents can go into the benchmark (step 1 depends on your supplier documents, including any with skew, photos or no ruling lines).
- Whether review-time (step 10) or accuracy is the target metric for the next stage.

## Sources (reported findings)
VietOCR https://github.com/pbcquoc/vietocr | PP-OCRv5 latin dictionary https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/dict/ppocrv5_latin_dict.txt | MDPBench https://arxiv.org/html/2603.28130v1 and https://huggingface.co/datasets/Delores-Lin/MDPBench | Vietnamese OCR survey https://arxiv.org/html/2506.05061 | VNOnDB rescoring https://arxiv.org/pdf/2512.05021 | SLANet / table models https://www.paddleocr.ai/main/en/version3.x/module_usage/table_structure_recognition.html | DocLayout-YOLO ONNX https://huggingface.co/podongchip/DocLayout-YOLO-DocStructBench-ONNX | orientation https://huggingface.co/PaddlePaddle/PP-LCNet_x1_0_doc_ori | UVDoc https://arxiv.org/pdf/2302.02887 | ORT WebGPU https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html | int8 on WebGPU report https://huggingface.co/LunarOilRig/comic-text-onnx-fp16 | shader-f16 coverage https://web3dsurvey.com/webgpu/features/shader-f16/platform/Chromium%20OS | WER bootstrap https://www.kaldi-asr.org/doc/compute-wer-bootci_8cc.html | Augraphy https://arxiv.org/abs/2208.14558 | test-time augmentation https://ar5iv.labs.arxiv.org/html/2509.09722
