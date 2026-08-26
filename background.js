// ─── BACKGROUND SERVICE WORKER ───────────────────────────────────────────────
//
// Three responsibilities:
//   1. On first install, seed storage with a config that starts OFF, so a
//      brand-new install never surprises anyone by redacting the very first
//      page they look at.
//   2. On install/update, inject the content scripts into tabs that are
//      already open, so the extension works immediately instead of only on
//      the next navigation/refresh (see injectIntoExistingTabs below).
//   3. Small message-passing helpers content.js can't do on its own: closing
//      a tab, and fetching a destination page's HTML for the link pre-scan
//      feature (subject to the extension's own CORS-free fetch permissions,
//      which a page-level content script does not have).

// The list of files that make up the "real" content script, in the exact
// order manifest.json's second content_scripts entry loads them in. Kept
// here too so newly-installed/updated tabs can be backfilled with the same
// script set without waiting for a page reload.
const CONTENT_SCRIPT_FILES = [
    'src/namespace.js',

    'src/algorithms/aho-corasick.js',
    'src/algorithms/wu-manber.js',
    'src/algorithms/matcher-factory.js',

    'src/content/config.js',
    'src/content/state.js',
    'src/content/dom-utils.js',
    'src/content/reveal-ui.js',
    'src/content/stats.js',
    'src/content/filter-engine.js',
    'src/content/page-warning.js',
    'src/content/link-scanner.js',
    'src/content/observer.js',
    'src/content/messaging.js',
    'src/content/styles.js',
    'src/content/main.js'
];

// Mirrors src/content/config.js's DEFAULT_CONFIG. filterEnabled starts
// true, so a freshly installed extension filters immediately using
// whatever default lexicon ships with the extension. Once the user changes
// this (in either direction) it's saved back to chrome.storage.local by
// popup.js and simply persists from then on, including across browser
// restarts.
const DEFAULT_CONFIG = {
    keywords: [],
    includeKeywords: [],
    filterEnabled: true,
    filterMode: 'blur',
    replacementText: '█████',
    caseSensitive: false,
    wholeWord: true,
    linkScanEnabled: false,
    pageScanWarning: false,
    revealOnClick: true,
    algorithm: 'ahocorasick'
};

chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install') {
        // Fresh install: nothing in storage yet, so this is safe to set
        // unconditionally. (If something did race in first, don't clobber it.)
        const existing = await chrome.storage.local.get(['textguard_config']);
        if (!existing.textguard_config) {
            await chrome.storage.local.set({ textguard_config: DEFAULT_CONFIG });
        }
    }

    // Inject into tabs that were already open before install/update/reload,
    // so the extension is active immediately rather than only after the
    // user manually refreshes each tab. See injectIntoExistingTabs() below
    // for the restricted-URL handling.
    await injectIntoExistingTabs();
});

// chrome.scripting can't inject into browser-internal pages, the Chrome Web
// Store, or other extensions' pages — attempting to do so just throws, which
// we swallow per-tab so one restricted tab doesn't stop the rest.
function isInjectableUrl(url) {
    if (!url) return false;
    return /^https?:\/\//i.test(url) || url.startsWith('file://');
}

async function injectIntoExistingTabs() {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        if (!tab.id || !isInjectableUrl(tab.url)) continue;
        try {
            // early-hide.js is skipped here on purpose: its whole job is to
            // paper over the flash of unfiltered content between
            // document_start and the real scan finishing, which is only
            // relevant on a fresh navigation. For an already-loaded tab the
            // page is already visible, so we go straight to the real filter.
            await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                files: CONTENT_SCRIPT_FILES
            });
        } catch (e) {
            // Expected for tabs we don't have permission on, or that
            // navigated away between query() and executeScript(). Not fatal.
        }
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'closeTab') {
        if (sender.tab && sender.tab.id) {
            chrome.tabs.remove(sender.tab.id);
        }
    }

    // Fetches a destination page's HTML on behalf of a content script (used
    // by the link pre-scan warning in src/content/link-scanner.js).
    if (request.action === 'prescanUrl') {
        (async () => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), request.timeoutMs || 4000);

            // Caps how many bytes of the response body this will ever read,
            // regardless of what Content-Length claims (or doesn't claim --
            // a chunked response has none). Reading via a stream instead of
            // resp.text() lets this stop partway through an oversized body
            // instead of first buffering the whole thing.
            const MAX_BYTES = 5 * 1024 * 1024; // 5 MB is generous for a text page

            try {
                const resp = await fetch(request.url, {
                    signal: controller.signal,
                    credentials: 'omit',
                    redirect: 'follow'
                });
                // clearTimeout intentionally NOT called here -- the timeout
                // needs to stay armed through the body read below too, not
                // just until headers arrive. A destination that returns
                // valid headers immediately and then streams its body
                // slowly would otherwise be free to keep this fetch open
                // indefinitely once headers alone had cleared the timer.

                if (!resp.ok) {
                    sendResponse({ ok: false, reason: `http_${resp.status}` });
                    return;
                }
                const contentType = resp.headers.get('content-type') || '';
                if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
                    sendResponse({ ok: false, reason: 'non_text_content' });
                    return;
                }

                const reader = resp.body.getReader();
                const decoder = new TextDecoder();
                let html = '';
                let bytesRead = 0;
                let truncated = false;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    bytesRead += value.byteLength;
                    if (bytesRead > MAX_BYTES) {
                        truncated = true;
                        await reader.cancel();
                        break;
                    }
                    html += decoder.decode(value, { stream: true });
                }
                sendResponse({ ok: true, html, truncated });
            } catch (e) {
                sendResponse({ ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'fetch_error' });
            } finally {
                // Runs after the body read (or the abort/error that cut it
                // short) either way, so this always cleans up the timer
                // without leaving it armed past the point it's needed.
                clearTimeout(timeoutId);
            }
        })();
        return true;
    }
});
