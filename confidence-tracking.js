/**
 * Confidence Tracking & Correction Attribution
 * Enhances OCR pipeline to preserve confidence scores and track correction sources
 */

// Enhanced correction function that returns metadata
function correctWordWithMetadata(word, ocrConfidence = 85) {
  const original = word;
  const lower = word.toLowerCase();

  // Stage 1: Check if already in dictionary (exact match)
  if (VIETNAMESE_DICT.has(lower)) {
    return {
      value: word,
      original: original,
      confidence: Math.min(ocrConfidence + 10, 100), // Boost confidence for dict match
      source: 'ocr', // Was correct from OCR
      correctedBy: null
    };
  }

  // Stage 2: Dictionary diacritic-agnostic match
  const noDiac = removeDiacritics(lower);
  for (const dictWord of VIETNAMESE_DICT) {
    if (removeDiacritics(dictWord) === noDiac) {
      return {
        value: dictWord,
        original: original,
        confidence: 90, // High confidence for dictionary correction
        source: 'dictionary',
        correctedBy: 'BOQ Dictionary'
      };
    }
  }

  // Stage 3: Levenshtein distance match
  let best = null, bestDist = 999;
  for (const dictWord of VIETNAMESE_DICT) {
    const dist = levenshteinDist(lower, dictWord);
    if (dist < bestDist && dist <= 2) {
      bestDist = dist;
      best = dictWord;
    }
  }

  if (best) {
    return {
      value: best,
      original: original,
      confidence: 75, // Medium confidence for fuzzy match
      source: 'dictionary',
      correctedBy: `BOQ Dictionary (edit distance: ${bestDist})`
    };
  }

  // No correction found - return original with OCR confidence
  return {
    value: word,
    original: original,
    confidence: ocrConfidence,
    source: 'ocr',
    correctedBy: null
  };
}

// Enhanced text correction with syllable model tracking
async function correctTextWithMetadata(text, avgOcrConfidence = 85) {
  const original = text;

  // Stage 0: Post-processing
  if (typeof postProcessVietnameseText !== 'undefined') {
    text = postProcessVietnameseText(text);
  }

  // Stage 1: Try VPS API first (best accuracy)
  if (typeof restoreVietnameseVPS !== 'undefined') {
    const vpsResult = await restoreVietnameseVPS(text);
    if (vpsResult !== null && vpsResult !== text) {
      return {
        value: vpsResult,
        original: original,
        confidence: 94, // VPS API accuracy
        source: 'vps',
        correctedBy: 'VPS Transformer Model (94% accuracy)',
        dictionaryCorrected: false,
        syllableCorrected: false,
        vpsApiCorrected: true
      };
    }
  }

  // Stage 2: Dictionary-based correction with metadata
  const words = text.split(/\s+/);
  const correctedWords = words.map(w => {
    const m = w.match(/^([^\wàáảãạâấầẩẫậăắằẳẵặèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]*)([\wàáảãạâấầẩẫậăắằẳẵặèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]+)([^\wàáảãạâấầẩẫậăắằẳẵặèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]*)$/i);
    if (!m) return { value: w, source: 'ocr', confidence: avgOcrConfidence };

    const meta = correctWordWithMetadata(m[2], avgOcrConfidence);
    return {
      value: m[1] + meta.value + m[3],
      original: w,
      confidence: meta.confidence,
      source: meta.source,
      correctedBy: meta.correctedBy
    };
  });

  const stage2Text = correctedWords.map(w => w.value).join(' ');
  const stage2Confidence = Math.round(
    correctedWords.reduce((sum, w) => sum + w.confidence, 0) / correctedWords.length
  );

  // Stage 3: Syllable model correction (if loaded)
  if (syllableCorrector && syllableCorrector.ready) {
    try {
      // FIX Bug #8: Wrap external library call in try-catch
      const stage3Text = syllableCorrector.correctText(stage2Text);

      // Check if syllable model made changes
      if (stage3Text !== stage2Text) {
        return {
          value: stage3Text,
          original: original,
          confidence: Math.min(stage2Confidence + 5, 95), // Slight boost
          source: 'syllable',
          correctedBy: 'Syllable Model (Vietnamese news corpus)',
          dictionaryCorrected: stage2Text !== text,
          syllableCorrected: true
        };
      }
    } catch (error) {
      console.error('Syllable corrector failed:', error);
      // Continue to return Stage 2 result
    }
  }

  // Return Stage 2 result
  const dictCorrected = stage2Text !== original;
  return {
    value: stage2Text,
    original: original,
    confidence: stage2Confidence,
    source: dictCorrected ? 'dictionary' : 'ocr',
    correctedBy: dictCorrected ? 'BOQ Dictionary' : null,
    dictionaryCorrected: dictCorrected,
    syllableCorrected: false
  };
}

// Classify cell type (for styling and validation)
function classifyCellType(text, colIndex) {
  // Column-based classification
  if (colIndex === 0) return 'stt'; // Serial number
  if (colIndex === 1) return 'text'; // Description
  if (colIndex === 2) return 'unit'; // Unit of measurement
  if (colIndex >= 3) return 'number'; // Quantities and prices

  // Content-based fallback
  if (/^\d+$/.test(text)) return 'stt';
  if (/^[\d.,]+$/.test(text)) return 'number';
  if (/^[a-z]+\d*$/i.test(text) && text.length <= 10) return 'unit';
  return 'text';
}

// Enhanced cell builder
async function buildCellWithMetadata(words, colIndex) {
  if (!words || words.length === 0) {
    return {
      value: '',
      original: '',
      confidence: 0,
      source: 'empty',
      correctedBy: null,
      type: classifyCellType('', colIndex),
      edited: false
    };
  }

  // Combine words into text
  const rawText = words.map(w => w.text).join(' ');
  const avgConfidence = Math.round(
    words.reduce((sum, w) => sum + w.confidence, 0) / words.length
  );

  // Apply corrections with metadata
  const correctionMeta = await correctTextWithMetadata(rawText, avgConfidence);

  return {
    value: correctionMeta.value,
    original: rawText,
    confidence: correctionMeta.confidence,
    source: correctionMeta.source,
    correctedBy: correctionMeta.correctedBy,
    type: classifyCellType(correctionMeta.value, colIndex),
    ocrWords: words.length,
    avgOcrConfidence: avgConfidence,
    edited: false
  };
}

// Get confidence level category
function getConfidenceLevel(confidence) {
  if (confidence >= 90) return 'high';
  if (confidence >= 70) return 'medium';
  return 'low';
}

// Get confidence color (minimal - only for what needs attention)
function getConfidenceColor(confidence) {
  if (confidence >= 90) return 'transparent'; // No color for high confidence
  if (confidence >= 70) return 'rgba(245, 158, 11, 0.12)'; // Subtle amber
  return 'rgba(239, 68, 68, 0.15)'; // Clear red
}

// Get confidence border (minimal - only for what needs attention)
function getConfidenceBorder(confidence) {
  if (confidence >= 90) return 'none'; // No border for high confidence
  if (confidence >= 70) return '2px solid rgba(245, 158, 11, 0.5)'; // Amber
  return '3px solid rgba(239, 68, 68, 0.8)'; // Red
}

// Build correction attribution tooltip
function buildAttributionTooltip(cell) {
  let html = `<div class="cell-attribution">`;

  html += `<div class="attr-row">
    <strong>Original OCR:</strong> "${cell.original}" (${cell.avgOcrConfidence}%)
  </div>`;

  if (cell.correctedBy) {
    html += `<div class="attr-row attr-correction">
      <strong>✓ Corrected by:</strong> ${cell.correctedBy}
    </div>`;
  }

  if (cell.source === 'ocr' && !cell.correctedBy) {
    html += `<div class="attr-row attr-unchanged">
      <strong>No corrections applied</strong>
    </div>`;
  }

  html += `<div class="attr-row attr-confidence">
    <strong>Confidence:</strong> ${cell.confidence}% (${getConfidenceLevel(cell.confidence)})
  </div>`;

  if (cell.type === 'number') {
    html += `<div class="attr-row attr-note">
      <em>Numbers are critical - verify accuracy</em>
    </div>`;
  }

  html += `</div>`;
  return html;
}

// Export functions for use in main code
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    correctWordWithMetadata,
    correctTextWithMetadata,
    buildCellWithMetadata,
    getConfidenceLevel,
    getConfidenceColor,
    getConfidenceBorder,
    buildAttributionTooltip,
    classifyCellType
  };
}
