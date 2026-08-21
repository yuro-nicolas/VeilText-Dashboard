// ─── LINK PRE-SCAN WARNING ────────────────────────────────────────────────────
//
// Intercepts clicks on outbound links and checks the link text, the URL
// itself, and (via background.js's fetch proxy) the destination page's HTML
// for blocked keywords before letting navigation happen. Shows a warning
// overlay ("flagged" or "couldn't verify") that the user can dismiss to
// proceed anyway, or cancel to stay put.
(function (VeilText) {
    'use strict';

    const Config = VeilText.Config;
    const State = VeilText.State;
    const FilterEngine = VeilText.FilterEngine;

    let warningOverlay = null;
    let checkingBadge = null;

    const prescanCache = new Map();
    const inFlight = new Map();
    const PRESCAN_TTL_MS = 10 * 60 * 1000;

    function initLinkScanner() {
        document.addEventListener('click', handleLinkClick, true);
    }

    function handleLinkClick(e) {
        const CONFIG = Config.get();
        if (!CONFIG.linkScanEnabled) return;
        if (!State.hasActiveKeywords()) return;

        // This listener runs in the CAPTURE phase on document, which fires
        // before a clicked <span class="textguard-filtered">'s own (bubble
        // phase) click handler. Without this check, clicking a blurred word
        // that happens to sit inside a link would jump straight into the
        // link-level checks below (or straight to navigation) and the "reveal
        // this text?" popover would never get a chance to appear. So: if the
        // click landed on a not-yet-revealed filtered span, back off entirely
        // and let that span's own click handler show the reveal prompt first.
        // A second click -- now on either the revealed word or plain link
        // text -- falls through to the link-level handling below as normal.
        const filteredSpan = e.target.closest && e.target.closest('.textguard-filtered');
        if (filteredSpan && CONFIG.revealOnClick && filteredSpan.dataset.revealed !== 'true') {
            return;
        }

        const anchor = e.target.closest('a[href]');
        if (!anchor) return;

        const href = anchor.href;
        if (!href || !/^https?:\/\//i.test(href)) return;

        const linkText = anchor.textContent || '';
        if (FilterEngine.hasBlockedMatch(linkText, CONFIG.wholeWord)) {
            e.preventDefault();
            e.stopPropagation();
            showLinkWarning(href, anchor);
            return;
        }

        try {
            const urlText = decodeURIComponent(href);
            if (FilterEngine.hasBlockedMatch(urlText, CONFIG.wholeWord)) {
                e.preventDefault();
                e.stopPropagation();
                showLinkWarning(href, anchor);
                return;
            }
        } catch (_) {}

        const cached = prescanCache.get(href);
        if (cached && Date.now() - cached.ts < PRESCAN_TTL_MS) {
            if (cached.status === 'flagged') {
                e.preventDefault();
                e.stopPropagation();
                showLinkWarning(href, anchor);
            } else if (cached.status === 'unknown') {
                e.preventDefault();
                e.stopPropagation();
                showUnverifiedWarning(href, anchor);
            }
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        prescanDestination(href, e.clientX, e.clientY).then((status) => {
            prescanCache.set(href, { status, ts: Date.now() });

            if (status === 'flagged') {
                showLinkWarning(href, anchor);
            } else if (status === 'unknown') {
                showUnverifiedWarning(href, anchor);
            } else {
                navigateTo(href, anchor);
            }
        });
    }

    function navigateTo(href, anchor) {
        if (anchor.target === '_blank') {
            window.open(href, '_blank');
        } else {
            window.location.href = href;
        }
    }

    // Asks background.js to fetch the destination page (content scripts
    // can't always do this themselves due to CORS) and scans its visible
    // text for blocked keywords. Results are memoized per-URL so revisiting
    // the same link doesn't re-fetch within PRESCAN_TTL_MS.
    async function prescanDestination(href, x, y) {
        const existing = inFlight.get(href);
        if (existing) return existing;

        const promise = (async () => {
            showCheckingBadge(x, y);

            try {
                const result = await chrome.runtime.sendMessage({
                    action: 'prescanUrl',
                    url: href,
                    timeoutMs: 4000
                });

                if (!result || !result.ok) return 'unknown';

                const text = extractVisibleText(result.html);
                if (text.trim().length < 200) return 'unknown';
                const CONFIG = Config.get();
                return FilterEngine.hasBlockedMatch(text, CONFIG.wholeWord) ? 'flagged' : 'clean';
            } catch (_) {
                return 'unknown';
            } finally {
                removeCheckingBadge();
                inFlight.delete(href);
            }
        })();

        inFlight.set(href, promise);
        return promise;
    }

    function extractVisibleText(html) {
        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            doc.querySelectorAll('script, style, noscript, template').forEach(el => el.remove());
            return doc.body ? doc.body.textContent : '';
        } catch (_) {
            return '';
        }
    }

    function showCheckingBadge(x, y) {
        removeCheckingBadge();

        const badge = document.createElement('div');
        badge.id = 'textguard-checking-badge';
        badge.style.cssText = `
            position:fixed;
            z-index:2147483647;
            left:${x + 12}px;
            top:${y + 12}px;
            background:#f6f3e7;
            border:1px solid #c3d1a4;
            border-radius:8px;
            padding:6px 10px;
            font-family:'Nunito Sans',-apple-system,sans-serif;
            font-size:11.5px;
            color:#54633f;
            box-shadow:0 4px 12px rgba(43,53,36,0.2);
            pointer-events:none;
        `;
        badge.textContent = '🔍 Checking link…';

        document.body.appendChild(badge);
        checkingBadge = badge;
    }

    function removeCheckingBadge() {
        if (checkingBadge) {
            checkingBadge.remove();
            checkingBadge = null;
        }
    }

    function domainOf(href) {
        try {
            return new URL(href).hostname;
        } catch (_) {
            return href.substring(0, 40);
        }
    }

    function showLinkWarning(href, anchorOrText) {
        if (warningOverlay) warningOverlay.remove();

        const domain = domainOf(href);
        const anchor = anchorOrText instanceof Element ? anchorOrText : null;

        const host = document.createElement('div');
        host.id = 'textguard-overlay-host';
        host.style.cssText = `
            position:fixed !important;
            inset:0 !important;
            z-index:2147483647 !important;
            display:block !important;
            margin:0 !important;
            padding:0 !important;
            border:none !important;
            width:auto !important;
            height:auto !important;
        `;

        const shadow = host.attachShadow({ mode: 'closed' });

        shadow.innerHTML = `
            <style>
                :host { all: initial; }
                .overlay {
                    position: fixed;
                    inset: 0;
                    background: rgba(32,41,27,0.68);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                }
                .box {
                    background: #f6f3e7;
                    border: 1px solid #c3d1a4;
                    border-radius: 14px;
                    padding: 26px 30px;
                    max-width: 420px;
                    width: 90%;
                    box-shadow: 0 16px 40px rgba(32,41,27,0.32);
                    color: #2b3524;
                    text-align: center;
                    box-sizing: border-box;
                }
                h2 {
                    font-family: 'Quicksand', sans-serif;
                    font-size: 17px;
                    font-weight: 700;
                    color: #a8553c;
                    margin: 0 0 8px 0;
                }
                p {
                    font-size: 13px;
                    color: rgba(43,53,36,0.75);
                    margin: 0 0 18px 0;
                    line-height: 1.6;
                }
                .btn-row {
                    display: flex;
                    gap: 10px;
                    justify-content: center;
                    flex-wrap: wrap;
                }
                button {
                    box-sizing: border-box;
                    padding: 10px 24px;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 13px;
                    font-weight: 700;
                    line-height: 1.2;
                    white-space: nowrap;
                    font-family: inherit;
                }
                #cancel {
                    border: 1px solid #c3d1a4;
                    background: #eef1e0;
                    color: #2b3524;
                }
                #proceed {
                    border: none;
                    background: #a8553c;
                    color: #f6f3e7;
                }
            </style>
            <div class="overlay">
                <div class="box">
                    <h2>Content Warning</h2>
                    <p>
                        The link you clicked (<strong style="color:#2b3524">${domain}</strong>)
                        may contain content that matches the redaction list.
                        Do you want to continue?
                    </p>
                    <div class="btn-row">
                        <button id="cancel">✕ Go Back</button>
                        <button id="proceed">Proceed Anyway →</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(host);
        warningOverlay = host;

        shadow.getElementById('cancel').addEventListener('click', () => host.remove());
        shadow.getElementById('proceed').addEventListener('click', () => {
            host.remove();
            if (anchor) navigateTo(href, anchor); else window.location.href = href;
        });
        shadow.querySelector('.overlay').addEventListener('click', (e) => {
            if (e.target === shadow.querySelector('.overlay')) host.remove();
        });
    }

    function showUnverifiedWarning(href, anchorOrText) {
        if (warningOverlay) warningOverlay.remove();

        const domain = domainOf(href);
        const anchor = anchorOrText instanceof Element ? anchorOrText : null;

        const host = document.createElement('div');
        host.id = 'textguard-overlay-host';
        host.style.cssText = `
            position:fixed !important;
            inset:0 !important;
            z-index:2147483647 !important;
            display:block !important;
            margin:0 !important;
            padding:0 !important;
            border:none !important;
            width:auto !important;
            height:auto !important;
        `;

        const shadow = host.attachShadow({ mode: 'closed' });

        shadow.innerHTML = `
            <style>
                :host { all: initial; }
                .overlay {
                    position: fixed;
                    inset: 0;
                    background: rgba(32,41,27,0.68);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                }
                .box {
                    background: #f6f3e7;
                    border: 1px solid #c3d1a4;
                    border-radius: 14px;
                    padding: 26px 30px;
                    max-width: 420px;
                    width: 90%;
                    box-shadow: 0 16px 40px rgba(32,41,27,0.32);
                    color: #2b3524;
                    text-align: center;
                    box-sizing: border-box;
                }
                h2 {
                    font-family: 'Quicksand', sans-serif;
                    font-size: 17px;
                    font-weight: 700;
                    color: #b98a3e;
                    margin: 0 0 8px 0;
                }
                p {
                    font-size: 13px;
                    color: rgba(43,53,36,0.75);
                    margin: 0 0 18px 0;
                    line-height: 1.6;
                }
                .btn-row {
                    display: flex;
                    gap: 10px;
                    justify-content: center;
                    flex-wrap: wrap;
                }
                button {
                    box-sizing: border-box;
                    padding: 10px 24px;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 13px;
                    font-weight: 700;
                    line-height: 1.2;
                    white-space: nowrap;
                    font-family: inherit;
                }
                #cancel {
                    border: 1px solid #c3d1a4;
                    background: #eef1e0;
                    color: #2b3524;
                }
                #proceed {
                    border: none;
                    background: #b98a3e;
                    color: #f6f3e7;
                }
            </style>
            <div class="overlay">
                <div class="box">
                    <h2>Couldn't Verify This Link</h2>
                    <p>
                        <strong style="color:#2b3524">${domain}</strong> loads its content dynamically,
                        so Filter couldn't scan the destination page before you visit it.
                        It has not been flagged, but it also hasn't been checked.
                    </p>
                    <div class="btn-row">
                        <button id="cancel">✕ Go Back</button>
                        <button id="proceed">Proceed Anyway →</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(host);
        warningOverlay = host;

        shadow.getElementById('cancel').addEventListener('click', () => host.remove());
        shadow.getElementById('proceed').addEventListener('click', () => {
            host.remove();
            if (anchor) navigateTo(href, anchor); else window.location.href = href;
        });
        shadow.querySelector('.overlay').addEventListener('click', (e) => {
            if (e.target === shadow.querySelector('.overlay')) host.remove();
        });
    }

    VeilText.LinkScanner.initLinkScanner = initLinkScanner;
})(window.VeilText);
