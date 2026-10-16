# UX hill-climb (2026-10-17)

Same method as the OCR work: a baseline first, a number for every change, and extraction output checked against the previous run
after every change so the interface cannot quietly damage the result.

Tools (all in `hillclimb/ux/`, run against a local gzip server `serve.py` so transfer sizes match GitHub Pages):
`metrics.py` startup + accessibility + how live the progress is; `e2e.py` one job with an event timeline and screenshots;
`functional.py` 14 behaviour checks; `axe_modes.py` axe-core on every layout, both languages and dark colours.

## Startup and liveness (3-page scanned job, headless Chrome)
| metric | baseline (old page) | now |
|---|---|---|
| render-blocking scripts | 21 | 0 |
| requests before the load event | 25 | 3 |
| bytes before the load event | 4.04 MB | 0.01 MB |
| first / largest contentful paint | 144 ms | 20 ms |
| load event | 678 ms | 7 ms |
| visible progress changes in a ~30 s job | 8 (0.3 per second) | 841 (29 per second) |
| quarter-second windows with a visible change | 3% | 99% |
| longest silence | 11.7 s | 0.65 s |
| time from choosing a file to the first cell read (warm) | not measured | 1.4 s |
| axe violations, empty page / result page | 0 / 4 (2 critical) | 0 / 0 in every layout and language |

Cold first visit (model cache cleared, local network): models downloaded in 2.4 s with 921 byte-progress events, longest UI gap 446 ms, first cell read at 4.2 s.

## What changed, and why each step
- **One script at startup.** `app.js` (17 KB) wires the drop zone and preferences. The OCR engine, progress UI, results table and side-by-side view load on demand: the engine on pointer-over, focus or touch of the drop zone (or at file choice), OpenCV and the models only when a job starts, Excel code when results appear.
- **Crawlable page.** `lang="vi"`, Vietnamese headings and FAQ in static HTML, JSON-LD (`WebApplication`, `FAQPage`), noscript note, skip link. English is a switch, not a second page.
- **Live progress.** The engine reports events (model bytes, page rendered, grid found, each cell read); the UI batches drawing to animation frames and shows model download in MB with rate and time left, a thumbnail per page that fills in as cells are read, a transcript of recent reads, elapsed time, and an ETA from throughput over the last 8 s. The bar has a compositor-driven shimmer for steps that block the page thread.
- **Three layouts as a stored preference** (default guided): simple, guided (four steps, flagged-only review on), side by side (source page beside the table, click either way). Layout, language and zoom are remembered in `localStorage` (failures are ignored).
- **Review flags from data.** On the 473-row contract, VietOCR confidence is bunched between 88 and 94, so one cutoff means different things for text and numbers. Rules: description under 90 (95% really wrong), number under 80 (67%), or quantity x price != total (9 of 9 flagged rows really wrong). A description between 90 and 92 is only a light "maybe" and is not counted as work.
- **Native table**, not Tabulator (about 400 KB less, and its table roles were the two critical axe findings). Keyboard: arrows, Enter edits or confirms, `]` and `[` jump between cells to check.
- **Headers:** repeated header rows and the (1)(2)(3) column-number row are dropped; recognised header cells get clean names even when misread.
- **Errors without `alert()`:** wrong file type, too large, cancelled, failed, and "no table found" (download disabled). PDF extensions in any case, and JPG/PNG/WebP images, are accepted.
- **Grid detection at the size it was tuned for** (about 1,200 px wide, not the 1,654 px render): 1.9x fewer pixels and a measurably better result on the full contract: 473 rows found (was 472), numbers 0.968 (was 0.964), description error 0.022 (was 0.030). The worker pool also starts while page one is rendered.

## Regression checks after the changes
Extraction on the 11-page contract was byte-identical to the previous run before the grid-resolution change (571 rows). After it: CPU 96 s, 473/473 rows found, numbers 0.968, description error 0.022; GPU 56 s, the same scores.

## Not measured
Safari and Firefox, real phones, screen-reader speech, a cancel that lands exactly mid-page, ETA accuracy against actual time, and whether visitors prefer the default layout.
