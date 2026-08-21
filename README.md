# VeilText Profanity Filter

A browser extension that performs **real-time, client-side detection and filtering**
of undesired textual web content, powered by a **switchable multi-pattern string
matching engine** - choose between **Aho-Corasick** and **Wu-Manber**. All processing
occurs locally on your device, no data is ever sent to an external server.

---

## Algorithms

The filter ships with two interchangeable matching engines. Both scan the same
page text against the same keyword list and produce identical redaction results;
they differ only in *how* the matching is computed, which makes them directly
comparable for benchmarking.

### Aho-Corasick - O(n + m + z)

- **n** = length of input text, **m** = total length of all keywords, **z** = number of matches

1. **Trie Construction** - All keywords are inserted into a prefix trie. Each node
   stores child transitions and output (matched keyword) information.
2. **Failure Link Computation (BFS)** - Failure (suffix) links are computed via a
   breadth-first traversal so the automaton can recover from mismatches without
   returning to the root, enabling a single-pass search.
3. **Linear Search** - Text is scanned character-by-character in one pass. Matches
   are collected and the DOM is surgically updated to apply the selected filter mode.

### Wu-Manber - average sub-linear, block-hash based

1. **Block Preprocessing** - Using `m`, the length of the *shortest* keyword, and a
   block size `B` (2 characters where possible), every keyword contributes hashed
   blocks from its first `m` characters.
2. **SHIFT Table** - Maps each block hash to the minimum safe distance the scanner
   can jump forward without missing a possible match, letting the search skip over
   large stretches of text that can't contain any keyword.
3. **HASH Table + Verification** - When a lookup returns a shift of zero, the block
   might be the tail of a real match. The HASH table lists candidate keywords for
   that block, which are then verified directly against the text.

Both engines respect the same **case sensitivity** and **whole-word matching**
settings, so switching the toggle in Settings changes only the underlying search
strategy, not the filtering behavior.

---

## Project Structure

```
Thesis-VeilText-testing/
├── manifest.json           # Extension manifest (permissions, content script list)
├── background.js           # Service worker: install defaults, tab injection, link pre-scan fetch
├── early-hide.js           # document_start overlay that hides the page briefly to avoid a flash of unfiltered content
├── popup.html / .css / .js # Settings popup UI
├── data/
│   ├── default_lexicon.json     # Built-in blocked-word list shipped with the extension
│   └── build_default_lexicon.py # Script that regenerates default_lexicon.json from data/raw/*
└── src/
    ├── namespace.js         # Declares the shared window.VeilText namespace (load first)
    ├── algorithms/           # Pattern-matching engines, isolated from all DOM/config code
    │   ├── aho-corasick.js
    │   ├── wu-manber.js
    │   └── matcher-factory.js
    └── content/              # The rest of the content script, one concern per file
        ├── config.js         # Loads/merges/exposes user settings
        ├── state.js           # Holds the live matcher + include-list + default lexicon
        ├── dom-utils.js        # Shared DOM predicates (isHidden, isEditableContext, ...)
        ├── filter-engine.js     # Finds + redacts blocked text in the DOM
        ├── reveal-ui.js          # The redacted <span> itself + click-to-reveal popover
        ├── page-warning.js        # Full-page "flagged content" interstitial
        ├── link-scanner.js         # Pre-checks outbound links before navigating
        ├── observer.js              # MutationObserver, shadow DOM, SPA route changes
        ├── messaging.js              # Reacts to popup/storage config changes live
        ├── styles.js                  # One shared <style> tag for the hover outline
        └── main.js                     # Entry point; wires the above together
```

The content script is deliberately **not** built as ES modules — Chrome loads
each file in `manifest.json`'s `content_scripts[].js` array as a plain
classic script, in order, inside one shared "isolated world" per page. Every
file attaches its exports to `window.VeilText.<Namespace>` (see
`src/namespace.js`) instead of using top-level `import`/`export`, so there's
no bundler step required — you can load the extension unpacked as-is.
`background.js` keeps its own copy of that same file list so it can inject
the same set of scripts into already-open tabs (see "Activation" below).

---

## Activation & Toggle Behavior

- **First install:** the master toggle starts **OFF**. `background.js`'s
  `chrome.runtime.onInstalled` handler seeds `chrome.storage.local` with
  `filterEnabled: false` before anything else runs, so the first page a new
  user sees is never unexpectedly redacted.
- **After that:** whichever state you leave the master toggle in — on or off
  — is what it stays in, including after closing and reopening the browser.
  This isn't a special "remember last state" feature; it's simply because
  every toggle change is written to `chrome.storage.local` immediately
  (`popup.js` → `saveSettings()`), and that storage is what both the popup
  and the content script read from on every load.
- **Works on already-open tabs without a refresh:** on install (and on
  update/reload of the extension), `background.js` uses
  `chrome.scripting.executeScript` to inject the content script files
  directly into every currently open, injectable tab (`http(s)://` and
  `file://` URLs — browser-internal pages like `chrome://` can't be
  injected into and are skipped). This means you don't have to manually
  reload a tab that was already open before you installed or reloaded the
  extension.

---

## Installation

1. Clone or download this repository.
2. Open **Chrome** and navigate to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the extension folder.

---

## Features

| Feature | Description |
|---|---|
| **Dual-algorithm engine** | Toggle between Aho-Corasick and Wu-Manber from Settings |
| **3 filter modes** | Blur, Hide, or Replace matched text |
| **Quick-add** | Add one or more custom blocked keywords from the popup quickly |
| **Auto-Duplicate removal** | Checks for duplicate keywords automatically |
| **Include allowlist** | Mark specific words as always-allowed, overriding both the built-in lexicon and your custom blocked keywords |
| **Click-to-reveal, with a warning** | Clicking redacted text shows a content warning; confirming reveals the original text, and clicking again hides it |
| **Live DOM observation** | MutationObserver re-scans dynamically loaded content |
| **Case-sensitivity toggle** | Exact or case-insensitive matching |
| **Whole word matching** | Only redacts exact word matches |
| **Page load & link warnings** | Optional overlays warn before viewing a flagged page or following a flagged link |
| **Privacy-first** | Zero external requests for filtering; all processing is local |

---

## Default Lexicon

The extension includes a predefined English profanity lexicon generated by
merging three publicly available datasets into a single deduplicated keyword
list. The resulting lexicon serves as the extension's default set of blocked
terms and can be supplemented or overridden with custom keywords and allowlist
entries through the extension's settings.

The default lexicon is built from the following sources:

1. **Surge AI Profanity Dataset**  
   Available at: https://huggingface.co/datasets/mmathys/profanity  
   A curated lexicon containing over 1,600 English profanities and their
   variations compiled by Surge AI.

2. **List of Dirty, Naughty, Obscene, and Otherwise Bad Words**  
   Available at: https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words  
   An open-source profanity lexicon originally derived from the Shutterstock
   banned-word list and expanded through community contributions.

3. **Google Profanity Words List**  
   Available at: https://github.com/coffee-and-fun/google-profanity-words  
   A comprehensive list of commonly filtered offensive terms that is widely
   used in profanity detection and content moderation applications.

4. **Swear Words Used by Filipino: A Case Study**  
   Available at: https://www.researchgate.net/publication/397749432_Swear_Words_Used_by_Filipino_A_Case_Study  
   A study documenting Filipino/Tagalog swear words and their usage among Filipinos. Its inclusion helps the default lexicon represent undesired language commonly used in the Philippine context, complementing the English-language profanity sources.

---
