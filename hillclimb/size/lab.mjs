// Run the table extractor on captured OCR output.   node lab.mjs [OUTDIR] [EXTRACTOR.js]   (from hillclimb/size)
// Reads lab/*.json (see capture.py), writes OUTDIR/<name>.json with the rows ocrTableExtract returns.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const outDir = process.argv[2] || 'lab_out';
const file = process.argv[3] || '../../docs/boq-extract.js';
fs.mkdirSync(outDir, { recursive: true });
const ctx = vm.createContext({
  console: { log() {}, warn() {}, error: console.error, debug() {} }, performance, Math, JSON, Promise, Set, Map, Array, Object, String, Number, RegExp, Date,
  LINE_TOLERANCE: 3, MIN_LINE_LEN: 10, CELL_PAD: 1.5, OCR_SCALE: 200 / 72, CELL_MATCH_MARGIN_PX: 30, ORPHAN_NEAREST_CELL_PX: 100, ROW_Y_THRESHOLD_PX: 10,
  log() {}, window: {}, yieldToMain: async () => {},
});
vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
const run = vm.runInContext('(async (l, w, c) => ocrTableExtract(l, w, c))', ctx);
for (const f of fs.readdirSync(process.env.LAB || 'lab').filter(f => f.endsWith('.json'))) {
  const d = JSON.parse(fs.readFileSync(path.join(process.env.LAB || 'lab', f), 'utf8'));
  if (!d.capture) continue;
  let rows;
  try { rows = await run(d.capture.lines, d.capture.words, d.capture.cells); } catch (e) { rows = []; console.error(f, e.message); }
  fs.writeFileSync(path.join(outDir, f), JSON.stringify(rows));
}
