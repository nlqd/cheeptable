// Unit tests for the pure helpers in docs/boq-grid.js.  Run: node test-grid.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { gridClusters, gridTextBands, gridCells } = createRequire(import.meta.url)('./docs/boq-grid.js');

const tests = {
  'a thick ruled line collapses to one position'() {
    assert.deepEqual(gridClusters([100, 101, 102, 103], 4), [102]);
  },
  'separate lines stay separate'() {
    assert.deepEqual(gridClusters([100, 101, 200, 202, 204], 4), [101, 202]);
  },
  'unsorted input is handled'() {
    assert.deepEqual(gridClusters([204, 100, 202, 101], 4), [101, 203]);
  },
  'no positions, no lines'() {
    assert.deepEqual(gridClusters([], 4), []);
  },
  'two text lines in one cell give two bands'() {
    const ink = [0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0].map(Boolean);
    assert.deepEqual(gridTextBands(ink, 3, 6), [[1, 8], [12, 19]]);
  },
  'a gap shorter than the minimum keeps one line (accent above its letters)'() {
    const ink = [1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1].map(Boolean);
    assert.deepEqual(gridTextBands(ink, 3, 6), [[0, 11]]);
  },
  'a speck is not a text line'() {
    const ink = [0, 0, 1, 1, 0, 0, 0, 0, 0, 0].map(Boolean);
    assert.deepEqual(gridTextBands(ink, 3, 6), []);
  },
  'a line that runs to the cell edge is kept'() {
    const ink = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1].map(Boolean);
    assert.deepEqual(gridTextBands(ink, 3, 6), [[2, 10]]);
  },
  'cells are inset from the ruled lines and thin cells are dropped'() {
    const cells = gridCells([0, 100, 104], [0, 50, 60], 1);
    assert.deepEqual(cells.map(c => [c.row, c.col, c.x, c.y, c.width, c.height]), [[0, 0, 3, 3, 95, 45]]);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message.split('\n')[0]); }
}
console.log(failed ? failed + ' failed' : 'all ' + Object.keys(tests).length + ' passed');
process.exit(failed ? 1 : 0);
