// boq-marks.js — lone dash and ditto marks the text detector does not box.
// A dash in a cell (zero, nothing) or a ditto mark ("same as above") is a few pixels of ink; the detector skips them, so a statistics
// table loses a third of its cells. Small ink blobs that sit outside every detected box, on the line of one, are boxed here and sent to the recogniser,
// which keeps only the ones it reads as a mark. A run of close blobs on one line is a dotted leader, not marks.
'use strict';

const MARK_MAX_W = 40, MARK_MAX_H = 16, MARK_MIN_AREA = 5, MARK_PAD = 8, MARK_NEAR_X = 400, MARK_MAX_COUNT = 300;
const MARK_LEADER_GAP = 40;                              // dots of a leader line sit closer than this; the dashes of a statistics row are a column apart

// Connected blobs (8-neighbour) of an ink mask: [{x0, y0, x1, y1, area}]
function inkBlobs(ink, w, h) {
  const parent = new Int32Array(w * h).fill(-1);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!ink[i]) continue;
      parent[i] = i;
      if (x > 0 && ink[i - 1]) join(i - 1, i);
      if (y > 0) {
        if (ink[i - w]) join(i - w, i);
        if (x > 0 && ink[i - w - 1]) join(i - w - 1, i);
        if (x < w - 1 && ink[i - w + 1]) join(i - w + 1, i);
      }
    }
  }
  const blobs = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!ink[i]) continue;
      const r = find(i), b = blobs.get(r);
      if (!b) blobs.set(r, { x0: x, y0: y, x1: x + 1, y1: y + 1, area: 1 });
      else { b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x + 1); b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y + 1); b.area++; }
    }
  }
  return [...blobs.values()];
}

// Boxes (padded for the recogniser) around small blobs that no detected box covers and that share a line with one
function markBoxes(ink, w, h, boxes) {
  const inside = (b) => boxes.some(d => b.x1 > d.x0 - 2 && b.x0 < d.x1 + 2 && b.y1 > d.y0 - 2 && b.y0 < d.y1 + 2);
  const small = inkBlobs(ink, w, h)
    .filter(b => b.x1 - b.x0 <= MARK_MAX_W && b.y1 - b.y0 <= MARK_MAX_H && b.area >= MARK_MIN_AREA && !inside(b))
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const merged = [];                                     // the two strokes of a ditto mark are one mark
  for (const b of small) {
    const m = merged.find(o => b.x0 - o.x1 <= 10 && o.x0 - b.x1 <= 10 && b.y0 < o.y1 + 4 && o.y0 < b.y1 + 4 && Math.max(b.x1, o.x1) - Math.min(b.x0, o.x0) <= MARK_MAX_W);
    if (m) { m.x0 = Math.min(m.x0, b.x0); m.x1 = Math.max(m.x1, b.x1); m.y0 = Math.min(m.y0, b.y0); m.y1 = Math.max(m.y1, b.y1); }
    else merged.push({ ...b });
  }
  const leader = (b) => merged.some(o => o !== b && Math.abs((o.y0 + o.y1) / 2 - (b.y0 + b.y1) / 2) <= 4 && Math.min(Math.abs(o.x0 - b.x1), Math.abs(b.x0 - o.x1)) <= MARK_LEADER_GAP);
  const online = (b) => boxes.some(d => b.y0 + (b.y1 - b.y0) / 2 > d.y0 - 4 && b.y0 + (b.y1 - b.y0) / 2 < d.y1 + 4
    && Math.min(Math.abs(b.x0 - d.x1), Math.abs(d.x0 - b.x1)) <= MARK_NEAR_X);
  return merged.filter(b => online(b) && !leader(b)).slice(0, MARK_MAX_COUNT).map(b => ({
    x0: Math.max(0, b.x0 - MARK_PAD), y0: Math.max(0, b.y0 - MARK_PAD), x1: Math.min(w, b.x1 + MARK_PAD), y1: Math.min(h, b.y1 + MARK_PAD), score: 0, mark: true,
  }));
}

// A ditto mark inside a detected box is read as "11" or "II": two short strokes. Real digits stand as tall as the text around them, the ditto only about half.
function readAsDitto(text, boxHeight, medianHeight) {
  return /^[1Il|]{2}$/.test(text.trim()) && boxHeight <= 0.7 * medianHeight ? '"' : text;
}

if (typeof module !== 'undefined') module.exports = { inkBlobs, markBoxes, readAsDitto };
