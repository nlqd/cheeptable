// Unit tests for docs/boq-pages.js.  Run: node test-pages.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { tablePages, shareTextInsideCells } = createRequire(import.meta.url)('./docs/boq-pages.js');
const { gridCellsToWordGrid, inPageBody, imageScale, mergeMultiLineCells, isWrappedLine } = createRequire(import.meta.url)('./docs/boq-extract.js');
const row = (page, ...cells) => ({ page, cells: cells.map(value => ({ value })) });
const tests = {
  'a photo comes down to a long side of 2400'() {
    assert.equal(imageScale(4000, 3000), 0.6);
  },
  'a picture already small enough is not scaled'() {
    assert.equal(imageScale(1200, 1600), 1);
  },
  'a very tall sheet keeps its width, the pixel cap holds'() {
    assert.equal(imageScale(2187, 10481), 1);
    assert.ok(imageScale(2400, 20000) < 0.8);
  },
  'a wrapped line in a text column joins the text above it'() {
    const data = (...cells) => ({ type: 'data', page: 1, cells: cells.map(value => ({ value })) });
    const rows = [data('', '3.', 'TCVN 13950', '', 'Sơn và vecni - Xác định'), data('', '', '', '', 'barium - Phương pháp'), data('', '', '', '', 'tử ngọn lửa.')];
    const [merged] = mergeMultiLineCells(rows, 5);
    assert.equal(merged.cells[4].value, 'Sơn và vecni - Xác định barium - Phương pháp tử ngọn lửa.');
  },
  'a wrapped line goes to the row that holds text in its column, not to a line of codes between'() {
    const data = (...cells) => ({ type: 'data', page: 1, cells: cells.map(value => ({ value })) });
    const rows = [data('', '3.', 'TCVN 13950', '', 'Sơn và vecni'), data('', '', 'ISO 3856', '', ''), data('', '', '', '', 'barium')];
    const merged = mergeMultiLineCells(rows, 5);
    assert.equal(merged[0].cells[4].value, 'Sơn và vecni barium');
  },
  'a line under a line with the same left edge is a wrapped line'() {
    const line = (y, x, text) => ({ page: 1, y, y1: y + 40, text, words: [{ x, text }] });
    assert.ok(isWrappedLine(line(285, 819, 'barium - Phương pháp'), [line(242, 818, 'Sơn và vecni')]));
  },
  'a stamp mark far from any line above is not a wrapped line'() {
    const line = (y, x, text) => ({ page: 1, y, y1: y + 40, text, words: [{ x, text }] });
    assert.ok(!isWrappedLine(line(900, 700, 'ĐÃ NHẬN'), [line(242, 818, 'Sơn và vecni')]));
  },
  'a wrapped line under a number cell does not change the number'() {
    const data = (...cells) => ({ type: 'data', page: 1, cells: cells.map(value => ({ value })) });
    const [merged] = mergeMultiLineCells([data('1', 'Cát', 'm3', '400.000'), data('', 'vàng', '', '')], 4);
    assert.equal(merged.cells[3].value, '400.000');
  },
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
  'the lines of cells merged across rows stay in one row, however many they are'() {
    const cells = [0, 1, 2].map(col => ({ row: 0, col, x: col * 100, y: 0, width: 90, height: 200, rowspan: 4 }));
    const words = [0, 1, 2].flatMap(col => [0, 1, 2, 3, 4, 5].map(i => ({ text: `c${col}l${i}`, x: col * 100, y: i * 40, x1: col * 100 + 50, y1: i * 40 + 12, confidence: 90, cell: { row: 0, col, tall: true } })));
    const { grid, numRows } = gridCellsToWordGrid(words, cells);
    assert.equal(numRows, 1);
    assert.equal(grid[0][1].text, 'c1l0 c1l1 c1l2 c1l3 c1l4 c1l5');
  },
  'a row of several columns each holding a stack of lines is several table rows, and is cut by the position of its lines'() {
    const cells = [0, 1, 2].map(col => ({ row: 0, col, x: col * 100, y: 0, width: 90, height: 300 }));
    const words = [0, 1, 2].flatMap(col => [0, 1, 2, 3, 4, 5].map(i => ({ text: `c${col}l${i}`, x: col * 100, y: i * 40, x1: col * 100 + 50, y1: i * 40 + 12, confidence: 90, cell: { row: 0, col } })));
    assert.equal(gridCellsToWordGrid(words, cells).numRows, 6);
  },
  'a wrapped record of three or four lines per cell is one row, not a stack'() {
    const cells = [0, 1, 2].map(col => ({ row: 0, col, x: col * 100, y: 0, width: 90, height: 200 }));
    const words = [0, 1, 2].flatMap(col => [0, 1, 2, 3].map(i => ({ text: `c${col}l${i}`, x: col * 100, y: i * 40, x1: col * 100 + 50, y1: i * 40 + 12, confidence: 90, cell: { row: 0, col } })));
    assert.equal(gridCellsToWordGrid(words, cells).numRows, 1);
  },
  'text-layer coverage ignores the heading and a note, and counts a missed column'() {
    const cells = [{ row: -1, x: 0, y: 0, width: 50, height: 10 },    // the heading cell above the table
                   { row: 0, x: 0, y: 10, width: 100, height: 80 }];
    const it = (x, y) => ({ x, y, width: 10, height: 8 });     // y is the baseline
    // a heading word past the heading cell, the title, inside, a missed column, a note
    const items = [it(200, 5), it(5, -5), it(5, 20), it(200, 20), it(5, 200)];
    assert.equal(shareTextInsideCells(items, cells), 0.5);
    assert.equal(shareTextInsideCells([], cells), 1);
    assert.equal(shareTextInsideCells([it(5, 20)], []), 1);    // no grid cells: nothing to measure
  },
  'the last row of a page whose text ends above the foot is kept'() {
    assert.ok(inPageBody(1200, 1240, 1400));
    assert.ok(!inPageBody(1350, 1395, 1400));    // a footer in the real last 5%
    assert.ok(!inPageBody(10, 40, 1400));        // a running header
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n    ', e.message); }
}
console.log(failed ? `${failed} failed` : `all ${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
