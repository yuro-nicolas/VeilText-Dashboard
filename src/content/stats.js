// ─── STATS TRACKING (per-algorithm, fully separate storage) ─────────────────
//
// Persists the numbers the Dashboard (dashboard.html/js) reads: totals, a
// rolling redaction log, and scan/mutation-latency benchmarks. Aho-Corasick
// and Wu-Manber each get their own storage bucket (textguard_stats_ahocorasick
// / textguard_stats_wumanber) so their numbers on the dashboard never mix,
// regardless of how often the user switches engines mid-session.
//
// This module is purely additive instrumentation: it only ever writes to
// chrome.storage.local under the textguard_stats_* keys and never touches
// the DOM or the redaction/matching logic itself, so it does not change any
// of the extension's core filtering behavior.
(function (VeilText) {
    'use strict';

    function normAlgo(algorithm) { return algorithm === 'wumanber' ? 'wumanber' : 'ahocorasick'; }
    function statsKey(algorithm) { return `textguard_stats_${normAlgo(algorithm)}`; }

    function emptyStats() {
        return { totalRedacted: 0, totalPages: 0, scans: 0, sumMs: 0, minMs: Infinity, sumChars: 0, log: [] };
    }

    // recordScanResult(), recordMutationRedaction(), and
    // updateLogMutationLatency() each do their own async
    // get-modify-set cycle against the SAME storage key. Nothing previously
    // stopped two of these from overlapping -- in particular, a single
    // mutation-observer flush() calls recordLatency() (which can trigger an
    // async flushLatency()/updateLogMutationLatency() write) and then, right
    // after, recordMutationRedaction() -- both starting their own
    // chrome.storage.local.get()/set() pair without waiting for the other to
    // finish. Whichever one's set() lands last silently overwrites whatever
    // the other just wrote (e.g. a freshly computed mutationLatencyMs gets
    // clobbered back to null by a redaction-count update that read the
    // storage before that latency value was written). This queue makes every
    // read-modify-write against textguard_stats_* run strictly one at a time,
    // in call order, so none of them can step on each other.
    let storageQueue = Promise.resolve();
    function withStorageLock(fn) {
        const run = storageQueue.then(fn, fn);
        storageQueue = run.catch(() => {}); // keep the chain alive even if fn() throws/rejects
        return run;
    }

    // Tracks, per algorithm, whether the CURRENT page view has already been
    // counted toward that algorithm's "Pages Scanned" total. Reset on real
    // navigation, so switching engines mid-session still counts as a first
    // page-scan for the newly selected engine, without inflating the count
    // on repeat scans (e.g. keyword edits).
    let pagesCountedForAlgo = new Set();

    // Tracks the exact page (full href, not just hostname) the top log row
    // currently belongs to, so mutation-triggered redactions (e.g. from
    // infinite-scroll) get folded into *that* row instead of either being
    // lost or, after a same-hostname SPA navigation, silently added to a
    // stale row left over from the page the user was previously on.
    let lastLogRowUrl = null;

    function resetPageTracking() {
        pagesCountedForAlgo = new Set();
        lastLogRowUrl = null;
        pageMutationLatency = {};
    }

    // Single read-modify-write per scan (instead of two separate calls that
    // both touched the same storage key) to avoid a lost-update race between
    // the "page scanned" bookkeeping and the "redaction happened" bookkeeping.
    //
    // Called unconditionally on every full-page scan (even when pageCount is
    // 0), so "Scans Run", "Avg. Scan (ms)" and "Total Chars Scanned" on the
    // dashboard reflect every scan actually performed -- not just the ones
    // that found a match.
    async function recordScanResult(pageCount, scanMs, charsScanned, algorithm) {
        // content scripts run in every iframe on the page (manifest
        // all_frames: true), so matches get found and redacted independently
        // in each frame. That's needed for filtering to work inside iframes,
        // but the dashboard's log/stats are meant to represent one row per
        // page view -- letting every frame write its own row would look like
        // extra "tabs" scanning, or produce back-to-back duplicate entries
        // for one real visit.
        if (window.top !== window) return;

        const algo = normAlgo(algorithm);
        const countPage = !pagesCountedForAlgo.has(algo);
        if (countPage) pagesCountedForAlgo.add(algo);

        const key = statsKey(algo);
        await withStorageLock(async () => {
        try {
            const result = await chrome.storage.local.get([key]);
            const stats = result[key] || emptyStats();

            if (countPage) stats.totalPages += 1;
            stats.scans += 1;
            stats.sumMs += scanMs;
            stats.minMs = Math.min(stats.minMs, scanMs);
            stats.sumChars += charsScanned;

            if (pageCount > 0) {
                stats.totalRedacted += pageCount;
                stats.log.unshift({
                    url: location.hostname || location.href,
                    title: document.title || location.href,
                    count: pageCount,
                    scanMs: Math.round(scanMs * 100) / 100,
                    charsScanned,
                    mutationLatencyMs: null,
                    mutationSamples: 0,
                    timestamp: Date.now()
                });
                if (stats.log.length > 200) stats.log = stats.log.slice(0, 200);
                lastLogRowUrl = location.href;
            }

            await chrome.storage.local.set({ [key]: stats });
        } catch (_) {}
        });
    }

    // Mutation-triggered redactions (infinite scroll, chat messages
    // appearing, etc.) only bump the visible badge counter on their own --
    // this brings them into the same persisted stats the initial full-page
    // scan writes to, so totalRedacted/the log on the dashboard don't fall
    // behind what the badge shows.
    async function recordMutationRedaction(algorithm, mutationCount) {
        if (mutationCount <= 0) return;
        if (window.top !== window) return; // see note in recordScanResult
        const algo = normAlgo(algorithm);
        const key = statsKey(algo);
        await withStorageLock(async () => {
        try {
            const result = await chrome.storage.local.get([key]);
            const stats = result[key] || emptyStats();
            stats.totalRedacted += mutationCount;

            if (lastLogRowUrl === location.href && stats.log.length > 0) {
                stats.log[0].count += mutationCount;
            } else {
                stats.log.unshift({
                    url: location.hostname || location.href,
                    title: document.title || location.href,
                    count: mutationCount,
                    scanMs: null,          // no full-page scan behind this row -- it's scroll/DOM-update driven
                    charsScanned: 0,
                    mutationLatencyMs: null,
                    mutationSamples: 0,
                    timestamp: Date.now()
                });
                if (stats.log.length > 200) stats.log = stats.log.slice(0, 200);
                lastLogRowUrl = location.href;
            }

            await chrome.storage.local.set({ [key]: stats });
        } catch (_) {}
        });
    }

    // ─── LATENCY TRACKING (also split per algorithm) ─────────────────────────
    //
    // "Mutation latency" measures the real, end-to-end delay a user would
    // experience between new content appearing in the DOM (e.g. infinite
    // scroll, a chat message arriving) and this extension finishing
    // filtering it -- i.e. (time redaction was applied) - (time the mutation
    // was first observed). That includes the observer's own debounce window,
    // so it reports the actual perceived latency, not just raw matcher CPU
    // time.

    const latencyBuffer = []; // { ms, algorithm }

    // Per-algorithm running average of DOM mutation latency *for the page
    // currently being viewed*. Reset whenever the page navigates, so the
    // figure written into the redaction-log row always reflects mutations
    // observed on that specific page view, not a stale figure carried over
    // from wherever the user was browsing before.
    let pageMutationLatency = {}; // { [algo]: { sum, count } }

    function recordLatency(ms, algorithm) {
        latencyBuffer.push({ ms, algorithm });
        if (latencyBuffer.length >= 10) flushLatency();
    }

    async function flushLatency() {
        if (latencyBuffer.length === 0) return;
        const samples = latencyBuffer.splice(0);

        const byAlgo = {};
        for (const s of samples) {
            const a = normAlgo(s.algorithm);
            (byAlgo[a] || (byAlgo[a] = [])).push(s.ms);
        }

        for (const algo of Object.keys(byAlgo)) {
            // Fold this batch into the running per-page average, then stamp
            // it onto the most recent redaction-log row (the entry for the
            // page currently being viewed), so the log shows mutation
            // latency alongside scan time.
            const acc = pageMutationLatency[algo] || (pageMutationLatency[algo] = { sum: 0, count: 0 });
            for (const ms of byAlgo[algo]) { acc.sum += ms; acc.count += 1; }
            await updateLogMutationLatency(algo, acc);
        }
    }

    async function updateLogMutationLatency(algo, acc) {
        const key = statsKey(algo);
        await withStorageLock(async () => {
        try {
            const result = await chrome.storage.local.get([key]);
            const stats = result[key];
            if (!stats || !stats.log || stats.log.length === 0) return;
            // stats.log is shared storage across every tab/frame running
            // this algorithm -- log[0] is only "this page's row" if this
            // page (or a mutation on it) was the one that put it there.
            // Without this check, whichever tab most recently touched the
            // log "wins" the top row and every other tab's mutation latency
            // silently overwrites it instead of updating its own (or simply
            // having nowhere to go).
            if (lastLogRowUrl !== location.href) return;
            stats.log[0].mutationLatencyMs = Math.round((acc.sum / acc.count) * 100) / 100;
            stats.log[0].mutationSamples = acc.count;
            await chrome.storage.local.set({ [key]: stats });
        } catch (_) {}
        });
    }

    window.addEventListener('pagehide', flushLatency);

    VeilText.Stats = VeilText.Stats || {};
    VeilText.Stats.normAlgo = normAlgo;
    VeilText.Stats.resetPageTracking = resetPageTracking;
    VeilText.Stats.recordScanResult = recordScanResult;
    VeilText.Stats.recordMutationRedaction = recordMutationRedaction;
    VeilText.Stats.recordLatency = recordLatency;
    VeilText.Stats.flushLatency = flushLatency;
})(window.VeilText);
