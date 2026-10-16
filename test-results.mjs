// Unit tests for docs/results-core.js.  Run: node test-results.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('./docs/results-core.js');
const { arithHolds } = require('./docs/boq-arith.js');
const { isHeaderRow, isNumberingRow, normalizeHeaders, columnNames, looksLikeBoq, reviewFlags, numericColumns } = core;

const cell = (value, confidence = 93) => ({ value, confidence });
const row = (vals, type = 'data', conf) => ({ type, cells: vals.map((v, i) => cell(v, Array.isArray(conf) ? conf[i] : (conf ?? 93))) });

const tests = {
  'a BOQ header row is recognised'() {
    assert.equal(isHeaderRow(row(['STT', 'Tên vật tư', 'Đvt', 'Số lượng', 'Đơn giá', 'Thành tiền']).cells), true);
  },
  'an English header row is recognised'() {
    assert.equal(isHeaderRow(row(['No.', 'Description', 'Unit', 'Quantity', 'Unit price', 'Amount']).cells), true);
  },
  'a data row is not a header'() {
    assert.equal(isHeaderRow(row(['12', 'Ống uPVC Þ150', 'm', '36,5', '85.850', '3.133.525']).cells), false);
  },
  'two header-like words are not enough'() {
    assert.equal(isHeaderRow(row(['Tổng', 'Đơn giá', '', '', '', '']).cells), false);
  },
  'the column-number row is recognised'() {
    assert.equal(isNumberingRow(row(['(1)', '(2)', '(3)', '(4)', '(5)', '(6)=(4)x(5)']).cells), true);
    assert.equal(isNumberingRow(row(['1', '2', '3', '4', '5', '6']).cells), true);
  },
  'a column-number row with one misread cell is still recognised'() {
    assert.equal(isNumberingRow(row(['(1)', '1960010012012', '(3)', '(4)', '6)', '(6) - (4)x(5)']).cells), true);
  },
  'recognised header cells get clean names, even when misread'() {
    assert.deepEqual(columnNames(6, ['Stt', 'Hồ thị trong mô tả công việc', 'Đvt', 'Khối lượng', 'Đại gia', 'Thành tiền (đồng)'], 'vi', false).slice(0, 4), ['STT', 'Mô tả công việc', 'Đvt', 'Khối lượng']);
    assert.equal(columnNames(6, ['Stt', 'Mô tả', 'Đvt', 'KL', 'Đại gia', 'TT'], 'vi', true)[4], 'Đơn giá');
  },
  'a row of real quantities is not a numbering row'() {
    assert.equal(isNumberingRow(row(['12', 'Ống nhựa', 'm', '36', '85', '3.133']).cells), false);
  },
  'repeated headers are dropped and the first one names the columns'() {
    const rows = [row(['STT', 'Hạng mục', 'Đvt', 'Khối lượng', 'Đơn giá', 'Thành tiền']), row(['1', 'Cắt', 'm', '1', '2', '2']),
      row(['(1)', '(2)', '(3)', '(4)', '(5)', '(6)']), row(['STT', 'Hạng mục', 'Đvt', 'Khối lượng', 'Đơn giá', 'Thành tiền']), row(['2', 'Đào', 'm', '1', '2', '2'])];
    const r = normalizeHeaders(rows);
    assert.equal(r.rows.length, 2);
    assert.equal(r.dropped, 3);
    assert.deepEqual(r.names, ['STT', 'Hạng mục', 'Đvt', 'Khối lượng', 'Đơn giá', 'Thành tiền']);
  },
  'without a header the names are generic, or the BOQ names for a BOQ-shaped table'() {
    assert.deepEqual(columnNames(3, null, 'vi', false), ['Cột 1', 'Cột 2', 'Cột 3']);
    assert.equal(columnNames(6, null, 'en', true)[3], 'Quantity');
    assert.deepEqual(columnNames(3, ['A', '', 'C'], 'en', false), ['A', 'Column 2', 'C']);
  },
  'a table of numbered rows with totals looks like a BOQ'() {
    const rows = [1, 2, 3, 4].map(i => row([String(i), 'x', 'm', '1', '2', '2.000']));
    assert.equal(looksLikeBoq(rows), true);
    assert.equal(looksLikeBoq([row(['Tài sản', '100', '200'])]), false);
  },
  'a description under 90 is a check, 90 to 92 only a maybe'() {
    const r = reviewFlags([row(['1', 'chữ', 'm', '1', '2', '2'], 'data', [93, 89, 93, 93, 93, 93]), row(['2', 'chữ hai', 'm', '1', '2', '2'], 'data', [93, 91, 93, 93, 93, 93])], arithHolds);
    assert.equal(r.map.get('0:1').level, 'check');
    assert.equal(r.map.get('1:1').level, 'maybe');
    assert.equal(r.check, 1);
    assert.equal(r.maybe, 1);
  },
  'a low-confidence number is a check'() {
    const r = reviewFlags([row(['1', 'chữ', 'm', '1', '2', '2'], 'data', [93, 93, 93, 75, 93, 93])], arithHolds);
    assert.equal(r.map.get('0:3').reason, 'lowNum');
  },
  'a row that breaks quantity x price = total flags its three numbers'() {
    const r = reviewFlags([row(['1', 'chữ', 'm', '3', '85.850', '999.999'])], arithHolds);
    assert.deepEqual([3, 4, 5].map(c => r.map.get('0:' + c).reason), ['identity', 'identity', 'identity']);
    assert.equal(r.check, 3);
  },
  'a consistent row is not flagged'() {
    const r = reviewFlags([row(['1', 'chữ', 'm', '3', '85.850', '257.550'])], arithHolds);
    assert.equal(r.map.size, 0);
  },
  'a reviewed cell is never flagged again'() {
    const rows = [row(['1', 'chữ', 'm', '1', '2', '2'], 'data', [93, 80, 93, 93, 93, 93])];
    rows[0].cells[1].reviewed = true;
    assert.equal(reviewFlags(rows, arithHolds).map.size, 0);
  },
  'section rows and empty cells are not flagged'() {
    const r = reviewFlags([row(['PHẦN 1', '', '', '', '', ''], 'section', 50), row(['2', '', '', '', '', ''], 'data', 50)], arithHolds);
    assert.equal(r.map.size, 0);
  },
  'columns that mostly parse as numbers export as numbers'() {
    const parse = (v) => /^[\d.,]+$/.test(v) ? 1 : null;
    const rows = [1, 2, 3, 4].map(i => row([String(i), 'Ống', 'm', '10,5', '85.850', '2']));
    assert.deepEqual(numericColumns(rows, 6, parse), [true, false, false, true, true, true]);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message.split('\n').slice(0, 4).join('\n     ')); }
}
console.log(failed ? failed + ' failed' : 'all ' + Object.keys(tests).length + ' passed');
process.exit(failed ? 1 : 0);
