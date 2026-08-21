// ─── STYLES ───────────────────────────────────────────────────────────────────
//
// A tiny stylesheet injected once per document for the hover outline on
// redacted spans. Kept separate from inline styles (set per-span in
// reveal-ui.js) because a hover state can't easily be expressed inline.
(function (VeilText) {
    'use strict';

    function injectStyles() {
        if (document.getElementById('textguard-styles')) return;
        const root = document.head || document.documentElement;
        if (!root) return;
        const style = document.createElement('style');
        style.id = 'textguard-styles';
        style.textContent = `.textguard-filtered { display:inline; position:relative; cursor:pointer; transition:outline 0.15s ease; }
        .textguard-filtered:hover { outline: 1px dashed rgba(107,124,79,0.6); }
        .textguard-filtered.textguard-no-reveal:hover { outline: none; }`;
        root.appendChild(style);
    }

    VeilText.Styles.injectStyles = injectStyles;
})(window.VeilText);
