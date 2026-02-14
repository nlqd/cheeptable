/**
 * Vietnamese Text Post-Processing Fixes V2
 * Simplified and more effective implementations
 */

/**
 * Normalize case in Vietnamese text
 */
function normalizeVietnameseCase(text) {
    if (!text) return text;

    // Handle ALL CAPS Vietnamese text
    if (text === text.toUpperCase() && text.length > 3) {
        // Check if it's a known abbreviation
        const abbreviations = ['DMA', 'ER', 'BPS', 'MPA', 'BOQ'];
        if (abbreviations.includes(text)) {
            return text;
        }

        // Convert to title case - capitalize first letter only
        return text.charAt(0) + text.slice(1).toLowerCase();
    }

    return text;
}

/**
 * Fix spacing issues in Vietnamese text
 */
function fixVietnameseSpacing(text) {
    if (!text) return text;

    // Vietnamese connecting words
    const connectors = ['và', 'trong', 'của', 'cho', 'với', 'vào', 'từ', 'đến'];

    // Fix pattern: "wordVÀword" -> "word VÀ word"
    for (const conn of connectors) {
        const pattern = new RegExp(`([a-záàảãạăắằẳẵặâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđ\\d]+)(${conn})([a-záàảãạăắằẳẵặâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđ\\d]+)`, 'gi');
        text = text.replace(pattern, '$1 $2 $3');
    }

    // Fix pattern: "word1 vàword2" -> "word1 và word2" (missing second space)
    for (const conn of connectors) {
        const pattern = new RegExp(`(\\s${conn})([a-záàảãạăắằẳẵặâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđ]+)`, 'gi');
        text = text.replace(pattern, '$1 $2');
    }

    return text;
}

/**
 * Main post-processing function
 */
function postProcessVietnameseText(text) {
    // DISABLED: Return original text without any post-processing
    return text;
}

// Export for use in browser or Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        normalizeVietnameseCase,
        fixVietnameseSpacing,
        postProcessVietnameseText
    };
}
