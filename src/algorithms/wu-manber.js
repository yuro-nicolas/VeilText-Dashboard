// ─── WU-MANBER MULTI-PATTERN MATCHER ────────────────────────────────────────
//
// Alternate detection engine to Aho-Corasick. Wu-Manber scans in
// block-sized jumps using a precomputed SHIFT table (like Boyer-Moore, but
// for many patterns at once), only falling back to a full string check when
// a candidate block's hash suggests a real match is nearby. It tends to be
// faster than Aho-Corasick when the keyword list is large and the shortest
// keyword is long, at the cost of being a bit more complex. Users can pick
// either engine from the popup's Settings tab (CONFIG.algorithm).
(function (VeilText) {
    'use strict';

    class WuManber {
        constructor(caseSensitive = false) {
            this.caseSensitive = caseSensitive;
            this.patterns = [];
            this.minLen = 0;
            this.blockSize = 1;
            this.prefixSize = 2; // Classic paper uses P = 2
            this.shiftTable = new Map();
            this.hashTable = new Map();
            this.defaultShift = 1;
            this.built = false;
        }

        // Queues one keyword for the next build(). Duplicates are ignored.
        addKeyword(keyword) {
            if (!keyword || keyword.length === 0) return;
            const word = this.caseSensitive ? keyword : keyword.toLowerCase();
            if (word.length === 0) return;
            if (!this.patterns.includes(word)) this.patterns.push(word);
            this.built = false;
        }

        // Simple rolling-friendly hash for a fixed-length block of characters.
        _hashBlock(str, start, len) {
            let h = 0;
            for (let i = 0; i < len; i++) {
                h = (h * 131 + str.charCodeAt(start + i)) >>> 0;
            }
            return h;
        }

        // Builds the SHIFT table (how far we can safely jump ahead) and the
        // HASH table (candidate patterns ending at a given block) from the
        // current pattern set. Must run once before search()/hasMatch().
        build() {
            this.shiftTable = new Map();
            this.hashTable = new Map();
            if (this.patterns.length === 0) {
                this.built = true;
                return;
            }

            this.minLen = Math.min(...this.patterns.map(p => p.length));
            const m = this.minLen;

            // Dynamically set block size B and prefix size P based on shortest pattern
            this.blockSize = m >= 2 ? 2 : 1;
            this.prefixSize = Math.min(2, m);

            const B = this.blockSize;
            const P = this.prefixSize;
            this.defaultShift = m - B + 1;

            for (const pat of this.patterns) {
                // 1. Compute SHIFT table entries for sub-blocks within the first 'm' characters
                for (let i = 0; i <= m - B; i++) {
                    const hash = this._hashBlock(pat, i, B);
                    const shift = m - B - i;
                    if (!this.shiftTable.has(hash) || shift < this.shiftTable.get(hash)) {
                        this.shiftTable.set(hash, shift);
                    }
                }

                // 2. Compute suffix block hash (at end of window m) and prefix block hash (at start)
                const lastHash = this._hashBlock(pat, m - B, B);
                const prefixHash = this._hashBlock(pat, 0, P);

                if (!this.hashTable.has(lastHash)) {
                    this.hashTable.set(lastHash, []);
                }

                // Store pattern along with its precomputed prefix hash
                const bucket = this.hashTable.get(lastHash);
                if (!bucket.some(item => item.pat === pat)) {
                    bucket.push({ pat, prefixHash });
                }
            }
            this.built = true;
        }

        // Core scan loop shared by search()/hasMatch(). Walks the text in
        // SHIFT-table jumps and calls onMatch(pattern, index) for each hit;
        // onMatch can return true to stop the scan early (used by hasMatch).
        _scan(text, wholeWord, onMatch) {
            if (!this.built) this.build();
            if (this.patterns.length === 0) return;

            const searchText = this.caseSensitive ? text : text.toLowerCase();
            const n = searchText.length;
            const m = this.minLen;
            const B = this.blockSize;
            const P = this.prefixSize;

            if (n < m) return;

            let pos = m - 1;
            while (pos < n) {
                const blockStart = pos - B + 1;
                const hash = this._hashBlock(searchText, blockStart, B);
                const shift = this.shiftTable.has(hash) ? this.shiftTable.get(hash) : this.defaultShift;

                if (shift === 0) {
                    const windowStart = pos - m + 1;

                    // --- PREFIX OPTIMIZATION ---
                    // Hash the prefix at the start of the current candidate window
                    const currentPrefixHash = this._hashBlock(searchText, windowStart, P);
                    const candidates = this.hashTable.get(hash) || [];

                    for (const candidate of candidates) {
                        // 1. FAST CHECK: Skip immediately if prefix hash doesn't match
                        if (candidate.prefixHash !== currentPrefixHash) continue;

                        const pat = candidate.pat;
                        const end = windowStart + pat.length;
                        if (end > n) continue;

                        // 2. FULL VERIFICATION: String check only after prefix passes
                        if (searchText.startsWith(pat, windowStart)) {
                            if (wholeWord) {
                                const before = windowStart > 0 ? searchText[windowStart - 1] : ' ';
                                const after = end < n ? searchText[end] : ' ';
                                if (/\w/.test(before) || /\w/.test(after)) continue;
                            }
                            if (onMatch(pat, windowStart)) return;
                        }
                    }
                    pos += 1;
                } else {
                    pos += shift;
                }
            }
        }

        // Returns every match as { keyword, index }.
        search(text, wholeWord = false) {
            const matches = [];
            this._scan(text, wholeWord, (pat, index) => {
                matches.push({ keyword: pat, index });
                return false;
            });
            return matches;
        }

        // Cheap short-circuit version of search() — stops at the first hit.
        hasMatch(text, wholeWord = false) {
            let found = false;
            this._scan(text, wholeWord, () => {
                found = true;
                return true;
            });
            return found;
        }
    }

    VeilText.Algorithms.WuManber = WuManber;
})(window.VeilText);
