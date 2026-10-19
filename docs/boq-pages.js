// boq-pages.js — which pages of the result are tables.
// Text that is not laid out in columns (a letter, a contents page, a gazette page) comes out one cell per line. A page where fewer than
// three rows, or fewer than one in five, has two or more cells is not a table and is left out; a page with a drawn grid always is one,
// however short (the tail of a table that runs over the page, two rows and a total).
'use strict';

const filledCells = (row) => (row.cells || []).filter(c => String((c && typeof c === 'object') ? c.value : c).trim()).length;

// The set of page numbers to keep. `gridPages` is the set of pages in which a ruled grid was found and read.
function tablePages(rows, gridPages = new Set()) {
  const byPage = new Map();
  rows.forEach(r => byPage.set(r.page, [...(byPage.get(r.page) || []), r]));
  const keep = new Set();
  for (const [page, rs] of byPage) {
    const multi = rs.filter(r => filledCells(r) >= 2).length;
    if (gridPages.has(page) ? multi >= 1 : multi >= 3 && multi / rs.length >= 0.2) keep.add(page);
  }
  return keep;
}

// The share of `words` whose centre lies inside one of `cells` (boxes with x, y, width, height); a word the grid reader took from a cell
// (it carries `cell`) is inside by construction. Cells found by the line detector on a
// page read as text can be just a header's worth; the cell-by-cell reading is only right when they account for the words.
function shareInsideCells(words, cells) {
  if (!words.length) return 1;
  const inside = (w) => { if (w.cell) return true; const cx = (w.x + w.x1) / 2, cy = (w.y + w.y1) / 2; return cells.some(c => cx >= c.x && cx <= c.x + c.width && cy >= c.y && cy <= c.y + c.height); };
  return words.filter(inside).length / words.length;
}

if (typeof module !== 'undefined') module.exports = { tablePages, shareInsideCells };
