// Unit tests for docs/boq-sequence.js.  Run: node test-sequence.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { repairNumbering, seqIsOneConfusion } = createRequire(import.meta.url)('./docs/boq-sequence.js');

const row = (stt, type = 'data') => ({ type, cells: [{ value: String(stt), original: String(stt) }] });
const run = (sttList) => { const rows = sttList.map(s => row(s)); repairNumbering(rows); return rows.map(r => r.cells[0].value); };

const tests = {
  'a clean sequence is untouched'() {
    assert.deepEqual(run([1, 2, 3, 4]), ['1', '2', '3', '4']);
  },
  '7 read as 1 is repaired (27 -> 21)'() {
    assert.deepEqual(run([25, 26, 21, 28]), ['25', '26', '27', '28']);
  },
  'a lone misread in a run is put back'() {
    const out = run([1, 2, 3, 4, 5, 6, 1, 8]);
    assert.equal(out[6], '7');
  },
  'three digit numbers: 127 read as 121'() {
    const rows = [125, 126, 121, 128].map(s => row(s));
    const r = repairNumbering(rows);
    assert.equal(rows[2].cells[0].value, '127');
    assert.equal(r.fixed, 1);
  },
  'repair keeps the original text and marks the cell'() {
    const rows = [row(1), row(2), row(3), row(4), row(5), row(6), row(1), row(8)];
    repairNumbering(rows);
    assert.equal(rows[6].cells[0].original, '1');
    assert.equal(rows[6].cells[0].correctedBy, 'sequence');
  },
  'a missing row does not break later rows'() {
    assert.deepEqual(run([1, 2, 4, 5]), ['1', '2', '4', '5']);
  },
  'a stray 1 does not reset the count'() {
    assert.deepEqual(run([5, 6, 1, 8]).slice(3), ['8']);
  },
  'a real restart (1 then 2) is accepted'() {
    assert.deepEqual(run([1, 2, 3, 1, 2, 3]), ['1', '2', '3', '1', '2', '3']);
  },
  'section and header rows are ignored'() {
    const rows = [row(1), row('PHẦN 2', 'section'), row(2)];
    repairNumbering(rows);
    assert.equal(rows[2].cells[0].value, '2');
  },
  'only confusable digits count as a one-digit fix'() {
    assert.equal(seqIsOneConfusion('21', '27'), true);
    assert.equal(seqIsOneConfusion('25', '27'), false);
    assert.equal(seqIsOneConfusion('221', '27'), false);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message.split('\n').slice(0, 4).join('\n     ')); }
}
console.log(failed ? failed + ' failed' : 'all ' + Object.keys(tests).length + ' passed');
process.exit(failed ? 1 : 0);
