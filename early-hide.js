// ─── EARLY-HIDE OVERLAY ──────────────────────────────────────────────────────
//
// Runs at document_start (before the page has rendered anything), i.e.
// before src/content/main.js has even loaded. Its only job is to cover the
// page with a plain white/dark overlay for a brief moment so the user never
// sees a "flash of unfiltered content" — the real filtering in main.js takes
// a beat to load config, load the lexicon, build the matcher, and scan the
// page, and without this overlay the page would render normally and then
// suddenly get redacted a fraction of a second later.
//
// The overlay lifts as soon as either: (a) main.js dispatches a
// "textguard:reveal" event once its first scan pass is done, (b) this
// script's own quick storage check finds the filter is off / has no custom
// keywords, so there's nothing to wait for, or (c) MAX_HIDE_MS elapses as a
// safety net so a slow/broken page never gets stuck hidden.
(function () {
    'use strict';

    let revealed = false;
    const MAX_HIDE_MS = 700;

    const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const overlayBg = isDarkMode ? '#1a1a1a' : '#ffffff';

    const overlay = document.createElement('div');
    overlay.id = 'textguard-early-hide-overlay';
    overlay.style.cssText = `
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        background: ${overlayBg};
        pointer-events: all;
    `;

    function mountOverlay() {
        if (revealed) return;
        (document.body || document.documentElement).appendChild(overlay);
    }

    if (document.body) {
        mountOverlay();
    } else {
        const bodyWatcher = new MutationObserver(() => {
            if (document.body) {
                mountOverlay();
                bodyWatcher.disconnect();
            }
        });
        bodyWatcher.observe(document.documentElement, { childList: true });
    }

    function reveal() {
        if (revealed) return;
        revealed = true;
        overlay.remove();
    }

    setTimeout(reveal, MAX_HIDE_MS);

    chrome.storage.local.get(['textguard_config'], (result) => {
        const cfg = result.textguard_config;
        // Only the master filter toggle is a reliable "nothing to filter"
        // signal here. The bundled default lexicon is always active
        // whenever filtering is on, even with zero custom keywords, and
        // this script runs too early (document_start) to cheaply check
        // that file's contents itself -- so an empty custom keyword list
        // does NOT mean there's nothing for the real scan to find.
        if (!cfg || !cfg.filterEnabled) {
            reveal();
        }
    });

    document.addEventListener('textguard:reveal', reveal);
})();
