// ─── CONFIG ──────────────────────────────────────────────────────────────────
//
// Single source of truth for user settings on this page. Settings are
// persisted in chrome.storage.local under the "textguard_config" key and are
// shared with popup.js, which reads/writes the exact same key.
//
(function (VeilText) {
    'use strict';

    const DEFAULT_CONFIG = {
        keywords: [],
        includeKeywords: [],
        filterEnabled: true,
        filterMode: 'blur',
        replacementText: '█████',
        caseSensitive: false,
        wholeWord: true,
        linkScanEnabled: false,
        pageScanWarning: false,
        revealOnClick: true,
        algorithm: 'ahocorasick'        // 'ahocorasick' | 'wumanber'
    };

    let CONFIG = { ...DEFAULT_CONFIG };

    // Loads persisted settings from storage, merging over the defaults so
    // any newly-added setting still gets a sane value for existing users.
    async function load() {
        try {
            const result = await chrome.storage.local.get(['textguard_config']);
            if (result.textguard_config) {
                CONFIG = { ...DEFAULT_CONFIG, ...result.textguard_config };
            }
        } catch (e) {
            console.warn('VeilText: Failed to load config', e);
        }
        return CONFIG;
    }

    // Merges a partial config (e.g. from a runtime message or a
    // storage.onChanged event) into the live CONFIG object in place.
    function merge(partial) {
        CONFIG = { ...CONFIG, ...partial };
        return CONFIG;
    }

    function get() {
        return CONFIG;
    }

    VeilText.Config.DEFAULT_CONFIG = DEFAULT_CONFIG;
    VeilText.Config.load = load;
    VeilText.Config.merge = merge;
    VeilText.Config.get = get;
})(window.VeilText);
