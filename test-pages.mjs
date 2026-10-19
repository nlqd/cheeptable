// Unit tests for docs/boq-pages.js.  Run: node test-pages.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { tablePages, shareInsideCells } = createRequire(import.meta.url)('./docs/boq-pages.js');
const row = (page, ...cells) => ({ page, cells: cells.map(value => ({ value })) });
const tests = {
  'a page of rows with several cells is a table'() {
    const rows = [1, 2, 3, 4].map(n => row(1, String(n), 'Cát', 'm3', '400.000'));
    assert.deepEqual([...tablePages(rows)], [1]);
  },
  'a page of one cell per line is prose and is left out'() {
    const rows = ['Điều 1.', 'Công bố', 'Điều 2.', 'Quyết định này'].map(t => row(1, t, ''));
    assert.deepEqual([...tablePages(rows)], []);
  },
  'two rows with several cells are too few unless a drawn grid was read'() {
    const rows = [row(7, '1', 'Tổng', '5'), row(7, '2', 'Cộng', '9')];
    assert.deepEqual([...tablePages(rows)], []);
    assert.deepEqual([...tablePages(rows, new Set([7]))], [7]);
  },
  'a drawn grid does not keep a page that came out as one cell per line'() {
    const rows = ['Điều 1.', 'Công bố'].map(t => row(3, t, ''));
    assert.deepEqual([...tablePages(rows, new Set([3]))], []);
  },
  'the share of words whose centre lies inside some cell'() {
    const cells = [{ x: 0, y: 0, width: 100, height: 20 }, { x: 0, y: 20, width: 100, height: 20 }];
    const w = (x, y) => ({ x, y, x1: x + 10, y1: y + 6 });
    assert.equal(shareInsideCells([w(5, 5), w(5, 25)], cells), 1);
    assert.equal(shareInsideCells([w(5, 5), w(5, 300), w(5, 400), w(5, 500)], cells), 0.25);   // a header's cells, the body below them uncovered
    assert.equal(shareInsideCells([], cells), 1);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n    ', e.message); }
}
console.log(failed ? `${failed} failed` : `all ${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
