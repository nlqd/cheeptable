// Unit tests for the pure helpers in docs/boq-grid.js.  Run: node test-grid.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { gridClusters, gridTextBands, gridJointCount, gridRulesBelow, gridIsSideways, gridLineHeight, gridDespeckle, gridSplitWide, gridInkRuns, gridSplitTall, gridLinePitch, gridUnderSegmented, gridCells, gridPickColumns, gridIsRuleFragment } = createRequire(import.meta.url)('./docs/boq-grid.js');

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
  'two lines that touch are cut where the ink is thinnest'() {
    const counts = [0, 9, 9, 9, 9, 9, 9, 2, 9, 9, 9, 9, 9, 9, 0];            // one band, a faint valley at row 7
    assert.deepEqual(gridSplitTall([[1, 14]], counts, 7), [[1, 7], [7, 14]]);
  },
  'a tall band with no valley is one tall line, not two, whatever the line height estimate says'() {
    assert.deepEqual(gridSplitTall([[1, 14]], [0, ...new Array(13).fill(9), 0], 7), [[1, 14]]);
  },
  'lines repeat at a steady pitch, one tall line does not'() {
    const line = [1, 8, 9, 9, 8, 3, 1, 0, 0, 0, 0, 0];                       // 12 rows: a line of text and the gap under it
    const three = [...line, ...line, ...line];
    assert.equal(gridLinePitch(three, 0, 36, 6), 12);
    assert.equal(gridLinePitch([...line, ...line.slice(0, 7)], 0, 19, 6), 12);   // two lines, the second without its gap
    assert.equal(gridLinePitch(new Array(36).fill(9), 0, 36, 6), 0);           // a solid block has no repeat
    assert.equal(gridLinePitch([2, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 2, 0], 0, 14, 6), 0);   // one tall line
  },
  'a band of one line height is left alone'() {
    assert.deepEqual(gridSplitTall([[1, 9]], new Array(10).fill(5), 7), [[1, 9]]);
  },
  'without a line height nothing is split'() {
    assert.deepEqual(gridSplitTall([[0, 40]], new Array(40).fill(5), 0), [[0, 40]]);
  },
  'a grid whose rows each hold many lines is under-segmented, one with a wrapped cell is not'() {
    const lines = (row, col, n) => Array.from({ length: n }, () => ({ cell: { row, col } }));
    const crowded = [0, 1].flatMap(r => [0, 1, 2, 3].flatMap(c => lines(r, c, 5)));
    const wrapped = [0, 1].flatMap(r => [...lines(r, 0, 1), ...lines(r, 1, 4), ...lines(r, 2, 1), ...lines(r, 3, 1)]);
    assert.equal(gridUnderSegmented(crowded), 1);
    assert.equal(gridUnderSegmented(wrapped), 0);
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
  'a table of dense small print is read: rows 15 reference pixels apart still hold a line of text'() {
    assert.equal(gridCells([0, 100, 200], [0, 30, 60], 2).length, 4);              // 2 columns x 2 rows, at twice the reference width
  },
  'a tall narrow box holds sideways text, a short or wide one does not'() {
    assert.equal(gridIsSideways(14, 90), true);               // a column heading written upwards
    assert.equal(gridIsSideways(60, 16), false);              // a normal line
    assert.equal(gridIsSideways(8, 18), false);               // a lone digit: taller than wide, but too short to be a line turned on its side
    assert.equal(gridIsSideways(40, 60), false);              // a heading cell with two or three lines is not sideways text
  },
  'the line height is a low estimate: the lower quartile of the band heights, so merged strips do not inflate it'() {
    assert.equal(gridLineHeight([[37], [37, 81], [37, 37, 28], [37]]), 37);
    assert.equal(gridLineHeight([[123], [40], [123], [40], [123], [123]]), 40);   // tight lines merged into one band in most cells
    assert.equal(gridLineHeight([]), 0);
    assert.equal(gridLineHeight([[], [40]]), 40);                          // an empty cell says nothing
  },
  'column lines: strong lines kept, letter strokes dropped'() {
    const mass = new Array(1000).fill(0);
    for (const x of [100, 500, 900]) mass[x] = 255 * 400;   // table lines
    for (const x of [300, 301, 302]) mass[x] = 255 * 60;         // strokes of letters, above the floor but weak
    assert.deepEqual(gridPickColumns(mass, 1), [100, 500, 900]);
  },
  'column lines: the page-edge shadow does not set the scale'() {
    const mass = new Array(1000).fill(0);
    mass[10] = 255 * 5000;                                       // scan-edge shadow
    for (const x of [100, 500, 900]) mass[x] = 255 * 300;
    assert.deepEqual(gridPickColumns(mass, 1), [100, 500, 900]);
  },
  'a full-height narrow bar is a ruling fragment, a digit is not'() {
    assert.equal(gridIsRuleFragment(20, 20, 5), true);
    assert.equal(gridIsRuleFragment(13, 20, 5), false);          // a digit "1" centred in the cell
    assert.equal(gridIsRuleFragment(20, 20, 60), false);         // a wide text line that fills the cell
  },
  'a heading with text at both ends is two runs, words in one line are one'() {
    const ink = [...Array(10).fill(3), ...Array(80).fill(0), ...Array(10).fill(3)];
    assert.deepEqual(gridInkRuns(ink, 30), [[0, 9], [90, 99]]);
    const words = [...Array(10).fill(3), 0, 0, 0, ...Array(10).fill(3)];
    assert.deepEqual(gridInkRuns(words, 30), [[0, 22]]);
  },
  'a lone dark pixel is texture, a two-pixel stroke is ink'() {
    const w = 5, h = 3, ink = new Uint8Array(w * h);
    ink[0 * w + 0] = 1;                                          // alone
    ink[1 * w + 3] = 1; ink[2 * w + 3] = 1;                      // a stroke
    assert.deepEqual([...gridDespeckle(ink, w, h)], [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  },
  'a line too wide for the recogniser is cut at the blank stretch nearest its middle'() {
    const ink = [...Array(40).fill(1), 0, 0, ...Array(10).fill(1), 0, ...Array(40).fill(1)];     // 93 wide, gaps at 40-41 and 52
    assert.deepEqual(gridSplitWide(ink, [0, 92], 60), [[0, 39], [42, 92]].flatMap(r => gridSplitWide(ink, r, 60)));
    assert.deepEqual(gridSplitWide(ink, [0, 92], 100), [[0, 92]]);
    assert.deepEqual(gridSplitWide(Array(100).fill(1), [0, 99], 30), [[0, 99]]);                  // no gap to cut at
    assert.deepEqual(gridSplitWide(ink, [0, 92], 60, 3), [[0, 92]]);                              // gaps of 1-2 columns are between letters
  },
  'a ruled line crossed by the column rules is a row boundary, a page-edge shadow is not'() {
    const w = 20, h = 20, ver = new Uint8Array(w * h);
    for (const x of [4, 12]) for (let y = 5; y < 18; y++) ver[y * w + x] = 1;     // two column rules from row 5 down
    assert.equal(gridJointCount(ver, w, h, [4, 12], 8, 2), 2);
    assert.equal(gridJointCount(ver, w, h, [4, 12], 1, 2), 0);                    // a line above where the rules start
    assert.equal(gridJointCount(ver, w, h, [4, 12], 6, 2) >= 2, true);            // a tilted scan still joins within reach
  },
  'column rules that run on below the last row rule mean the grid stops short of the table'() {
    const w = 20, h = 40, ver = new Uint8Array(w * h);
    for (const x of [4, 12]) for (let y = 5; y < 38; y++) ver[y * w + x] = 1;
    assert.equal(gridRulesBelow(ver, w, h, [4, 12], 10, 2), 25);                  // rules from row 13 to 37 are not part of the grid
    assert.equal(gridRulesBelow(ver, w, h, [4, 12], 37, 2), 0);                   // a grid that ends where the rules end
    const one = new Uint8Array(w * h); for (let y = 5; y < 38; y++) one[y * w + 4] = 1;
    assert.equal(gridRulesBelow(one, w, h, [4, 12], 10, 2), 0);                   // a single stray vertical line is not a table edge
  },
  'a last column rule near the right edge of the page is kept, the edge shadow is not'() {
    const mass = new Array(1000).fill(0);
    mass[8] = 255 * 5000; mass[995] = 255 * 5000;                // shadows at both page edges
    for (const x of [100, 500, 970]) mass[x] = 255 * 300;
    assert.deepEqual(gridPickColumns(mass, 1), [100, 500, 970]);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message.split('\n')[0]); }
}
console.log(failed ? failed + ' failed' : 'all ' + Object.keys(tests).length + ' passed');
process.exit(failed ? 1 : 0);
