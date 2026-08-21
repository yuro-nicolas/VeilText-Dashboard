// ─── PAGE LOAD WARNING ────────────────────────────────────────────────────────
//
// Full-screen "this page contains flagged content" interstitial, shown once
// per page load (and again after an SPA route change) when redactions were
// actually made and the user hasn't disabled the setting.
(function (VeilText) {
    'use strict';

    const Config = VeilText.Config;
    const State = VeilText.State;

    let pageWarningTimerScheduled = false;
    let pageWarningShown = false;

    function resetShownFlag() {
        pageWarningShown = false;
    }

    function showPageWarningIfNeeded() {
        if (pageWarningShown) return;
        if (pageWarningTimerScheduled) return;
        pageWarningTimerScheduled = true;

        setTimeout(() => {
            pageWarningTimerScheduled = false;

            if (pageWarningShown) return;
            const CONFIG = Config.get();
            if (!CONFIG.pageScanWarning || !CONFIG.filterEnabled) return;
            const found = document.querySelectorAll('.textguard-filtered').length;
            if (found === 0) return;
            if (document.getElementById('textguard-page-warning-host')) return;

            pageWarningShown = true;

            const domain = location.hostname || location.href;
            const algoLabel = CONFIG.algorithm === 'wumanber' ? 'Wu-Manber' : 'Aho-Corasick';

            const host = document.createElement('div');
            host.id = 'textguard-page-warning-host';
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
                        background: rgba(32,41,27,0.78);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-family: 'Nunito Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    }
                    .box {
                        background: #f6f3e7;
                        border: 1px solid #c3d1a4;
                        border-radius: 16px;
                        padding: 34px 38px;
                        max-width: 440px;
                        width: 92%;
                        box-shadow: 0 18px 50px rgba(32,41,27,0.35);
                        color: #2b3524;
                        text-align: center;
                        box-sizing: border-box;
                    }
                    h2 {
                        font-family: 'Quicksand', sans-serif;
                        font-size: 19px;
                        font-weight: 700;
                        color: #a8553c;
                        margin: 0 0 10px 0;
                    }
                    p {
                        font-size: 13px;
                        color: rgba(43,53,36,0.75);
                        line-height: 1.7;
                        margin: 0 0 8px 0;
                    }
                    .fine-print {
                        font-size: 11px;
                        color: rgba(43,53,36,0.4);
                        margin: 18px 0 0 0;
                    }
                    .btn-row {
                        display: flex;
                        gap: 12px;
                        justify-content: center;
                        flex-wrap: wrap;
                        margin-top: 24px;
                    }
                    button {
                        box-sizing: border-box;
                        padding: 12px 24px;
                        border-radius: 10px;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: 700;
                        line-height: 1.2;
                        white-space: nowrap;
                        font-family: inherit;
                    }
                    #back {
                        border: 1px solid #c3d1a4;
                        background: #eef1e0;
                        color: #2b3524;
                    }
                    #proceed {
                        border: none;
                        background: #6b7c4f;
                        color: #f6f3e7;
                    }
                </style>
                <div class="overlay">
                    <div class="box">
                        <h2>This page contains flagged content</h2>
                        <p>
                            Filter detected and redacted
                            <strong style="color:#a8553c;font-size:15px;">${found}</strong>
                            instance${found !== 1 ? 's' : ''} of words from the filter list on
                            <strong style="color:#2b3524;">${domain}</strong>.
                        </p>
                        <p style="font-size:11.5px;color:rgba(43,53,36,0.5);">
                            Scanned using the <strong>${algoLabel}</strong> engine. Redacted words are already hidden,
                            click any redacted word to reveal it.
                        </p>
                        <div class="btn-row">
                            <button id="back">← Go Back</button>
                            <button id="proceed">Continue to Page →</button>
                        </div>
                        <p class="fine-print">You can disable this warning in Settings → Page Load Warning.</p>
                    </div>
                </div>
            `;

            (document.body || document.documentElement).appendChild(host);

            shadow.getElementById('back').addEventListener('click', () => {
                host.remove();
                if (window.history.length > 1) window.history.back();
                else { try { chrome.runtime.sendMessage({ action: 'closeTab' }); } catch (e) { window.close(); } }
            });
            shadow.getElementById('proceed').addEventListener('click', () => host.remove());
        }, 400);
    }

    VeilText.PageWarning.showPageWarningIfNeeded = showPageWarningIfNeeded;
    VeilText.PageWarning.resetShownFlag = resetShownFlag;
})(window.VeilText);
