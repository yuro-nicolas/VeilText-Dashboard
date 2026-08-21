// ─── SHARED NAMESPACE ────────────────────────────────────────────────────────
//
// The content script is split across several files (see manifest.json's
// content_scripts["js"] list) so no single file gets too large to navigate.
// Chrome loads them as plain classic scripts, one after another, inside the
// same "isolated world" for the page — they are NOT ES modules. That means
// every file shares one global scope, and this is the first file loaded.
//
// Instead of every module dumping functions onto the raw global scope (where
// names could collide), each module attaches itself as a named property of
// this single `VeilText` object, e.g. `VeilText.Algorithms.AhoCorasick`,
// `VeilText.Config`, `VeilText.FilterEngine`, etc. Keep this file first in
// manifest.json's content script list so the namespace exists before anyone
// else tries to write to it.
window.VeilText = window.VeilText || {
    Algorithms: {},
    Config: {},
    State: {},
    DomUtils: {},
    FilterEngine: {},
    RevealUI: {},
    PageWarning: {},
    LinkScanner: {},
    Observer: {},
    Messaging: {},
    Styles: {},
    Stats: {}
};
