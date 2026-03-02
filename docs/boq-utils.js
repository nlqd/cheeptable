// boq-utils.js — pure utility functions, no DOM dependencies
'use strict';

// ── Utilities ──
// Yield to the browser event loop so the UI (progress bar, etc.) can update
// between heavy synchronous operations (OpenCV, large array loops).
const yieldToMain = () => new Promise(r => setTimeout(r, 0));

// ── Utilities ──
function cluster(values, tol = LINE_TOLERANCE) {
  if (values.length === 0) return [];
  const sorted = [...new Set(values.map(v => Math.round(v * 10) / 10))].sort((a, b) => a - b);
  const clusters = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - clusters[clusters.length - 1] > tol) {
      clusters.push(sorted[i]);
    } else {
      // Update cluster center to average
      clusters[clusters.length - 1] = (clusters[clusters.length - 1] + sorted[i]) / 2;
    }
  }
  return clusters;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Vietnamese Number Parser ──
function parseVnNumber(s) {
  s = s.trim();
  if (!s || !/[\d]/.test(s)) return null;

  // Strip leading/trailing non-numeric garbage (table border artifacts: ']', '|', '[', etc.)
  s = s.replace(/^[^\d,.\-]+/, '').replace(/[^\d,.]+$/, '');
  if (!s) return null;

  // "4.330.000" → 4330000 (dots as thousands)
  // "0,700" → 0.7 (comma as decimal)
  const dotCount = (s.match(/\./g) || []).length;
  const commaCount = (s.match(/,/g) || []).length;

  let normalized;
  if (dotCount > 1) {
    // Multiple dots = thousands separator
    normalized = s.replace(/\./g, '');
    if (commaCount === 1) normalized = normalized.replace(',', '.');
  } else if (dotCount === 1 && commaCount === 0) {
    // Could be decimal or thousands — check position
    const parts = s.split('.');
    if (parts[1] && parts[1].length === 3 && parts[0].length <= 3) {
      // Likely thousands separator: "1.000" = 1000
      normalized = s.replace('.', '');
    } else {
      normalized = s; // decimal
    }
  } else if (commaCount === 1 && dotCount === 0) {
    normalized = s.replace(',', '.');
  } else {
    normalized = s.replace(/\./g, '').replace(',', '.');
  }

  // Reject if cleaned string still contains non-numeric characters (e.g. "066*66")
  if (/[^\d.\-]/.test(normalized)) return null;

  const num = parseFloat(normalized);
  return isNaN(num) ? null : num;
}

// ── Known units whitelist (Vietnamese construction tables) ──
const KNOWN_UNITS = new Set([
  'm','m2','m3','m²','m³','kg','tấn','cái','bộ','md','lần','cây','thanh','tấm',
  'bao','lit','l','km','lỗ','đợt','công','100m','100m3','100m2','1000m','tổ','ca',
  'vị','chiếc','set','pcs','căn','cột','cọc','lớp','đoạn','đợt','tổ hợp',
]);

const COL_NAMES = ['STT','Mô tả công việc','Đvt','Khối lượng','Đơn giá','Thành tiền'];
