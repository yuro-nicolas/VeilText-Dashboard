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

    VeilText.DomUtils.SKIP_TAGS = SKIP_TAGS;
    VeilText.DomUtils.LINK_SELECTOR = LINK_SELECTOR;
    VeilText.DomUtils.MEDIA_SELECTOR = MEDIA_SELECTOR;
    VeilText.DomUtils.containsMedia = containsMedia;
    VeilText.DomUtils.isEditableContext = isEditableContext;
    VeilText.DomUtils.isHidden = isHidden;
    VeilText.DomUtils.getVisibleText = getVisibleText;
})(window.VeilText);
