// Unit tests for docs/boq-headers.js.  Run: node test-headers.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { dropRepeatedHeaders, isColumnNumberRow } = createRequire(import.meta.url)('./docs/boq-headers.js');
const row = (page, ...cells) => ({ page, cells: cells.map(value => ({ value })) });

const head = (page, noise = '') => [
  row(page, 'Stt', 'Mô tả công việc ' + noise, 'Đvt', 'Khối lượng', 'Đơn giá (đồng)', 'Thành tiền (đồng)'),
  row(page, '(1)', '(2)', '(3)', '(4)', '(5)', '(6)=(4)x(5)'),
];
const item = (page, n) => row(page, String(n), 'Cắt mặt nhựa', '100 m', '4,610', '1.801.750', '8.306.068');

const tests = {
  'a header repeated on page 2 is dropped, page 1 keeps its own'() {
    const rows = [row(1, '', 'BIỂU GIÁ HỢP ĐỒNG'), ...head(1), item(1, 1), ...head(2), item(2, 2)];
    const out = dropRepeatedHeaders(rows);
    assert.equal(out.length, 5);
    assert.deepEqual(out.map(r => r.page), [1, 1, 1, 1, 2]);
  },
  'a header read with invented digits in an empty cell still matches'() {
    const rows = [...head(1), item(1, 1), row(2, 'Stt', 'Mông công tải mô tả công việc', 'Dvt', 'Khối lượng', 'Đơn giá 0310000000000 (đồng)', 'Thành tiền 14010000000 (đồng)'), item(2, 2)];
    assert.equal(dropRepeatedHeaders(rows).length, 4);
  },
  'a row of column numbers read badly is still recognised'() {
    assert.equal(isColumnNumberRow(row(2, '(1)', '0380000000002', '(3)', '(4)', '03.15) 03100000022', '(6)-4)x(5)')), true);
    assert.equal(isColumnNumberRow(row(2, '(1)', '(2)', '(3)', '(4)', '(5)', '(6)=(4)x(5)')), true);
  },
  'an item row at the top of a later page is kept'() {
    const rows = [...head(1), item(1, 1), item(2, 2), item(2, 3)];
    assert.equal(dropRepeatedHeaders(rows).length, 5);
  },
  'one page, nothing to drop'() {
    const rows = [...head(1), item(1, 1)];
    assert.equal(dropRepeatedHeaders(rows), rows);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message.split('\n')[0]); }
}
console.log(failed ? failed + ' failed' : 'all ' + Object.keys(tests).length + ' passed');
process.exit(failed ? 1 : 0);
