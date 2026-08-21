// ── ENGINE CONFIG ────────────────────────────────────────────────────────────

const ALGO_NAMES = { ahocorasick: 'Aho-Corasick', wumanber: 'Wu-Manber' };
const ALGO_META = {
    ahocorasick: {
        statsKey: 'textguard_stats_ahocorasick'
    },
    wumanber: {
        statsKey: 'textguard_stats_wumanber'
    }
};

let activeTab = 'ahocorasick'; // which engine's dashboard is currently shown
let allLog = [];               // redaction log for the active tab only
let keywordRegex = null;       // active blocked-keyword matcher, used to redact log text
let currentConfig = {};        // last-loaded textguard_config, used for revealOnClick etc.

document.addEventListener('DOMContentLoaded', async () => {
    // Default the visible tab to whichever engine is actually active in the
    // extension right now, so opening the dashboard shows relevant data first.
    const { textguard_config: config } = await chrome.storage.local.get(['textguard_config']);
    activeTab = (config && config.algorithm === 'wumanber') ? 'wumanber' : 'ahocorasick';

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activeTab = btn.dataset.algo;
            loadAndRender();
        });
    });

    await loadAndRender();

    document.getElementById('clearStatsBtn').addEventListener('click', clearStats);
    document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);
    document.getElementById('exportJsonBtn').addEventListener('click', exportJSON);
    document.getElementById('searchLog').addEventListener('input', filterTable);

    // Click-to-reveal on redacted titles in the log table, mirroring the same
    // setting used on regular pages. Delegated since rows are re-rendered often.
    document.getElementById('logBody').addEventListener('click', (e) => {
        const span = e.target.closest('.dash-redacted');
        if (!span || currentConfig.revealOnClick === false) return;
        span.classList.toggle('revealed');
    });

    // Live-update when content script writes new data for either engine, or the
    // active engine changes in the extension settings.
    chrome.storage.onChanged.addListener((changes) => {
        const relevant = [
            'textguard_stats_ahocorasick', 'textguard_stats_wumanber',
            'textguard_config'
        ];
        if (relevant.some(k => changes[k])) loadAndRender();
    });
});

async function loadAndRender() {
    const meta = ALGO_META[activeTab];

    const result = await chrome.storage.local.get([
        meta.statsKey, 'textguard_config'
    ]);

    const stats   = result[meta.statsKey]   || { totalRedacted: 0, totalPages: 0, scans: 0, sumMs: 0, minMs: Infinity, sumChars: 0, log: [] };
    const config  = result.textguard_config || { keywords: [], algorithm: 'ahocorasick' };
    currentConfig = config;
    document.body.classList.toggle('no-reveal', config.revealOnClick === false);

    allLog = stats.log || [];

    updateTabUI(config.algorithm);
    updateSectionTitles();

    // ── Summary cards ──────────────────────────────────────────────────────────
    set('totalRedacted', stats.totalRedacted.toLocaleString());
    set('totalPages',    stats.totalPages.toLocaleString());
    set('avgPerPage',    stats.totalPages > 0
        ? (stats.totalRedacted / stats.totalPages).toFixed(1) : '0');

    // "Active Keywords" reflects everything the matcher actually searches for —
    // the built-in default lexicon plus any custom blocked keywords. It's shared
    // across both engines (they use the same keyword list), so it doesn't change
    // between tabs.
    const builtInLexicon = await getDefaultLexicon();
    const customCount    = (config.keywords || []).length;
    set('totalKeywords', (builtInLexicon.length + customCount).toLocaleString());

    // The log table below shows page titles pulled straight from browsing history.
    // Those titles can themselves contain a blocked word (that's often *why* the
    // page was flagged), so build the same matcher the content script uses and
    // redact matches before they're painted into this page — otherwise a word the
    // user asked to have hidden would show up in plain text right here on the
    // dashboard, even though it's correctly blurred out on every other page.
    const allKeywords = [...builtInLexicon, ...(config.keywords || [])];
    keywordRegex = buildKeywordRegex(allKeywords, config.wholeWord !== false, !!config.caseSensitive);

    // ── Engine performance (this tab's engine only) ─────────────────────────────
    renderPerformance(stats);

    // ── Table (this tab's engine only) ──────────────────────────────────────────
    renderTable(allLog);
}

// ── TAB / TITLE UI ───────────────────────────────────────────────────────────

function updateTabUI(liveAlgorithm) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        const algo = btn.dataset.algo;
        btn.classList.toggle('active', algo === activeTab);
        const pill = document.getElementById(`livePill-${algo}`);
        if (pill) pill.hidden = (algo !== liveAlgorithm);
    });
}

function updateSectionTitles() {
    const name = ALGO_NAMES[activeTab];
    set('perfTitle',    `${name} Performance`);
    set('logTitle',     `Redaction Log — ${name}`);
}

// ── DEFAULT LEXICON SIZE (shared, cached) ────────────────────────────────────

let defaultLexicon = null;

async function getDefaultLexicon() {
    if (defaultLexicon !== null) return defaultLexicon;
    try {
        const res = await fetch(chrome.runtime.getURL('data/default_lexicon.json'));
        const data = await res.json();
        defaultLexicon = Array.isArray(data) ? data : [];
    } catch (_) {
        defaultLexicon = [];
    }
    return defaultLexicon;
}

// ── REDACTING TEXT DISPLAYED ON THE DASHBOARD ITSELF ─────────────────────────
// Page titles logged from browsing history can contain a blocked word verbatim
// (that's frequently *why* the page matched). The dashboard is a normal
// chrome-extension:// page, so the content script never runs on it — nothing
// else redacts this text before it's painted here. These helpers do that.

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildKeywordRegex(keywords, wholeWord, caseSensitive) {
    const clean = [...new Set(keywords.filter(Boolean))].sort((a, b) => b.length - a.length);
    if (!clean.length) return null;
    const pattern  = clean.map(escapeRegExp).join('|');
    const boundary = wholeWord ? '\\b' : '';
    try {
        return new RegExp(`${boundary}(?:${pattern})${boundary}`, caseSensitive ? 'g' : 'gi');
    } catch (_) {
        return null;
    }
}

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// HTML output: matched text wrapped in a blurred, click-to-reveal span (mirrors
// the on-page redaction look), everything else HTML-escaped.
function redactDisplayText(text, regex) {
    if (!text) return '';
    if (!regex) return escapeHtml(text);
    let out = '';
    let lastIndex = 0;
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
        out += escapeHtml(text.slice(lastIndex, m.index));
        out += `<span class="dash-redacted" data-original="${escapeHtml(m[0])}">${escapeHtml(m[0])}</span>`;
        lastIndex = m.index + m[0].length;
        if (m.index === regex.lastIndex) regex.lastIndex++; // avoid infinite loop on zero-width matches
    }
    out += escapeHtml(text.slice(lastIndex));
    return out;
}

// Plain-text output (no markup) for use in title="" tooltips — matches masked
// with bullets rather than blurred, since a title attribute can't render CSS.
function maskText(text, regex) {
    if (!text) return '';
    if (!regex) return text;
    regex.lastIndex = 0;
    return text.replace(regex, m => '•'.repeat(m.length));
}

// ── ENGINE PERFORMANCE ───────────────────────────────────────────────────────

function renderPerformance(stats) {
    const hasData = stats.scans > 0;
    set('perfAvgScan',     hasData ? (stats.sumMs / stats.scans).toFixed(2) : '—');
    set('perfFastestScan', hasData ? stats.minMs.toFixed(2) : '—');
    set('perfScans',       hasData ? stats.scans.toLocaleString() : '—');
    set('perfChars',       hasData ? stats.sumChars.toLocaleString() : '—');
}

// ── TABLE ─────────────────────────────────────────────────────────────────────

function renderTable(log) {
    const tbody = document.getElementById('logBody');
    set('logCount', `${log.length} ${log.length === 1 ? 'entry' : 'entries'}`);

    if (!log.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-row">No data yet. Browse the web with the extension enabled.</td></tr>';
        return;
    }

    tbody.innerHTML = log.map(e => {
        const d      = new Date(e.timestamp);
        const ts     = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        const rawTtl = e.title || e.url || '—';
        const ttl    = redactDisplayText(rawTtl.substring(0, 55), keywordRegex);
        // scanMs is legitimately absent (not broken/missing) for rows that
        // originated purely from a mutation-triggered redaction -- e.g.
        // infinite-scroll content on Reddit -- rather than a full-page scan
        // (see recordMutationRedaction() in src/content/stats.js). Labeling
        // it explicitly avoids this looking like missing data.
        const ms     = e.scanMs != null ? e.scanMs.toFixed(2) : 'live update';
        const ch     = e.scanMs != null ? (e.charsScanned || 0).toLocaleString() : '—';
        const mut    = e.mutationLatencyMs != null
            ? `${e.mutationLatencyMs.toFixed(2)}`
            : '—';

        return `<tr>
            <td class="timestamp">${ts}</td>
            <td title="${maskText(rawTtl, keywordRegex).replace(/"/g, '&quot;')}">${ttl}${rawTtl.length > 55 ? '…' : ''}</td>
            <td><span class="count-badge">${e.count || 0}</span></td>
            <td><span class="ms-badge">${ms}</span></td>
            <td><span class="ms-badge mut-badge">${mut}</span></td>
            <td>${ch}</td>
        </tr>`;
    }).join('');
}

function filterTable() {
    const q = document.getElementById('searchLog').value.trim().toLowerCase();
    renderTable(q
        ? allLog.filter(e =>
            (e.url   || '').toLowerCase().includes(q) ||
            (e.title || '').toLowerCase().includes(q))
        : allLog
    );
}

// ── CLEAR (scoped to the currently viewed engine only) ───────────────────────

async function clearStats() {
    const name = ALGO_NAMES[activeTab];
    if (!confirm(`Clear all ${name} statistics? This cannot be undone. (The other engine's data is untouched.)`)) return;
    const meta = ALGO_META[activeTab];
    await chrome.storage.local.remove([meta.statsKey]);
    allLog = [];
    loadAndRender();
}

// ── EXPORT (scoped to the currently viewed engine only) ──────────────────────

function exportCSV() {
    if (!allLog.length) { alert('No data to export.'); return; }
    const header = ['Timestamp','URL','Title','Engine','Redacted','Scan (ms)','Mutation Latency (ms)','Mutation Samples','Chars'];
    const rows   = allLog.map(e => [
        new Date(e.timestamp).toISOString(),
        e.url   || '',
        (e.title || '').replace(/,/g, ';'),
        ALGO_NAMES[activeTab],
        e.count || 0,
        e.scanMs != null ? e.scanMs.toFixed(2) : '',
        e.mutationLatencyMs != null ? e.mutationLatencyMs.toFixed(2) : '',
        e.mutationSamples || 0,
        e.charsScanned || 0
    ]);
    download(`filter_report_${activeTab}.csv`, [header, ...rows].map(r => r.join(',')).join('\n'), 'text/csv');
}

function exportJSON() {
    if (!allLog.length) { alert('No data to export.'); return; }
    download(`filter_report_${activeTab}.json`,
        JSON.stringify({ engine: ALGO_NAMES[activeTab], exportedAt: new Date().toISOString(), totalEntries: allLog.length, log: allLog }, null, 2),
        'application/json');
}

function download(filename, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = filename;
    a.click();
}

function set(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}