// ─── DOM HELPERS ─────────────────────────────────────────────────────────────
//
// Small, page-content-agnostic helpers shared by the filter engine, the
// mutation observer, and the link scanner: which elements to skip, whether
// something is currently visible, whether it's real media (never touched —
// this extension is text-only), and how to read an element's combined
// visible text.
(function (VeilText) {
    'use strict';

    // Elements whose text should never be scanned/redacted (scripts, form
    // controls, code blocks, etc.).
    const SKIP_TAGS = new Set([
        'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'TEXTAREA', 'INPUT',
        'SELECT', 'BUTTON', 'CODE', 'PRE', 'HEAD', 'META', 'LINK'
    ]);

    // Some sites (Facebook's feed is the classic case) render visible text as
    // several nested spans per link — e.g. one span per word/character for
    // animation or anti-scraping reasons — instead of one contiguous text
    // node. Per-text-node scanning can't see a keyword split across that
    // boundary even though it reads as one word/phrase on screen. This
    // selector feeds the link-level fallback pass in filter-engine.js.
    const LINK_SELECTOR = 'a[href], [role="link"]';

    // This extension is strictly textual: it must never touch actual media
    // content (photos, video, audio, embeds). Used to detect when a link
    // contains real media so it never gets wiped out.
    const MEDIA_SELECTOR = 'img, video, audio, picture, svg, canvas, iframe';

    function containsMedia(el) {
        return !!(el.querySelector && el.querySelector(MEDIA_SELECTOR));
    }

    function isEditableContext(el) {
        return !!(el.closest && el.closest('[contenteditable]:not([contenteditable="false"])'));
    }

    // Best-effort "is this actually visible to a reader right now" check.
    // Used to avoid redacting text that's already invisible (so it can't
    // ever leak on reveal) and to avoid wasting work scanning it.
    function isHidden(el) {
        if (!el || el.nodeType !== 1) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true;
        if (parseFloat(style.opacity) === 0) return true;
        if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
        if (el.hasAttribute && (el.hasAttribute('hidden') || el.hidden)) return true;

        if (el.offsetParent === null && style.position !== 'fixed' && style.position !== 'sticky') {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return true;
        }

        const rect = el.getBoundingClientRect();
        if (rect.width <= 1 && rect.height <= 1 && style.overflow === 'hidden') return true;

        return false;
    }

    // Concatenates the visible text of every text node inside `el`,
    // respecting the same skip/hidden rules as the main scanner. Used to
    // read a link's full combined text (see LINK_SELECTOR above).
    function getVisibleText(el) {
        let text = '';
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
                if (isHidden(parent)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        let node;
        while ((node = walker.nextNode())) text += node.textContent;
        return text;
    }

    // Tags that, if present among an element's direct children, mean that
    // element contains its own nested block-level structure -- so it should
    // NOT be treated as one flat "leaf" of combinable text itself (its
    // children are handled individually, at their own more specific
    // granularity, instead).
    const BLOCK_TAGS = new Set([
        'P', 'DIV', 'LI', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'BLOCKQUOTE', 'FIGCAPTION', 'DT', 'DD', 'UL', 'OL', 'TABLE', 'SECTION', 'ARTICLE'
    ]);

    function hasBlockLevelChild(el) {
        if (!el.children) return false;
        for (const child of el.children) {
            if (BLOCK_TAGS.has(child.tagName)) return true;
        }
        return false;
    }

    // Combines the visible text of every not-yet-processed text-node child
    // of `el` into one string, and returns `parts`: a list of
    // { node, start, end } recording exactly which slice of the combined
    // string came from which original text node. This lets a match found in
    // the combined string be traced back to the real DOM node(s) it spans --
    // needed to catch a blocked word split across inline markup (e.g.
    // <p>bad<strong>word</strong></p>), which per-text-node matching alone
    // cannot see, without disturbing any node the match doesn't touch.
    //
    // No separator is inserted between parts: any whitespace present in the
    // original markup is already part of the text nodes themselves, so
    // direct concatenation reproduces the reader-visible text exactly.
    function flattenTextWithMap(el) {
        const parts = [];
        let combined = '';
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
                if (isEditableContext(parent)) return NodeFilter.FILTER_REJECT;
                if (parent.dataset && parent.dataset.textguardProcessed) return NodeFilter.FILTER_REJECT;
                if (parent.classList && parent.classList.contains('textguard-filtered')) return NodeFilter.FILTER_REJECT;
                if (isHidden(parent)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        let node;
        while ((node = walker.nextNode())) {
            const text = node.textContent;
            if (!text) continue;
            parts.push({ node, start: combined.length, end: combined.length + text.length });
            combined += text;
        }
        return { text: combined, parts };
    }

    // Returns every { node, nodeStart, nodeEnd } that the [start, end) range
    // of a flattenTextWithMap() combined string actually touches, with the
    // range's offsets translated back into each individual node's own
    // local character positions.
    function mapRangeToNodes(parts, start, end) {
        const hits = [];
        for (const p of parts) {
            const s = Math.max(start, p.start);
            const e = Math.min(end, p.end);
            if (s < e) hits.push({ node: p.node, nodeStart: s - p.start, nodeEnd: e - p.start });
        }
        return hits;
    }

    VeilText.DomUtils.SKIP_TAGS = SKIP_TAGS;
    VeilText.DomUtils.LINK_SELECTOR = LINK_SELECTOR;
    VeilText.DomUtils.MEDIA_SELECTOR = MEDIA_SELECTOR;
    VeilText.DomUtils.containsMedia = containsMedia;
    VeilText.DomUtils.isEditableContext = isEditableContext;
    VeilText.DomUtils.isHidden = isHidden;
    VeilText.DomUtils.getVisibleText = getVisibleText;
    VeilText.DomUtils.hasBlockLevelChild = hasBlockLevelChild;
    VeilText.DomUtils.flattenTextWithMap = flattenTextWithMap;
    VeilText.DomUtils.mapRangeToNodes = mapRangeToNodes;
})(window.VeilText);
