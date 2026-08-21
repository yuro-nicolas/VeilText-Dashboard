// ─── ENTRY POINT ──────────────────────────────────────────────────────────────
//
// Wires all the other content-script modules together and kicks things off.
// Runs at document_idle (see manifest.json), after early-hide.js has already
// briefly hidden the page at document_start to avoid a flash of unfiltered
// content (see early-hide.js for that mechanism).
(function (VeilText) {
    'use strict';

    const Config = VeilText.Config;
    const State = VeilText.State;
    const FilterEngine = VeilText.FilterEngine;

    // Patches history.pushState/replaceState immediately (not gated on
    // DOMContentLoaded) so SPA navigations are never missed even if they
    // happen before the rest of init() has run.
    VeilText.Observer.hookHistoryChanges();

    async function init() {
        await Promise.all([Config.load(), State.loadDefaultLexicon()]);
        State.rebuildAutomaton();
        FilterEngine.processPage();

        // Tells early-hide.js's overlay it's safe to reveal the page now
        // that the first pass of filtering is complete.
        document.dispatchEvent(new CustomEvent('textguard:reveal'));

        VeilText.Observer.observePageChanges();
        if (document.readyState !== 'complete') {
            window.addEventListener('load', FilterEngine.processPage, { once: true });
        }

        VeilText.LinkScanner.initLinkScanner();

        const CONFIG = Config.get();
        if (CONFIG.pageScanWarning && State.hasActiveKeywords()) {
            VeilText.PageWarning.showPageWarningIfNeeded();
        }
    }

    function startup() {
        VeilText.Styles.injectStyles();
        VeilText.Messaging.wireListeners();
        init();
        VeilText.Observer.scanShadowRoots(document.body);

        // Periodic light-weight sweep: catches sites that mutate captions/
        // widgets in ways the MutationObserver's debounce can miss, and
        // occasionally re-checks for newly attached shadow roots.
        setInterval(() => {
            VeilText.Observer.processSpecialWidgets();
            if (Math.random() > 0.8) VeilText.Observer.scanShadowRoots(document.body);
        }, 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startup, { once: true });
    } else {
        startup();
    }
})(window.VeilText);
