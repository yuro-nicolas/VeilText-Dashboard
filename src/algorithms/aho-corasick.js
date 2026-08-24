// ─── AHO-CORASICK MULTI-PATTERN MATCHER ─────────────────────────────────────
//
// Classic Aho-Corasick automaton: builds a trie of all blocked keywords plus
// "fail" links (like a trie-flavored KMP), so the whole page text can be
// scanned in a single pass regardless of how many keywords are loaded.
// Good default engine — fast to build, fast to search, easy to reason about.
//
// This file only defines the class and attaches it to the shared
// `VeilText.Algorithms` namespace; it does not touch the DOM or read config.
(function (VeilText) {
    'use strict';

    class AhoCorasick {
        constructor(caseSensitive = false) {
            this.nodes = [{ children: new Map(), fail: 0, output: new Set() }];
            this.built = false;
            this.caseSensitive = caseSensitive;
        }

        _newNode() { return { children: new Map(), fail: 0, output: new Set() }; }

        // Inserts one keyword into the trie. Safe to call repeatedly before build().
        addKeyword(keyword) {
            if (!keyword || keyword.length === 0) return;
            const word = this.caseSensitive ? keyword : keyword.toLowerCase();
            let cur = 0;
            for (const ch of word) {
                if (!this.nodes[cur].children.has(ch)) {
                    this.nodes[cur].children.set(ch, this.nodes.length);
                    this.nodes.push(this._newNode());
                }
                cur = this.nodes[cur].children.get(ch);
            }
            this.nodes[cur].output.add(word);
            this.built = false;
        }

        // Computes fail links + propagates output sets (BFS from the root).
        // Must run once after all keywords are added and before searching.
        build() {
            const queue = [];
            for (const [, childId] of this.nodes[0].children) {
                this.nodes[childId].fail = 0;
                queue.push(childId);
            }
            while (queue.length > 0) {
                const u = queue.shift();
                for (const [ch, v] of this.nodes[u].children) {
                    let fail = this.nodes[u].fail;
                    while (fail !== 0 && !this.nodes[fail].children.has(ch)) fail = this.nodes[fail].fail;
                    const failState = this.nodes[fail].children.get(ch);
                    this.nodes[v].fail = (failState !== undefined && failState !== v) ? failState : 0;
                    for (const word of this.nodes[this.nodes[v].fail].output) this.nodes[v].output.add(word);
                    queue.push(v);
                }
            }
            this.built = true;
        }

        // Returns every match as { keyword, index }. When wholeWord is true,
        // matches glued to another word character on either side are skipped.
        search(text, wholeWord = false) {
            if (!this.built) this.build();
            if (this.nodes.length === 1) return [];
            const matches = [];
            const searchText = this.caseSensitive ? text : text.toLowerCase();
            let state = 0;
            for (let i = 0; i < searchText.length; i++) {
                const ch = searchText[i];
                while (state !== 0 && !this.nodes[state].children.has(ch)) state = this.nodes[state].fail;
                if (this.nodes[state].children.has(ch)) state = this.nodes[state].children.get(ch);
                for (const word of this.nodes[state].output) {
                    const start = i - word.length + 1;
                    if (wholeWord) {
                        const before = start > 0 ? searchText[start - 1] : ' ';
                        const after = i + 1 < searchText.length ? searchText[i + 1] : ' ';
                        if (/\w/.test(before) || /\w/.test(after)) continue;
                    }
                    matches.push({ keyword: word, index: start });
                }
            }
            return matches;
        }

        // Cheap short-circuit version of search() for callers that only need
        // to know "does anything match" (skips collecting every match).
        hasMatch(text, wholeWord = false) {
            if (!this.built) this.build();
            if (this.nodes.length === 1) return false;
            const searchText = this.caseSensitive ? text : text.toLowerCase();
            let state = 0;
            for (let i = 0; i < searchText.length; i++) {
                const ch = searchText[i];
                while (state !== 0 && !this.nodes[state].children.has(ch)) state = this.nodes[state].fail;
                if (this.nodes[state].children.has(ch)) state = this.nodes[state].children.get(ch);
                for (const word of this.nodes[state].output) {
                    if (!wholeWord) return true;
                    const start = i - word.length + 1;
                    const before = start > 0 ? searchText[start - 1] : ' ';
                    const after = i + 1 < searchText.length ? searchText[i + 1] : ' ';
                    if (!/\w/.test(before) && !/\w/.test(after)) return true;
                }
            }
            return false;
        }
    }

    VeilText.Algorithms.AhoCorasick = AhoCorasick;
})(window.VeilText);
