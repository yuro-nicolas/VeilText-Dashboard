// ─── MATCHER STATE ───────────────────────────────────────────────────────────
//
// Holds the "live" pattern-matching engine (Aho-Corasick or Wu-Manber),
// the built-in default lexicon fetched from data/default_lexicon.json, and
// the "include list" (words the user has explicitly allowed even though a
// blocked keyword is a substring of them, e.g. "class" containing "ass").
(function (VeilText) {
    'use strict';

    const Config = VeilText.Config;

    let defaultLexicon = [];
    let matcher = VeilText.Algorithms.createMatcher('ahocorasick', false);
    let includeSet = new Set();

    // Fetches the bundled default profanity/slur lexicon shipped with the
    // extension (data/default_lexicon.json). Failure just means the user's
    // own custom keyword list still works — it's not fatal.
    async function loadDefaultLexicon() {
        try {
            const res = await fetch(chrome.runtime.getURL('data/default_lexicon.json'));
            const data = await res.json();
            defaultLexicon = Array.isArray(data) ? data : [];
        } catch (e) {
            console.warn('VeilText: Failed to load default lexicon', e);
            defaultLexicon = [];
        }
    }

    // Rebuilds the matcher from scratch using the currently configured
    // algorithm + case sensitivity + keyword lists. Call this whenever the
    // algorithm, case sensitivity, or keyword lists change.
    function rebuildAutomaton() {
        const CONFIG = Config.get();
        matcher = VeilText.Algorithms.createMatcher(CONFIG.algorithm, CONFIG.caseSensitive);

        const allKeywords = [...defaultLexicon, ...(CONFIG.keywords || [])];
        for (const kw of allKeywords) {
            if (kw && kw.trim()) matcher.addKeyword(kw);
        }
        matcher.build();

        includeSet = new Set(
            (CONFIG.includeKeywords || [])
                .map(w => (w || '').trim().toLowerCase())
                .filter(Boolean)
        );
    }

    // True when the filter is on AND there's actually something to look for
    // (either the bundled lexicon or the user's own blocked keywords).
    function hasActiveKeywords() {
        const CONFIG = Config.get();
        return CONFIG.filterEnabled &&
            (defaultLexicon.length > 0 || (CONFIG.keywords && CONFIG.keywords.length > 0));
    }

    VeilText.State.loadDefaultLexicon = loadDefaultLexicon;
    VeilText.State.rebuildAutomaton = rebuildAutomaton;
    VeilText.State.hasActiveKeywords = hasActiveKeywords;
    VeilText.State.getMatcher = () => matcher;
    VeilText.State.getIncludeSet = () => includeSet;
})(window.VeilText);
