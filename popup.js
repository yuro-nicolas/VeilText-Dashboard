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
    algorithm: 'ahocorasick' // 'ahocorasick' | 'wumanber'
};

const ALGO_LABELS = { ahocorasick: 'AC', wumanber: 'WM' };

let CONFIG = { ...DEFAULT_CONFIG };
let _saveDebounceTimer = null;
let activeTabId = null;

//   INIT

document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    initTabs();
    initEventListeners();
    renderUI();
    refreshStats();
});

//   STORAGE

async function loadSettings() {
    try {
        const result = await chrome.storage.local.get(['textguard_config']);
        if (result.textguard_config) {
            CONFIG = { ...DEFAULT_CONFIG, ...result.textguard_config };
        }
    } catch (e) {
        console.error('Filter popup: error loading config', e);
    }
}
async function saveSettings(silent = false) {
    try {
        await chrome.storage.local.set({ textguard_config: CONFIG });


        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.id) {
                activeTabId = tab.id;
                chrome.tabs.sendMessage(
                    tab.id,
                    { action: 'configUpdated', config: CONFIG },
                    { frameId: 0 },
                    (resp) => {
                        if (chrome.runtime.lastError) return;
                        if (resp && resp.count !== undefined) {
                            document.getElementById('statFiltered').textContent = resp.count;
                        }
                    }
                );
            }
        } catch (_) {}

        if (!silent) showStatus('Saved automatically ✓', 'success');
    } catch (e) {
        console.error('Filter popup: error saving', e);
        showStatus('Failed to save.', 'error');
    }
}

function debouncedSave(delay = 600) {
    clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = setTimeout(() => {
        saveSettings();
    }, delay);
}

//   TABS

function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab + '-tab').classList.add('active');
        });
    });

    document.querySelectorAll('.subtab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.subtab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.subtab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.subtab + '-subtab').classList.add('active');
        });
    });
}

//   EVENT LISTENERS — every change auto-saves

function initEventListeners() {

    // Master toggle: save immediately
    document.getElementById('masterToggle').addEventListener('change', function () {
        CONFIG.filterEnabled = this.checked;
        document.getElementById('masterLabel').textContent = this.checked ? 'ON' : 'OFF';
        saveSettings();
    });

    // Dashboard button
    const dashboardBtn = document.getElementById("openDashboardBtn");
    if (dashboardBtn) {
        dashboardBtn.addEventListener("click", () => {
            chrome.tabs.create({
                url: chrome.runtime.getURL("dashboard.html")
            });
        });
    }

    // Blocked list controls
    document.getElementById('sortBlocked').addEventListener('click', () => sortKeywordList('blocked'));
    document.getElementById('clearBlocked').addEventListener('click', () => clearKeywordList('blocked'));
    document.getElementById('quickAddBlockedBtn').addEventListener('click', () => quickAddTo('blocked', 'quickAddBlockedInput'));
    document.getElementById('quickAddBlockedInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') quickAddTo('blocked', 'quickAddBlockedInput');
    });

    // Include list controls
    document.getElementById('sortInclude').addEventListener('click', () => sortKeywordList('include'));
    document.getElementById('clearInclude').addEventListener('click', () => clearKeywordList('include'));
    document.getElementById('quickAddIncludeBtn').addEventListener('click', () => quickAddTo('include', 'quickAddIncludeInput'));
    document.getElementById('quickAddIncludeInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') quickAddTo('include', 'quickAddIncludeInput');
    });

    // Detection algorithm: save immediately, re-label engine stat
    document.querySelectorAll('input[name="algorithm"]').forEach(radio => {
        radio.addEventListener('change', function () {
            CONFIG.algorithm = this.value;
            document.getElementById('statAlgo').textContent = ALGO_LABELS[this.value] || 'AC';
            saveSettings();
        });
    });

    // Filter mode: save immediately
    document.querySelectorAll('input[name="filterMode"]').forEach(radio => {
        radio.addEventListener('change', function () {
            CONFIG.filterMode = this.value;
            document.getElementById('replaceTextGroup').style.display =
                this.value === 'replace' ? 'block' : 'none';
            saveSettings();
        });
    });

    // Replacement text: debounced save
    document.getElementById('replacementText').addEventListener('input', function () {
        CONFIG.replacementText = this.value;
        debouncedSave(800);
    });

    // Case sensitive: save immediately
    document.getElementById('caseSensitive').addEventListener('change', function () {
        CONFIG.caseSensitive = this.checked;
        saveSettings();
    });

    // Whole word: save immediately
    document.getElementById('wholeWord').addEventListener('change', function () {
        CONFIG.wholeWord = this.checked;
        saveSettings();
    });

    // Page load warning: save immediately
    document.getElementById('pageScanWarning').addEventListener('change', function () {
        CONFIG.pageScanWarning = this.checked;
        saveSettings();
    });

    // Link pre-scan warning: save immediately
    document.getElementById('linkScanEnabled').addEventListener('change', function () {
        CONFIG.linkScanEnabled = this.checked;
        saveSettings();
    });

    // Click-to-reveal: save immediately
    document.getElementById('revealOnClick').addEventListener('change', function () {
        CONFIG.revealOnClick = this.checked;
        saveSettings();
    });

}

//   UI RENDERING

function renderUI() {
    renderChips('blocked');
    renderChips('include');

    document.getElementById('masterToggle').checked = CONFIG.filterEnabled;
    document.getElementById('masterLabel').textContent = CONFIG.filterEnabled ? 'ON' : 'OFF';

    const algoInput = document.querySelector(`input[name="algorithm"][value="${CONFIG.algorithm}"]`);
    if (algoInput) algoInput.checked = true;
    document.getElementById('statAlgo').textContent = ALGO_LABELS[CONFIG.algorithm] || 'AC';

    const modeInput = document.querySelector(`input[name="filterMode"][value="${CONFIG.filterMode}"]`);
    if (modeInput) modeInput.checked = true;
    document.getElementById('replaceTextGroup').style.display =
        CONFIG.filterMode === 'replace' ? 'block' : 'none';

    document.getElementById('replacementText').value = CONFIG.replacementText || '█████';
    document.getElementById('caseSensitive').checked = CONFIG.caseSensitive;
    document.getElementById('wholeWord').checked = CONFIG.wholeWord;
    document.getElementById('pageScanWarning').checked = CONFIG.pageScanWarning;
    document.getElementById('linkScanEnabled').checked = CONFIG.linkScanEnabled;
    document.getElementById('revealOnClick').checked = CONFIG.revealOnClick;
}

//   KEYWORD UTILITIES

const KEYWORD_LISTS = {
    blocked: {
        configKey: 'keywords',
        chipsId: 'blockedChips',
        countId: 'blockedCount',
        emptyMsg: 'No custom blocked words yet. Add one above.',
        chipClass: 'chip-blocked',
        clearConfirm: 'Clear all blocked keywords?'
    },
    include: {
        configKey: 'includeKeywords',
        chipsId: 'includeChips',
        countId: 'includeCount',
        emptyMsg: 'No included words yet. Add one above.',
        chipClass: 'chip-include',
        clearConfirm: 'Clear all included words?'
    }
};

function parseKeywords(text) {
    if (!text || text.trim() === '') return [];
    return [...new Set(
        text
            .split(/[\n,]+/)
            .map(s => s.trim())
            .filter(Boolean)
    )];
}

function renderChips(listKey) {
    const cfg = KEYWORD_LISTS[listKey];
    const list = CONFIG[cfg.configKey] || (CONFIG[cfg.configKey] = []);
    const container = document.getElementById(cfg.chipsId);

    container.innerHTML = '';

    if (list.length === 0) {
        const span = document.createElement('span');
        span.className = 'chips-empty';
        span.textContent = cfg.emptyMsg;
        container.appendChild(span);
    } else {
        list.forEach((kw, i) => {
            const chip = document.createElement('span');
            chip.className = `chip ${cfg.chipClass}`;

            const text = document.createElement('span');
            text.className = 'chip-text';
            text.textContent = kw;
            text.title = kw;

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'chip-remove';
            removeBtn.setAttribute('aria-label', `Remove "${kw}"`);
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', () => removeKeyword(listKey, i));

            chip.appendChild(text);
            chip.appendChild(removeBtn);
            container.appendChild(chip);
        });
    }

    document.getElementById(cfg.countId).textContent = list.length;
    if (listKey === 'blocked') {
        document.getElementById('statKeywords').textContent = list.length;
    }
}

function removeKeyword(listKey, index) {
    const cfg = KEYWORD_LISTS[listKey];
    const list = CONFIG[cfg.configKey];
    const removed = list[index];
    list.splice(index, 1);
    renderChips(listKey);
    saveSettings(true);
    if (removed) showStatus(`Removed "${removed}".`, 'info');
}

function sortKeywordList(listKey) {
    const cfg = KEYWORD_LISTS[listKey];
    const list = CONFIG[cfg.configKey];
    if (list.length < 2) return;
    list.sort((a, b) => a.localeCompare(b));
    renderChips(listKey);
    saveSettings(true);
    showStatus('Sorted A–Z.', 'info');
}

function clearKeywordList(listKey) {
    const cfg = KEYWORD_LISTS[listKey];
    const list = CONFIG[cfg.configKey];
    if (list.length === 0) return;
    if (confirm(cfg.clearConfirm)) {
        CONFIG[cfg.configKey] = [];
        renderChips(listKey);
        saveSettings();
        showStatus('Cleared.', 'success');
    }
}

function quickAddTo(listKey, inputId) {
    const cfg = KEYWORD_LISTS[listKey];
    const input = document.getElementById(inputId);
    const raw = input.value.trim();
    if (!raw) return;

    const list = CONFIG[cfg.configKey];

    const toAdd = parseKeywords(raw);
    const existingLower = list.map(s => s.toLowerCase());

    let addedCount = 0;
    let dupeCount = 0;

    for (const kw of toAdd) {
        if (existingLower.includes(kw.toLowerCase())) {
            dupeCount++;
            continue;
        }
        list.push(kw);
        existingLower.push(kw.toLowerCase());
        addedCount++;
    }

    input.value = '';
    renderChips(listKey);

    if (addedCount > 0) {
        saveSettings(true);
        let msg;
        if (dupeCount > 0) {
            msg = `Added ${addedCount} keyword(s), skipped ${dupeCount} duplicate(s).`;
        } else if (addedCount === 1) {
            msg = `Added "${toAdd[toAdd.length - 1]}".`;
        } else {
            msg = `Added ${addedCount} keywords.`;
        }
        showStatus(msg, 'success');
    } else if (dupeCount > 0) {
        showStatus('Already in the list.', 'info');
    }
}

//   STATS REFRESH

async function refreshStats() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
            activeTabId = tab.id;
            chrome.tabs.sendMessage(
                tab.id,
                { action: 'getStats' },
                { frameId: 0 },
                (resp) => {
                    if (chrome.runtime.lastError) return;
                    if (resp && resp.count !== undefined) {
                        document.getElementById('statFiltered').textContent = resp.count;
                    }
                }
            );
        }
    } catch (_) {}
}

chrome.runtime.onMessage.addListener((request, sender) => {
    if (request.action !== 'updateCount' || request.count === undefined) return;
    if (sender.tab && sender.tab.id !== activeTabId) return;

    // 'getStats' and 'configUpdated' are sent with { frameId: 0 }, so only the
    // page's top frame ever answers those -- but this 'updateCount' broadcast
    // is fired from every frame's content script (the extension injects into
    // all_frames), including iframes (ads, embeds, trackers) that almost
    // always have 0 matches of their own. Without this check, a subframe's
    // stale/irrelevant 0 can arrive after the top frame's real count and
    // silently stomp it back to 0 -- which is exactly what made toggling the
    // filter (or editing keywords) look like it always settled on 0 instead
    // of the true count. Only trust updates from the top frame.
    if (sender.frameId !== 0) return;

    document.getElementById('statFiltered').textContent = request.count;
});

//   STATUS TOAST

function showStatus(message, type = 'info') {
    const el = document.getElementById('statusMessage');
    el.textContent = message;
    el.className = `status-message ${type}`;
    clearTimeout(window._statusTimer);
    window._statusTimer = setTimeout(() => el.classList.add('hidden'), 2500);
}
