// boq-arith.js — repair OCR'd numbers with the one invariant every bill of quantities has: qty x price = total.
// Rows whose three numbers already agree are never touched. Otherwise:
//   tier 1  one-character edit of one field (digit confusion, "." and "," swapped, a digit dropped or added),
//           accepted only when exactly one edit makes the identity hold
//   tier 2  solve one field from the other two (qty = total / price ...), accepted only when the solved value is
//           clean and the OCR text of that field is clearly the closest to it
// On the 473-row contract this lifted rows with all three numbers right from 0.947 to 0.966, and on an unseen
// synthetic document from 0.950 to 0.983, without breaking any row that was already right.
'use strict';

const ARITH_TOL = 0.005;
const ARITH_CONFUSIONS = { 0: '689', 1: '7', 2: '7', 3: '58', 4: '9', 5: '63', 6: '058', 7: '12', 8: '0369', 9: '4086' };

// Vietnamese numbers: "." groups thousands, "," is the decimal mark. "X,YYY" is ambiguous (a mis-read thousands
// dot or a real decimal), so both readings are offered and the identity decides.
function arithParse(text) {
  const s = String(text || '').trim().replace(/[\s()[\]%]/g, '');
  if (!/\d/.test(s) || !/^[\d.,]+$/.test(s)) return [];
  let v;
  if (s.includes(',') && !s.includes('.')) v = (s.match(/,/g).length > 1) ? s.replace(/,/g, '') : s.replace(',', '.');   // several commas can only be thousands marks
  else if (s.includes(',') && s.includes('.')) v = s.replace(/\./g, '').replace(',', '.');
  else if ((s.match(/\./g) || []).length > 1) v = s.replace(/\./g, '');
  else if (/^\d+\.\d{3}$/.test(s)) v = s.replace('.', '');
  else v = s;
  const out = [];
  const std = Number(v);
  if (Number.isFinite(std)) out.push(std);
  const m = /^(\d+),(\d{3})$/.exec(s);
  if (m && Number(m[1]) > 0) out.push(Number(m[1] + m[2]));
  return out;
}

function arithHolds(q, p, t, tol = ARITH_TOL) {
  const vq = arithParse(q), vp = arithParse(p), vt = arithParse(t);
  return vq.some(a => vp.some(b => vt.some(c => c !== 0 && Math.abs(a * b - c) / Math.max(Math.abs(c), 1) <= tol)));
}

function* arithEdits(text) {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    for (const sub of ARITH_CONFUSIONS[ch] || '') yield text.slice(0, i) + sub + text.slice(i + 1);
    if (ch === '.' || ch === ',') {
      yield text.slice(0, i) + (ch === ',' ? '.' : ',') + text.slice(i + 1);
      yield text.slice(0, i) + text.slice(i + 1);
    } else if (/\d/.test(ch)) {
      yield text.slice(0, i) + text.slice(i + 1);
    }
  }
  for (let i = 0; i <= text.length; i++) {
    for (const d of '0123456789') yield text.slice(0, i) + d + text.slice(i);
  }
}

const arithInt = (v) => Math.round(v).toLocaleString('en-US').replace(/,/g, '.');
const arithQty = (v) => v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');

function arithLev(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
    }
    prev = cur;
  }
  return prev[b.length];
}

const arithWellFormed = (s) => /^(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/.test(s);

// Edits must leave the edited number well-formed; otherwise several mis-spellings of the same fix compete.
// Edits are keyed by the value they produce, so "swap the comma" and "delete the comma" count as one fix.
// Within one value the first edit wins, and the generator yields the more natural edit first.
function arithTier1(fields) {
  const found = new Map();
  fields.forEach((field, i) => {
    for (const e of arithEdits(field)) {
      const trial = fields.slice();
      trial[i] = e;
      const key = i + ':' + arithParse(e)[0];
      if (arithWellFormed(e) && !found.has(key) && arithHolds(...trial)) found.set(key, trial);
    }
  });
  return found.size === 1 ? [...found.values()][0] : null;
}

function arithTier2([q, p, t]) {
  const [vq] = arithParse(q), [vp] = arithParse(p), [vt] = arithParse(t);
  const cands = [];
  if (vp && vt) {
    const s = vt / vp;
    if (s > 0 && Math.abs(s * 1000 - Math.round(s * 1000)) < 1e-6) cands.push([0, arithQty(s), q]);
  }
  if (vq && vt) {
    const s = vt / vq;
    if (s > 0 && Math.abs(s - Math.round(s)) < 1e-6) cands.push([1, arithInt(s), p]);
  }
  if (vq && vp) cands.push([2, arithInt(vq * vp), t]);
  if (!cands.length) return null;
  const scored = cands.map(([i, next, old]) => [arithLev(next, old) / Math.max(next.length, old.length, 1), i, next])
    .sort((a, b) => a[0] - b[0]);
  if (scored.length > 1 && scored[1][0] - scored[0][0] < 0.3) return null;
  const trial = [q, p, t];
  trial[scored[0][1]] = scored[0][2];
  return arithHolds(...trial) ? trial : null;
}

// Returns the repaired [qty, price, total] texts, or null when the row is fine or cannot be repaired safely.
function arithRepair(q, p, t) {
  const numeric = (s) => /^[\d.,]+$/.test(String(s).trim());
  if (!numeric(p) || !numeric(t) || (q && arithHolds(q, p, t))) return null;
  if (q && numeric(q)) {
    const r = arithTier1([q, p, t]);
    if (r) return r;
  }
  return arithTier2([q, p, t]);
}

// Table rows from ocrTableExtract: data rows have cells [stt, description, unit, qty, price, total].
// The engine's row layout is [number, description, unit, quantity, price, total]; tell whether a table looks like it.
const looksLikeBoq = (rows) => {
  const val = (c) => (c && typeof c === 'object') ? String(c.value ?? '') : String(c ?? '');
  const data = rows.filter(r => r.type === 'data' && r.cells.length === 6);
  return data.length >= 3 && data.filter(r => /^\d{1,4}$/.test(val(r.cells[0]).trim()) && /\d/.test(val(r.cells[5]))).length >= data.length * 0.5;
};

function repairArithmetic(rows) {
  let fixed = 0;
  for (const row of rows) {
    if (row.type !== 'data' || row.cells.length < 6) continue;
    const fixedTexts = arithRepair(row.cells[3].value, row.cells[4].value, row.cells[5].value);
    if (!fixedTexts) continue;
    fixedTexts.forEach((text, i) => {
      const cell = row.cells[3 + i];
      if (cell.value !== text) {
        cell.original = cell.original ?? cell.value;
        cell.value = text;
        cell.correctedBy = 'arith';
      }
    });
    fixed++;
  }
  return { rows, fixed };
}

if (typeof module !== 'undefined') module.exports = { arithParse, arithHolds, arithRepair, repairArithmetic, looksLikeBoq };
