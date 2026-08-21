// ─── MUTATION OBSERVER + SHADOW DOM + SPA NAVIGATION ─────────────────────────
//
// Keeps the filter applied as the page changes after the initial scan:
// watches for DOM mutations (batched/debounced so a flurry of changes only
// triggers one re-scan), walks into shadow roots (some sites render captions
// or comments inside them), periodically re-checks a short list of known
// "special" caption/subtitle widgets, and detects SPA route changes via
// history.pushState/replaceState so a client-side navigation gets rescanned
// like a real page load would.
(function (VeilText) {
    'use strict';

    const Config = VeilText.Config;
    const State = VeilText.State;
    const FilterEngine = VeilText.FilterEngine;
    const { SKIP_TAGS, LINK_SELECTOR, isEditableContext } = VeilText.DomUtils;

    let observer = null;

    // Watches `target` for added nodes / text changes and re-scans just the
    // affected nodes (not the whole page) after a short debounce window.
    function observePageChanges(target = document.body) {
        const CONFIG = Config.get();
        if (!target || !CONFIG.filterEnabled) return;

        let pendingNodes = [];
        let pendingTimestamps = [];
        let flushTimer = null;

        const flush = () => {
            const nodes = pendingNodes.splice(0);
            const times = pendingTimestamps.splice(0);

            const uniqueNodes = nodes.filter((n, i, arr) =>
                !arr.some(other => other !== n && other.contains && other.contains(n))
            );

            let mutationCount = 0;
            const liveConfig = Config.get();

            for (let i = 0; i < uniqueNodes.length; i++) {
                const node = uniqueNodes[i];
                // Time from when this mutation was first observed (before
                // the debounce window) to right now, i.e. the real
                // end-to-end delay between content appearing and this pass
                // finishing with it. Used only for the Dashboard's mutation
                // latency figure (see src/content/stats.js).
                const observedAt = times[nodes.indexOf(node)] || performance.now();

                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (isEditableContext(node)) continue;
                    if (node.classList && node.classList.contains('textguard-filtered')) continue;
                    if (node.closest && node.closest('.textguard-filtered')) continue;
                    // Skip nodes added as a side effect of this extension's own
                    // redaction (e.g. the filler-text siblings a replaceChild()
                    // swap leaves next to a new <span class="textguard-filtered">).
                    // Those aren't newly-arrived page content -- without this
                    // check they'd fire a second, spurious recordLatency call
                    // for the same original mutation (see filterTextNode() /
                    // processLinkText(), which both set data-textguard-processed
                    // on the parent at the moment of redaction).
                    if (node.parentElement && node.parentElement.dataset && node.parentElement.dataset.textguardProcessed) continue;
                    mutationCount += FilterEngine.processNode(node);
                    const linkAncestor = node.closest && node.closest(LINK_SELECTOR);
                    if (linkAncestor) mutationCount += FilterEngine.processLinkText(linkAncestor);
                } else if (node.nodeType === Node.TEXT_NODE) {
                    const parent = node.parentElement;
                    if (!parent) continue;
                    if (SKIP_TAGS.has(parent.tagName)) continue;
                    if (isEditableContext(parent)) continue;
                    if (parent.classList && parent.classList.contains('textguard-filtered')) continue;
                    if (parent.closest && parent.closest('.textguard-filtered')) continue;
                    // Same rationale as the ELEMENT_NODE branch above: a
                    // redaction's replaceChild() leaves plain filler-text
                    // siblings next to the new span, and those siblings' own
                    // insertion is picked up as a second mutation on this same
                    // parent. The parent already carries this flag (set by
                    // filterTextNode()/processLinkText() at redaction time),
                    // so skip re-processing and re-timing content that was
                    // never actually new.
                    if (parent.dataset && parent.dataset.textguardProcessed) continue;
                    if (FilterEngine.hasBlockedMatch(node.textContent, liveConfig.wholeWord)) {
                        mutationCount += FilterEngine.filterTextNode(node);
                    }
                    const linkAncestor = parent.closest && parent.closest(LINK_SELECTOR);
                    if (linkAncestor) mutationCount += FilterEngine.processLinkText(linkAncestor);
                }

                if (VeilText.Stats) VeilText.Stats.recordLatency(performance.now() - observedAt, liveConfig.algorithm);
            }

            if (mutationCount > 0) {
                VeilText.Messaging.notifyStats(0, 0);
                if (VeilText.Stats) VeilText.Stats.recordMutationRedaction(liveConfig.algorithm, mutationCount);
                if (liveConfig.pageScanWarning && State.hasActiveKeywords()) {
                    VeilText.PageWarning.showPageWarningIfNeeded();
                }
            }
        };

        const obs = new MutationObserver((mutations) => {
            if (!State.hasActiveKeywords()) return;

            const now = performance.now();
            let needsFlush = false;

            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    mutation.addedNodes.forEach(node => {
                        pendingNodes.push(node);
                        pendingTimestamps.push(now);
                    });
                    needsFlush = true;
                }
                if (mutation.type === 'characterData') {
                    pendingNodes.push(mutation.target);
                    pendingTimestamps.push(now);
                    needsFlush = true;
                }
            }

            if (needsFlush) {
                clearTimeout(flushTimer);
                flushTimer = setTimeout(flush, 40);
            }
        });

        obs.observe(target, {
            childList: true,
            subtree: true,
            characterData: true,
        });

        observer = obs;
    }

    // A short, curated list of caption/subtitle widgets on popular sites
    // that re-render their text nodes in ways the mutation observer can miss
    // (e.g. reusing the same node and mutating deeply nested text rapidly).
    const SPECIAL_SELECTORS = [
        '.ytp-caption-segment',
        '.captions-text',
        '.ytp-videowall-still-info',
        '[role="log"]',
        '.tweet-text',
        '.video-caption-segment'
    ];

    function processSpecialWidgets() {
        if (!State.hasActiveKeywords()) return;
        const CONFIG = Config.get();
        SPECIAL_SELECTORS.forEach(selector => {
            document.querySelectorAll(selector).forEach(el => {
                if (FilterEngine.hasBlockedMatch(el.textContent, CONFIG.wholeWord) &&
                    (!el.dataset.textguardProcessed || el.querySelector('span') === null)) {
                    FilterEngine.processNode(el);
                }
            });
        });
    }

    // Recursively finds open shadow roots under `root`, scans them once, and
    // attaches their own mutation observer (shadow DOM subtrees aren't
    // visible to an observer on the light DOM).
    function scanShadowRoots(root) {
        if (!root) return;
        if (root.shadowRoot) {
            FilterEngine.processNode(root.shadowRoot);
            observePageChanges(root.shadowRoot);
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
        while (walker.nextNode()) {
            const el = walker.currentNode;
            if (el.shadowRoot) {
                FilterEngine.processNode(el.shadowRoot);
                observePageChanges(el.shadowRoot);
            }
        }
    }

    // Single-page apps swap content via history.pushState/replaceState
    // instead of a real navigation, so the mutation observer alone can miss
    // a full route change. Patches both methods to detect a URL change and
    // trigger a fresh full-page rescan shortly after.
    //
    // Debounced (not just delayed): SPA frameworks -- Facebook and Reddit
    // both do this heavily -- frequently fire several pushState/replaceState
    // calls in quick succession for what a user perceives as one navigation
    // (internal routing steps, redirects, modal-open pseudo-routes). Without
    // cancelling a still-pending timer before scheduling a new one, each of
    // those calls independently reset tracking state (lastLogRowUrl,
    // pageMutationLatency) and triggered its own rescan, racing against each
    // other -- observed directly to cause fragmented/duplicate log rows and
    // redactions being attributed to the wrong (or no) row, with scan
    // time/characters missing on rows a race left without a completed scan
    // behind them. Same debounce pattern already used for config-change
    // reprocessing in messaging.js's scheduleReprocess().
    function hookHistoryChanges() {
        let lastUrl = location.href;
        let navTimer = null;
        const onUrlChange = () => {
            const currentUrl = location.href;
            if (currentUrl === lastUrl) return;
            lastUrl = currentUrl;
            clearTimeout(navTimer);
            navTimer = setTimeout(() => {
                navTimer = null;
                if (VeilText.Stats) VeilText.Stats.resetPageTracking();
                VeilText.Messaging.resetAndReprocess();
                VeilText.PageWarning.resetShownFlag();
                const CONFIG = Config.get();
                if (CONFIG.pageScanWarning && State.hasActiveKeywords()) {
                    VeilText.PageWarning.showPageWarningIfNeeded();
                }
            }, 600);
        };
        const pushState = history.pushState;
        const replaceState = history.replaceState;
        history.pushState = function () { pushState.apply(this, arguments); onUrlChange(); };
        history.replaceState = function () { replaceState.apply(this, arguments); onUrlChange(); };
        window.addEventListener('popstate', onUrlChange);
    }

    VeilText.Observer.observePageChanges = observePageChanges;
    VeilText.Observer.processSpecialWidgets = processSpecialWidgets;
    VeilText.Observer.scanShadowRoots = scanShadowRoots;
    VeilText.Observer.hookHistoryChanges = hookHistoryChanges;
})(window.VeilText);
