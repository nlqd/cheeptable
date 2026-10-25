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

// The share of text-layer spans whose centre lies inside the grid's body cells. This is the only independent count of
// what a grid must cover: the grid reader's own words sit in its cells by construction, so they cannot measure coverage.
// Spans above the table (the heading) and below it (a note) are not part of the count.
function shareTextInsideCells(items, cells) {
  const body = cells.filter(c => c.row == null || c.row >= 0);
  if (!items.length || !body.length) return 1;
  const top = Math.min(...body.map(c => c.y));
  const bottom = Math.max(...body.map(c => c.y + c.height));
  const centre = (it) => [it.x + (it.width || 0) / 2, it.y - (it.height || 0) / 2];
  const inTable = items.filter(it => { const cy = centre(it)[1]; return cy >= top && cy <= bottom; });
  if (!inTable.length) return 1;
  const inside = (it) => {
    const [cx, cy] = centre(it);
    return body.some(c => cx >= c.x && cx <= c.x + c.width && cy >= c.y && cy <= c.y + c.height);
  };
  return inTable.filter(inside).length / inTable.length;
}

if (typeof module !== 'undefined') module.exports = { tablePages, shareTextInsideCells };
