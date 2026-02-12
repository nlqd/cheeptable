/**
 * Vietnamese Syllable-Level Language Model Corrector
 * Domain-agnostic diacritic restoration based on Vietnamese linguistic structure
 */

class VietnameseSyllableCorrector {
    constructor() {
        this.model = null;
        this.ready = false;
    }

    /**
     * Load syllable language model
     */
    async loadModel(modelPath) {
        try {
            const response = await fetch(modelPath);
            this.model = await response.json();
            this.ready = true;
            console.log(`Syllable model loaded: ${this.model.metadata.syllable_bases} syllable patterns, ${this.model.metadata.bigrams} bigrams`);
            return true;
        } catch (error) {
            console.error('Failed to load syllable model:', error);
            return false;
        }
    }

    /**
     * Remove tone marks from syllable
     */
    removeToneMarks(syllable) {
        const replacements = {
            'à': 'a', 'á': 'a', 'ả': 'a', 'ã': 'a', 'ạ': 'a',
            'ằ': 'ă', 'ắ': 'ă', 'ẳ': 'ă', 'ẵ': 'ă', 'ặ': 'ă',
            'ầ': 'â', 'ấ': 'â', 'ẩ': 'â', 'ẫ': 'â', 'ậ': 'â',
            'è': 'e', 'é': 'e', 'ẻ': 'e', 'ẽ': 'e', 'ẹ': 'e',
            'ề': 'ê', 'ế': 'ê', 'ể': 'ê', 'ễ': 'ê', 'ệ': 'ê',
            'ì': 'i', 'í': 'i', 'ỉ': 'i', 'ĩ': 'i', 'ị': 'i',
            'ò': 'o', 'ó': 'o', 'ỏ': 'o', 'õ': 'o', 'ọ': 'o',
            'ồ': 'ô', 'ố': 'ô', 'ổ': 'ô', 'ỗ': 'ô', 'ộ': 'ô',
            'ờ': 'ơ', 'ớ': 'ơ', 'ở': 'ơ', 'ỡ': 'ơ', 'ợ': 'ơ',
            'ù': 'u', 'ú': 'u', 'ủ': 'u', 'ũ': 'u', 'ụ': 'u',
            'ừ': 'ư', 'ứ': 'ư', 'ử': 'ư', 'ữ': 'ư', 'ự': 'ư',
            'ỳ': 'y', 'ý': 'y', 'ỷ': 'y', 'ỹ': 'y', 'ỵ': 'y',
        };
        return syllable.split('').map(c => replacements[c.toLowerCase()] || c.toLowerCase()).join('');
    }

    /**
     * Correct a syllable using linguistic patterns
     */
    correctSyllable(syllable, prevSyllable) {
        if (!this.ready) return syllable;

        const lower = syllable.toLowerCase();
        const base = this.removeToneMarks(lower);

        // Try bigram context first (more accurate)
        if (prevSyllable) {
            const prevBase = this.removeToneMarks(prevSyllable.toLowerCase());
            const bigramKey = `${prevBase}|${base}`;

            if (this.model.bigrams[bigramKey]) {
                const candidates = this.model.bigrams[bigramKey];
                if (candidates.length > 0) {
                    // Return most frequent variant in this context
                    return this.preserveCase(syllable, candidates[0].s);
                }
            }
        }

        // Fallback to syllable frequency (unigram)
        if (this.model.syllables[base]) {
            const candidates = this.model.syllables[base];
            if (candidates.length > 0) {
                // Return most frequent variant overall
                return this.preserveCase(syllable, candidates[0].s);
            }
        }

        // No correction found
        return syllable;
    }

    /**
     * Preserve case from original syllable
     */
    preserveCase(original, corrected) {
        if (original === original.toUpperCase()) {
            return corrected.toUpperCase();
        } else if (original[0] === original[0].toUpperCase()) {
            return corrected.charAt(0).toUpperCase() + corrected.slice(1);
        }
        return corrected;
    }

    /**
     * Correct full Vietnamese text
     */
    correctText(text) {
        if (!this.ready) return text;

        const words = text.split(/\s+/);
        const corrected = [];

        for (let i = 0; i < words.length; i++) {
            const word = words[i];

            // Extract syllables from word (Vietnamese words are 1-3 syllables)
            const match = word.match(/^([^\wàáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]*)([\wàáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]+)([^\wàáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]*)$/);

            if (!match) {
                corrected.push(word);
                continue;
            }

            const [_, prefix, syllables, suffix] = match;

            // Get previous syllable for context
            let prevSyllable = null;
            if (corrected.length > 0) {
                const prevMatch = corrected[corrected.length - 1].match(/[\wàáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]+/);
                if (prevMatch) {
                    prevSyllable = prevMatch[0];
                }
            }

            // Correct the syllable(s)
            const correctedSyllables = this.correctSyllable(syllables, prevSyllable);

            corrected.push(prefix + correctedSyllables + suffix);
        }

        return corrected.join(' ');
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = VietnameseSyllableCorrector;
}
