// boq-headers.js — a table that runs over several pages repeats its header row (and the row of column numbers) on every page.
// The rows of the later pages that match the header of the first table page are dropped, so the sheet has one header.
'use strict';

const HEADER_LOOKAHEAD = 12;      // rows of the first table page searched for the header
const HEADER_SCAN = 3;            // rows at the top of a later page that can be a repeated header
const HEADER_MATCH = 0.5;         // share of the words that must be shared

const hdrCells = (row) => (row.cells || []).map(c => String((c && typeof c === 'object') ? c.value : c).trim()).filter(Boolean);
const hdrFold = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u0111/g, 'd').toLowerCase();

// Words made of letters only: the recogniser's invented digit strings in an empty cell do not count for or against a match.
function hdrWords(row) {
  return new Set(hdrFold(hdrCells(row).join(' ')).split(/[^a-z]+/).filter(w => w.length >= 2));
}

// A row of column numbers: "(1) (2) (3) (4) (5) (6)=(4)x(5)", read with some noise. Three or more of its cells look like "(n)".
function isColumnNumberRow(row) {
  const cells = hdrCells(row);
  return cells.filter(c => /^\(\d{1,2}\)(\s*=.*)?$/.test(c.replace(/\s/g, ''))).length >= 3;
}

function sameHeader(row, first) {
  if (isColumnNumberRow(row)) return first.some(isColumnNumberRow);
  const a = hdrWords(row);
  if (a.size < 3) return false;
  return first.some(f => {
    const b = hdrWords(f);
    if (b.size < 3) return false;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    return shared / Math.min(a.size, b.size) >= HEADER_MATCH;
  });
}

function dropRepeatedHeaders(rows) {
  const pages = [...new Set(rows.map(r => r.page))];
  if (pages.length < 2) return rows;
  // the header is what stands above the first row that holds a quantity or a price
  const firstPage = rows.filter(r => r.page === pages[0]).slice(0, HEADER_LOOKAHEAD);
  const firstData = firstPage.findIndex(r => hdrCells(r).some(c => /^\d+([.,]\d+)+$/.test(c)));
  const header = (firstData < 0 ? firstPage : firstPage.slice(0, firstData)).filter(r => hdrCells(r).length >= 3);
  const drop = new Set();
  for (const p of pages.slice(1)) {
    const top = rows.filter(r => r.page === p).slice(0, HEADER_SCAN);
    for (const r of top) if (sameHeader(r, header)) drop.add(r);
  }
  return drop.size ? rows.filter(r => !drop.has(r)) : rows;
}

if (typeof module !== 'undefined') module.exports = { dropRepeatedHeaders, isColumnNumberRow };
