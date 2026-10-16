// results-core.js — pure logic behind the results table: header detection, review flags, column types. No DOM, so it is unit-tested in Node.
'use strict';

// Review thresholds come from measurement on the 473-row contract (the recogniser's confidence is bunched between 88 and 95;
// hillclimb/size/flags_calib.py reruns this for a new model):
//   description confidence < 91: 16.5% of cells, 96% of them really wrong; 91-93 adds 23.5% of cells at 87% precision overall
//   number confidence < 80: about half really wrong; quantity x price != total: every flagged row really wrong in the earlier measurement
const REVIEW = { textCheck: 91, textMaybe: 93, numCheck: 80 };

const rcPlain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();
const rcVal = (c) => (c && typeof c === 'object') ? String(c.value ?? '') : String(c ?? '');
const rcConf = (c) => (c && typeof c === 'object' && c.confidence != null) ? Number(c.confidence) : null;

// A header cell names a column. Each cell is matched to at most one group.
const HEADER_GROUPS = [
  ['stt', /^(stt|tt|so tt|no\.?)$/],
  ['desc', /(^ten |mo ta|noi dung|hang muc|dien giai|cong viec|vat tu|ten hang|description|item)/],
  ['unit', /^(dvt|dv tinh|don vi( tinh)?|unit)$/],
  ['qty', /(so luong|khoi luong|^sl$|^kl$|quantity|qty)/],
  ['price', /(don gia|unit price|price)/],
  ['total', /(thanh tien|^tong|total|amount)/],
];
const GROUP_NAMES = { stt: { vi: 'STT', en: 'No.' }, desc: { vi: 'Mô tả công việc', en: 'Description' }, unit: { vi: 'Đvt', en: 'Unit' },
  qty: { vi: 'Khối lượng', en: 'Quantity' }, price: { vi: 'Đơn giá', en: 'Unit price' }, total: { vi: 'Thành tiền', en: 'Amount' } };
const headerGroup = (text) => { const t = rcPlain(text); const g = t && t.length <= 40 && HEADER_GROUPS.find(([, re]) => re.test(t)); return g ? g[0] : null; };
function headerHits(cells) {
  const groups = new Set();
  cells.forEach(c => {
    const t = rcPlain(rcVal(c));
    if (!t || t.length > 40) return;
    const g = HEADER_GROUPS.find(([, re]) => re.test(t));
    if (g) groups.add(g[0]);
  });
  return groups.size;
}
const isHeaderRow = (cells) => headerHits(cells) >= 3;
// The row of column numbers many Vietnamese tables print under the header: (1) (2) (3) ... (6)=(4)x(5)
const NUMBERING_CELL = /^\(?\d{1,2}\)?(\s*[=\-\u2013]\s*\(?\d{1,2}\)?(\s*[x*\u00d7]\s*\(?\d{1,2}\)?)*)?$/i;
const isNumberingRow = (cells) => {
  const filled = cells.map(rcVal).map(s => s.trim()).filter(Boolean);
  const hits = filled.filter(s => NUMBERING_CELL.test(s)).length;
  return hits >= 3 && hits >= filled.length - 1;       // one cell may be misread
};

// Drops header and column-number rows (a table repeats them on every page) and returns the names found on the first header.
function normalizeHeaders(rows) {
  let names = null;
  const kept = [];
  let dropped = 0;
  for (const row of rows) {
    if (row.type === 'data' || row.type === 'header') {
      if (isHeaderRow(row.cells) || row.type === 'header') {
        if (!names) names = row.cells.map(c => rcVal(c).replace(/\s+/g, ' ').trim());
        dropped++;
        continue;
      }
      if (isNumberingRow(row.cells)) { dropped++; continue; }
    }
    kept.push(row);
  }
  return { rows: kept, names, dropped };
}

const BOQ_NAMES = { vi: ['STT', 'Mô tả công việc', 'Đvt', 'Khối lượng', 'Đơn giá', 'Thành tiền'], en: ['No.', 'Description', 'Unit', 'Quantity', 'Unit price', 'Amount'] };
// A header cell that matches a known column kind gets that kind's clean name (the printed header is often misread);
// otherwise the printed text, otherwise the BOQ name for a BOQ-shaped table, otherwise "Column n".
function columnNames(count, detected, lang, boqLike) {
  return Array.from({ length: count }, (_, i) => {
    const d = detected && detected[i];
    const g = d && headerGroup(d);
    if (g) return GROUP_NAMES[g][lang];
    if (boqLike && count === 6) return BOQ_NAMES[lang][i];
    if (d && d.length <= 40) return d;
    return (lang === 'vi' ? 'Cột ' : 'Column ') + (i + 1);
  });
}
// The engine's row layout is [number, description, unit, quantity, price, total]; tell whether this table looks like it.
const looksLikeBoq = (rows) => {
  const data = rows.filter(r => r.type === 'data' && r.cells.length === 6);
  return data.length >= 3 && data.filter(r => /^\d{1,4}$/.test(rcVal(r.cells[0]).trim()) && /\d/.test(rcVal(r.cells[5]))).length >= data.length * 0.5;
};

// ── Review flags ──
// Returns { map: Map("r:c" -> {level, reason, conf}), check: number of cells to check, maybe: number of weaker suspects }.
function reviewFlags(rows, holds) {
  const map = new Map();
  const add = (r, c, level, reason, conf) => { const k = r + ':' + c; const old = map.get(k); if (!old || (old.level === 'maybe' && level === 'check')) map.set(k, { level, reason, conf }); };
  rows.forEach((row, r) => {
    if (row.type !== 'data') return;
    const cells = row.cells;
    cells.forEach((cell, c) => {
      const v = rcVal(cell).trim();
      const conf = rcConf(cell);
      if (!v || conf == null || conf <= 0 || (cell && cell.reviewed)) return;
      const numeric = c >= 3 && /^[\d.,()\-\s]+$/.test(v);
      if (numeric) { if (conf < REVIEW.numCheck) add(r, c, 'check', 'lowNum', conf); }
      else if (c >= 1 && /[^\d\s.,()\-]/.test(v)) {
        if (conf < REVIEW.textCheck) add(r, c, 'check', 'lowText', conf);
        else if (conf < REVIEW.textMaybe) add(r, c, 'maybe', 'maybeText', conf);
      }
    });
    if (cells.length >= 6 && holds && !cells.slice(3, 6).some(c => c && c.reviewed)) {
      const [q, p, t] = cells.slice(3, 6).map(rcVal);
      if (/\d/.test(q) && /\d/.test(p) && /\d/.test(t) && !holds(q, p, t)) [3, 4, 5].forEach(c => add(r, c, 'check', 'identity', rcConf(cells[c])));
    }
  });
  let check = 0, maybe = 0;
  map.forEach(f => { if (f.level === 'check') check++; else maybe++; });
  return { map, check, maybe };
}

// A column is numeric for export when most of its filled cells parse as numbers (a 'parse' function is injected).
function numericColumns(rows, count, parse) {
  const out = [];
  for (let c = 0; c < count; c++) {
    let filled = 0, ok = 0;
    rows.forEach(r => { if (r.type !== 'data') return; const v = rcVal(r.cells[c]).trim(); if (!v) return; filled++; if (parse(v) !== null) ok++; });
    out.push(filled >= 3 && ok / filled >= 0.8);
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { REVIEW, headerGroup, rcPlain, isHeaderRow, isNumberingRow, normalizeHeaders, columnNames, looksLikeBoq, reviewFlags, numericColumns };
