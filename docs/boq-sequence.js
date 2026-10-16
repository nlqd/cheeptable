// boq-sequence.js — repair misread row numbers (STT) using the fact that they count up by one.
// A misread digit is fixed only when the expected next number differs from what was read by one confusable digit
// (7 read as 1 is the common one: 27 -> 21, 127 -> 121). Anything else is left exactly as read.
// A "1" starts a new numbering only when the next numbered row is a 2, so junk rows cannot reset the count.
'use strict';

// Digits the recogniser mixes up; shared with boq-arith.js when both are loaded.
const SEQ_CONFUSIONS = { 0: '689', 1: '7', 2: '7', 3: '58', 4: '9', 5: '63', 6: '058', 7: '12', 8: '0369', 9: '4086' };

function seqIsOneConfusion(read, expected) {
  if (read.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < read.length; i++) {
    if (read[i] === expected[i]) continue;
    if (!(SEQ_CONFUSIONS[expected[i]] || '').includes(read[i])) return false;
    if (++diff > 1) return false;
  }
  return diff === 1;
}

const seqNumber = (row) => {
  const v = String(row.cells[0].value).trim();
  return row.type === 'data' && /^\d{1,3}$/.test(v) ? v : null;
};

// Rows from the table builder; returns how many STT cells were changed.
function repairNumbering(rows) {
  const numbered = rows.filter(r => seqNumber(r) !== null);
  let prev = null, fixed = 0;
  numbered.forEach((row, i) => {
    const read = seqNumber(row);
    const value = Number(read);
    if (prev === null) { prev = value; return; }   // the first number is the starting point
    const expected = String(prev + 1);
    if (read === expected) {
      prev = value;
    } else if (seqIsOneConfusion(read, expected)) {
      const cell = row.cells[0];
      cell.original = cell.original ?? cell.value;
      cell.value = expected;
      cell.correctedBy = 'sequence';
      prev = prev + 1;
      fixed++;
    } else if (value > prev + 1 && value <= prev + 3) {
      prev = value;                       // a row or two went missing
    } else if (value === 1) {
      const next = numbered[i + 1] && seqNumber(numbered[i + 1]);
      if (next === '2') prev = 1;         // a real restart, not a stray mark
    }
  });
  return { rows, fixed };
}

if (typeof module !== 'undefined') module.exports = { repairNumbering, seqIsOneConfusion };
