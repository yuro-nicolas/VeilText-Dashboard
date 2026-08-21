// ─── FILTERED SPAN + CLICK-TO-REVEAL ─────────────────────────────────────────
//
// Builds the actual redacted <span> that replaces blocked text, applies the
// chosen visual style (blur / hide / replace-with-text), and handles the
// "click a redacted word to reveal it" flow, including the small warning
// popover shown before revealing.
(function (VeilText) {
    'use strict';

    const Config = VeilText.Config;

    // Builds one redacted <span> for a run of matched text. `keywords` is
    // the set of keyword(s) that triggered the match (stored on the element
    // for debugging/inspection, not otherwise used).
    function createFilteredSpan(originalText, keywords) {
        const CONFIG = Config.get();
        const span = document.createElement('span');
        span.className = 'textguard-filtered';
        span.dataset.original = originalText;
        span.dataset.keywords = [...keywords].join(',');
        span.dataset.revealed = 'false';
        span.style.cursor = CONFIG.revealOnClick ? 'pointer' : 'default';
        span.classList.toggle('textguard-no-reveal', !CONFIG.revealOnClick);
        applyHiddenStyle(span, originalText);
        span.addEventListener('click', onFilteredSpanClick);
        return span;
    }

    // Applies the visual treatment for the current filterMode (blur / hide /
    // replace). Also used to re-hide a span the user had revealed.
    function applyHiddenStyle(span, originalText) {
        const text = originalText !== undefined ? originalText : span.dataset.original;
        const CONFIG = Config.get();
        const mode = CONFIG.filterMode;
        span.style.filter = '';
        span.style.backgroundColor = '';
        span.style.borderRadius = '3px';
        span.style.padding = '0 2px';
        span.style.display = 'inline';
        span.style.width = '';
        span.style.height = '';
        span.style.color = '';
        span.style.fontWeight = '';

        if (mode === 'blur') {
            span.textContent = text;
            span.style.filter = 'blur(5px)';
            span.style.backgroundColor = 'rgba(168,85,60,0.15)';
        } else if (mode === 'hide') {
            span.textContent = '';
            span.style.display = 'inline-block';
            span.style.width = Math.max(20, text.length * 7) + 'px';
            span.style.height = '1em';
            span.style.backgroundColor = 'rgba(168,85,60,0.28)';
            span.style.verticalAlign = 'middle';
        } else if (mode === 'replace') {
            span.textContent = CONFIG.replacementText || '█████';
            span.style.color = 'rgba(168,85,60,0.85)';
            span.style.fontWeight = 'bold';
        }
    }

    function revealSpan(span) {
        span.dataset.revealed = 'true';
        span.textContent = span.dataset.original;
        span.style.filter = 'none';
        span.style.backgroundColor = 'rgba(134,153,102,0.22)';
        span.style.display = 'inline';
        span.style.width = '';
        span.style.height = '';
        span.style.color = '';
        span.style.fontWeight = '';
        span.style.outline = '1px dashed rgba(84,99,63,0.5)';
    }

    function hideSpanAgain(span) {
        span.dataset.revealed = 'false';
        span.style.outline = '';
        applyHiddenStyle(span);
    }

    function onFilteredSpanClick(e) {
        const CONFIG = Config.get();
        if (!CONFIG.revealOnClick) return; // clicking does nothing when disabled
        e.preventDefault();
        e.stopPropagation();
        const span = e.currentTarget;
        if (span.dataset.revealed === 'true') {
            hideSpanAgain(span);
            return;
        }
        showRevealWarning(span);
    }

    let revealPopover = null;

    function removeRevealPopover() {
        if (revealPopover) { revealPopover.remove(); revealPopover = null; }
        document.removeEventListener('scroll', removeRevealPopover, true);
    }

    // Small "are you sure?" popover anchored under the clicked span, shown
    // in a closed shadow root so the host page's CSS can't bleed into it.
    function showRevealWarning(span) {
        removeRevealPopover();
        const rect = span.getBoundingClientRect();

        const top = Math.min(window.innerHeight - 140, rect.bottom + 8);
        const left = Math.max(8, Math.min(window.innerWidth - 276, rect.left));

        const host = document.createElement('div');
        host.id = 'textguard-reveal-popover-host';
        host.style.cssText = `
            position:fixed !important;
            z-index:2147483647 !important;
            top:${top}px !important;
            left:${left}px !important;
            margin:0 !important;
            padding:0 !important;
            border:none !important;
            width:auto !important;
            height:auto !important;
            display:block !important;
        `;

        const shadow = host.attachShadow({ mode: 'closed' });

        shadow.innerHTML = `
            <style>
                :host { all: initial; }
                .pop {
                    max-width: 260px;
                    background: #f6f3e7;
                    border: 1px solid #c3d1a4;
                    border-radius: 10px;
                    box-shadow: 0 6px 20px rgba(43,53,36,0.25);
                    padding: 14px 16px;
                    font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                    color: #2b3524;
                    text-align: left;
                    box-sizing: border-box;
                }
                .msg {
                    font-size: 12.5px;
                    line-height: 1.5;
                    margin-bottom: 10px;
                }
                .msg strong { color: #a8553c; }
                .btn-row {
                    display: flex;
                    gap: 8px;
                }
                button {
                    box-sizing: border-box;
                    flex: 1;
                    padding: 6px 8px;
                    border-radius: 7px;
                    cursor: pointer;
                    font-size: 12px;
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
                #reveal {
                    border: none;
                    background: #6b7c4f;
                    color: #f6f3e7;
                }
            </style>
            <div class="pop">
                <div class="msg">
                    <strong>⚠ Content Warning</strong><br>
                    This text was hidden because it matched the filter list. Reveal it anyway?
                </div>
                <div class="btn-row">
                    <button id="cancel">Keep Hidden</button>
                    <button id="reveal">Reveal</button>
                </div>
            </div>
        `;

        document.body.appendChild(host);
        revealPopover = host;

        shadow.getElementById('reveal').addEventListener('click', (ev) => {
            ev.stopPropagation();
            revealSpan(span);
            removeRevealPopover();
        });
        shadow.getElementById('cancel').addEventListener('click', (ev) => {
            ev.stopPropagation();
            removeRevealPopover();
        });

        document.addEventListener('scroll', removeRevealPopover, true);
        setTimeout(() => {
            document.addEventListener('click', function onDocClick(ev) {
                if (host.contains(ev.target)) return;
                removeRevealPopover();
                document.removeEventListener('click', onDocClick, true);
            }, true);
        }, 0);
    }

    VeilText.RevealUI.createFilteredSpan = createFilteredSpan;
    VeilText.RevealUI.applyHiddenStyle = applyHiddenStyle;
    VeilText.RevealUI.revealSpan = revealSpan;
    VeilText.RevealUI.hideSpanAgain = hideSpanAgain;
    VeilText.RevealUI.removeRevealPopover = removeRevealPopover;
})(window.VeilText);
