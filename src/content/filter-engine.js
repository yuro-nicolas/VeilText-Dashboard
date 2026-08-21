// ─── FILTER ENGINE ───────────────────────────────────────────────────────────
//
// The core "find blocked text in the DOM and redact it" logic: walking text
// nodes, applying the include-list, merging overlapping matches into ranges,
// and swapping matched text for a <span class="textguard-filtered">. This is
// the piece the mutation observer and the initial page scan both call into.
(function (VeilText) {
    'use strict';

    const Config = VeilText.Config;
    const State = VeilText.State;
    const { SKIP_TAGS, LINK_SELECTOR, containsMedia, isEditableContext, isHidden, getVisibleText } = VeilText.DomUtils;

    // Returns the number of redactions actually present in the DOM right now.
    // Used instead of a running counter so the reported count self-corrects
    // whenever the page removes, replaces, or re-renders filtered content
    // (infinite scroll, hydration, SPA route swaps, etc.) rather than only
    // ever accumulating upward.
    function currentFilteredCount() {
        return document.querySelectorAll('.textguard-filtered').length;
    }

    // Expands outward from a match to the full contiguous "word" it sits inside
    // (e.g. for the match "ass" at index 1 of "class", this returns "class").
    // This lets the include/allow list unblock a flagged substring only in the
    // context of a specific larger word (add "class" to unblock "ass" inside
    // "class"), without unblocking that same substring anywhere else it
    // appears (a standalone "ass" stays blocked unless "ass" itself is
    // included). When the match already IS a whole word on its own (e.g.
    // whole-word matching is on, or the flagged text isn't glued to other
    // word characters), this simply returns the matched text itself, which
    // keeps the previous "include the exact keyword" behavior working.
    function getEnclosingWord(text, start, length) {
        const isWordChar = ch => ch !== undefined && /\w/.test(ch);
        let s = start;
        let e = start + length;
        while (s > 0 && isWordChar(text[s - 1])) s--;
        while (e < text.length && isWordChar(text[e])) e++;
        return text.slice(s, e);
    }

    // All matches in `text` after filtering out anything covered by the
    // include list (see getEnclosingWord above).
    function blockedMatches(text, wholeWord) {
        const matcher = State.getMatcher();
        const includeSet = State.getIncludeSet();
        const matches = matcher.search(text, wholeWord);
        if (includeSet.size === 0) return matches;
        return matches.filter(m => {
            const enclosingWord = getEnclosingWord(text, m.index, m.keyword.length).toLowerCase();
            return !includeSet.has(enclosingWord);
        });
    }

    function hasBlockedMatch(text, wholeWord) {
        const matcher = State.getMatcher();
        const includeSet = State.getIncludeSet();
        if (includeSet.size === 0) return matcher.hasMatch(text, wholeWord);
        return blockedMatches(text, wholeWord).length > 0;
    }

    // Merges overlapping/adjacent matches into non-overlapping ranges so
    // "ass" + "asshole" both matching the same span only produces one
    // redacted region instead of two overlapping ones.
    function buildRanges(text, matches) {
        const sorted = matches
            .map(m => ({ start: m.index, end: m.index + m.keyword.length, keyword: m.keyword }))
            .sort((a, b) => a.start - b.start);
        const merged = [];
        for (const m of sorted) {
            if (merged.length === 0) {
                merged.push({ start: m.start, end: m.end, keywords: new Set([m.keyword]) });
            } else {
                const last = merged[merged.length - 1];
                if (m.start < last.end) { last.end = Math.max(last.end, m.end); last.keywords.add(m.keyword); }
                else merged.push({ start: m.start, end: m.end, keywords: new Set([m.keyword]) });
            }
        }
        return merged;
    }

    // Replaces the blocked portions of a single text node with filtered
    // spans, leaving the surrounding text intact. Returns how many ranges
    // were redacted.
    function filterTextNode(textNode) {
        const CONFIG = Config.get();
        const text = textNode.textContent;
        const matches = blockedMatches(text, CONFIG.wholeWord);
        if (matches.length === 0) return 0;
        const ranges = buildRanges(text, matches);
        if (ranges.length === 0) return 0;
        const parent = textNode.parentElement;
        if (!parent) return 0;

        const fragment = document.createDocumentFragment();
        let cursor = 0;
        for (const { start, end, keywords } of ranges) {
            if (cursor < start) fragment.appendChild(document.createTextNode(text.slice(cursor, start)));
            fragment.appendChild(VeilText.RevealUI.createFilteredSpan(text.slice(start, end), keywords));
            cursor = end;
        }
        if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
        parent.dataset.textguardProcessed = 'true';
        parent.replaceChild(fragment, textNode);
        return ranges.length;
    }

    // The tree-walker predicate shared by the full-page scan, the
    // subtree-only scan, and getVisibleText's cousin below: skip
    // script/style/form elements, editable areas, already-processed nodes,
    // hidden nodes, and whitespace-only nodes.
    function acceptTextNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (isEditableContext(parent)) return NodeFilter.FILTER_REJECT;
        if (parent.dataset.textguardProcessed) return NodeFilter.FILTER_REJECT;
        if (parent.classList && parent.classList.contains('textguard-filtered')) return NodeFilter.FILTER_REJECT;
        if (node.textContent.trim().length === 0) return NodeFilter.FILTER_REJECT;
        if (isHidden(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
    }

    // Scans every text node inside `root` and blurs/hides/replaces the ones
    // that match, leaving every non-text node (images, videos, etc.) exactly
    // as-is. This is the safe, "text-only" building block shared by
    // processPage/processNode/processLinkText.
    function filterTextNodesIn(root) {
        const CONFIG = Config.get();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: acceptTextNode });
        const textNodes = [];
        let node;
        while ((node = walker.nextNode())) textNodes.push(node);
        let count = 0;
        for (const textNode of textNodes) {
            if (hasBlockedMatch(textNode.textContent, CONFIG.wholeWord)) count += filterTextNode(textNode);
        }
        return count;
    }

    // Fallback for links whose visible text is split across nested spans
    // (see LINK_SELECTOR note in dom-utils.js): checks the link's *combined*
    // text and, if it matches as a whole even though no single node did,
    // redacts the whole link as one unit.
    function processLinkText(el) {
        if (!el || !State.hasActiveKeywords()) return 0;
        if (isEditableContext(el)) return 0;
        if (el.dataset.textguardProcessed) return 0;
        if (el.querySelector && el.querySelector('.textguard-filtered')) return 0;
        if (isHidden(el)) return 0;

        const CONFIG = Config.get();
        const text = getVisibleText(el);
        if (!text || !text.trim()) return 0;

        const matches = blockedMatches(text, CONFIG.wholeWord);
        if (matches.length === 0) return 0;

        // If this link/element contains real media (a photo, video, embed,
        // etc.), never replace its contents wholesale -- doing so would
        // delete the media itself, and this extension is text-only and must
        // never remove or blur an actual image/video. Fall back to filtering
        // each text node inside it individually instead: any caption/label
        // text next to the media can still get blurred, but the media itself
        // is left completely untouched.
        if (containsMedia(el)) {
            const count = filterTextNodesIn(el);
            if (count > 0) el.dataset.textguardProcessed = 'true';
            return count;
        }

        const keywords = new Set(matches.map(m => m.keyword));
        const span = VeilText.RevealUI.createFilteredSpan(text, keywords);
        el.textContent = '';
        el.appendChild(span);
        el.dataset.textguardProcessed = 'true';
        return 1;
    }

    // Full-page scan: every text node in document.body, plus the link
    // fallback pass. Called once on load and again on SPA route changes.
    function processPage() {
        if (!State.hasActiveKeywords()) return;
        if (!document.body) return;

        const CONFIG = Config.get();
        const t0 = performance.now();
        let charsScanned = 0;

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: acceptTextNode });
        const textNodes = [];
        let node;
        while ((node = walker.nextNode())) textNodes.push(node);

        let pageCount = 0;
        for (const textNode of textNodes) {
            charsScanned += textNode.textContent.length;
            if (hasBlockedMatch(textNode.textContent, CONFIG.wholeWord)) {
                pageCount += filterTextNode(textNode);
            }
        }

        document.querySelectorAll(LINK_SELECTOR).forEach(el => {
            pageCount += processLinkText(el);
        });

        const scanMs = performance.now() - t0;

        // Persist this scan's timing/character-count for the Dashboard
        // (see src/content/stats.js), unconditionally -- even when
        // pageCount is 0 -- so "Scans Run", "Avg. Scan (ms)" and "Total
        // Chars Scanned" there reflect every real scan performed, not only
        // the ones that happened to find a match. Purely additive
        // instrumentation; does not affect on-page filtering.
        if (VeilText.Stats) {
            VeilText.Stats.recordScanResult(pageCount, scanMs, charsScanned, CONFIG.algorithm);
        }

        if (pageCount > 0) {
            VeilText.Messaging.notifyStats(scanMs, charsScanned);
        }
    }

    // Scoped scan used by the mutation observer for newly-added subtrees
    // (cheaper than a full processPage() call).
    function processNode(root) {
        if (!root || !State.hasActiveKeywords()) return 0;
        let count = filterTextNodesIn(root);

        if (root.querySelectorAll) {
            root.querySelectorAll(LINK_SELECTOR).forEach(el => { count += processLinkText(el); });
        }
        if (root.matches && root.matches(LINK_SELECTOR)) {
            count += processLinkText(root);
        }
        return count;
    }

    VeilText.FilterEngine.currentFilteredCount = currentFilteredCount;
    VeilText.FilterEngine.getEnclosingWord = getEnclosingWord;
    VeilText.FilterEngine.blockedMatches = blockedMatches;
    VeilText.FilterEngine.hasBlockedMatch = hasBlockedMatch;
    VeilText.FilterEngine.buildRanges = buildRanges;
    VeilText.FilterEngine.filterTextNode = filterTextNode;
    VeilText.FilterEngine.filterTextNodesIn = filterTextNodesIn;
    VeilText.FilterEngine.processLinkText = processLinkText;
    VeilText.FilterEngine.processPage = processPage;
    VeilText.FilterEngine.processNode = processNode;
})(window.VeilText);
