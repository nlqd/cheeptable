// Unit tests for docs/boq-arith.js. The failing rows are real reads from the 11-page contract.  Run: node test-arith.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { arithParse, arithHolds, arithRepair, repairArithmetic } = createRequire(import.meta.url)('./docs/boq-arith.js');

const tests = {
  'dot groups thousands, comma is the decimal mark'() {
    assert.deepEqual(arithParse('1.234,56'), [1234.56]);
    assert.deepEqual(arithParse('1.801.750'), [1801750]);
    assert.deepEqual(arithParse('0,932'), [0.932]);
  },
  'X,YYY is read both as a decimal and as thousands'() {
    assert.deepEqual(arithParse('4,610'), [4.61, 4610]);
  },
  'text that is not a number has no value'() {
    assert.deepEqual(arithParse('Sil'), []);
    assert.deepEqual(arithParse('(6)=(4)x(5)'), []);
  },
  'a consistent row is left alone'() {
    assert.equal(arithRepair('0,056', '26.512.500', '1.484.700'), null);
  },
  'comma read where the thousands dot belongs (price)'() {
    assert.deepEqual(arithRepair('0,186', '5,567.625', '1.035.578'), ['0,186', '5.567.625', '1.035.578']);
  },
  'comma read where the thousands dot belongs (total)'() {
    assert.deepEqual(arithRepair('19', '500.000', '9,500.000'), ['19', '500.000', '9.500.000']);
  },
  'a dropped digit in the total'() {
    assert.deepEqual(arithRepair('35,193', '207.752', '7.11.416'), ['35,193', '207.752', '7.311.416']);
  },
  'when any of the three could be the wrong one, the row is left alone'() {
    assert.equal(arithRepair('1', '85.850', '257.550'), null);
  },
  'unreadable quantity is solved from price and total'() {
    assert.deepEqual(arithRepair('Sil', '219.524', '219.524'), ['1', '219.524', '219.524']);
  },
  'header rows with column numbers are never rewritten'() {
    assert.equal(arithRepair('(4)', '(5)', '(6)=(4)x(5)'), null);
  },
  'repairing rows keeps the original text and marks the cell'() {
    const cell = (value) => ({ value, original: value });
    const rows = [{ type: 'data', cells: [cell('154'), cell('x'), cell('100m3'), cell('0,186'), cell('5,567.625'), cell('1.035.578')] },
                  { type: 'section', cells: [cell('PHẦN 1')] }];
    const { fixed } = repairArithmetic(rows);
    assert.equal(fixed, 1);
    assert.equal(rows[0].cells[4].value, '5.567.625');
    assert.equal(rows[0].cells[4].original, '5,567.625');
    assert.equal(rows[0].cells[4].correctedBy, 'arith');
    assert.equal(rows[0].cells[3].correctedBy, undefined);
  },
  'holds tolerates rounding in the document'() {
    assert.ok(arithHolds('1,663', '28.359.500', '47.161.849'));
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message.split('\n').slice(0, 4).join('\n     ')); }
}
console.log(failed ? failed + ' failed' : 'all ' + Object.keys(tests).length + ' passed');
process.exit(failed ? 1 : 0);
