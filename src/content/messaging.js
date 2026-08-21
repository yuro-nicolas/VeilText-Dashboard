// ─── MESSAGING + LIVE RECONFIGURATION ────────────────────────────────────────
//
// Everything involved in reacting to a settings change while the page is
// already open: undoing existing redactions, rebuilding the matcher, and
// re-scanning — plus the two ways a config change reaches this content
// script (a direct runtime message from the popup, and the broadcast
// chrome.storage.onChanged event that reaches every open tab/frame).
(function (VeilText) {
    'use strict';

    const Config = VeilText.Config;
    const State = VeilText.State;
    const FilterEngine = VeilText.FilterEngine;

    function notifyStats(scanMs, charsScanned) {
        const count = FilterEngine.currentFilteredCount();
        try { chrome.runtime.sendMessage({ action: 'updateCount', count, scanMs, charsScanned }); } catch (_) {}
    }

    // Restores original text for every redacted span under `root` (used both
    // for the main document and for any shadow roots we've filtered into).
    function unredactWithinRoot(root) {
        const parents = new Set();
        root.querySelectorAll('.textguard-filtered').forEach(el => {
            if (el.parentNode) parents.add(el.parentNode);
            el.replaceWith(document.createTextNode(el.dataset.original));
        });
        root.querySelectorAll('[data-textguard-processed]').forEach(el => {
            delete el.dataset.textguardProcessed;
        });
        parents.forEach(p => p.normalize());
    }

    function unredactAllShadowRoots(root) {
        if (!root) return;
        if (root.shadowRoot) unredactWithinRoot(root.shadowRoot);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
        while (walker.nextNode()) {
            const el = walker.currentNode;
            if (el.shadowRoot) unredactWithinRoot(el.shadowRoot);
        }
    }

    // Full reset used whenever settings change while a page is open: undoes
    // every existing redaction, rebuilds the matcher from the new config,
    // then re-scans the page from scratch. This is what makes toggling a
    // setting in the popup apply instantly, without reloading the tab.
    function resetAndReprocess() {
        VeilText.RevealUI.removeRevealPopover();

        unredactWithinRoot(document);
        unredactAllShadowRoots(document.body);

        State.rebuildAutomaton();
        FilterEngine.processPage();
        VeilText.Observer.scanShadowRoots(document.body);
    }

    // A single config save from the popup reaches this content script twice:
    // once as a direct 'configUpdated' runtime message (sent only to the active
    // tab, for immediate popup feedback) and once via chrome.storage.onChanged
    // (broadcast to every tab/frame, which is what actually keeps every open
    // tab in sync). Calling resetAndReprocess() from both meant the active
    // tab's page got rescanned twice per toggle, doubling its redaction-log
    // entry. Debouncing collapses whichever of the two arrives first into a
    // single reprocess.
    let reprocessTimer = null;
    function scheduleReprocess() {
        clearTimeout(reprocessTimer);
        reprocessTimer = setTimeout(() => {
            reprocessTimer = null;
            resetAndReprocess();
        }, 50);
    }

    function wireListeners() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'configUpdated') {
                Config.merge(request.config);
                clearTimeout(reprocessTimer);
                reprocessTimer = setTimeout(() => {
                    reprocessTimer = null;
                    resetAndReprocess();
                    sendResponse({ success: true, count: FilterEngine.currentFilteredCount() });
                }, 50);
                return true;
            }
            if (request.action === 'getStats') {
                sendResponse({ count: FilterEngine.currentFilteredCount() });
            }
            return true;
        });

        chrome.storage.onChanged.addListener((changes) => {
            if (!changes.textguard_config) return;
            const newConfig = changes.textguard_config.newValue;
            if (!newConfig) return;
            Config.merge(newConfig);
            scheduleReprocess();
        });
    }

    VeilText.Messaging.notifyStats = notifyStats;
    VeilText.Messaging.resetAndReprocess = resetAndReprocess;
    VeilText.Messaging.scheduleReprocess = scheduleReprocess;
    VeilText.Messaging.wireListeners = wireListeners;
})(window.VeilText);
