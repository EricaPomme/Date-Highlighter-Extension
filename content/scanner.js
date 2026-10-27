// scanner.js -- DOM walking, match merging, highlighting, and change watching.
// Generalized from the Jira Date Redifier content script.
(function () {
    'use strict';

    const DH = window.DH;

    // Marks anything this extension has injected; used for skip logic.
    const MARKER_CLASS = 'dh-highlight';
    const HIGHLIGHT_SELECTOR = '.' + MARKER_CLASS;
    // Generic machine-readable date attributes: <time datetime>, [data-datetime].
    const ATTR_SELECTORS = ['time[datetime]', '[data-datetime]'];

    let settings = null;
    // CSS selectors limiting scans to matching subtrees. Empty = whole page.
    let scopeSelectors = [];
    // Invalid selectors already reported under debug logging; reported once
    // per selector so mutation-driven rescans don't spam the console.
    const invalidReported = new Set();

    function reportInvalid(selector) {
        if (!settings || !settings.debug || invalidReported.has(selector)) return;
        invalidReported.add(selector);
        console.warn('[Date Highlighter] ignoring invalid selector: ' + selector);
    }
    let observer = null;
    let debounceTimer = null;
    let pendingMutations = [];
    const OBS_CONFIG = { childList: true, subtree: true, characterData: true };

    // True when the element sits inside (or is) a scope root. Invalid
    // selectors are skipped so one bad entry never disables the rest.
    function inScope(el) {
        if (!scopeSelectors.length) return true;
        if (!el || !el.closest) return false;
        for (const selector of scopeSelectors) {
            try {
                if (el.closest(selector)) return true;
            } catch (err) {
                reportInvalid(selector);
            }
        }
        return false;
    }

    // Elements matching the scope selectors right now. Re-queried on every
    // scan so SPA re-renders that replace scope roots stay covered.
    function scopedRoots() {
        if (!scopeSelectors.length) return [document.body];
        const roots = [];
        for (const selector of scopeSelectors) {
            try {
                roots.push(...document.querySelectorAll(selector));
            } catch (err) {
                reportInvalid(selector);
            }
        }
        return roots;
    }

    function shouldSkipNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return true;
        const parent = node.parentElement;
        if (!parent) return true;
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT'].includes(parent.tagName)) return true;
        // Respect per-domain scope selectors.
        if (!inScope(parent)) return true;
        // Don't re-process nodes already inside a highlight span.
        if (parent.closest(HIGHLIGHT_SELECTOR)) return true;
        return false;
    }

    // Merges format and fuzzy matches. Overlapping matches resolve to the
    // earliest index; ties go to the longer match so "in two days" wins over
    // a stray "two" that a numeric format might grab.
    function mergeMatches(text, today) {
        const all = DH.formats.findMatches(text, settings);
        if (settings.fuzzy) all.push(...DH.fuzzy.findMatches(text, today));
        all.sort((a, b) => (a.index - b.index) || (b.length - a.length));

        const merged = [];
        let pos = 0;
        for (const match of all) {
            if (match.index < pos) continue; // fully or partly covered already
            merged.push(match);
            pos = match.index + match.length;
        }
        return merged;
    }

    function highlightTextNode(textNode, today) {
        const text = textNode.nodeValue;
        const matches = mergeMatches(text, today);
        if (!matches.length) return 0;
        let highlighted = 0;

        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let wroteSpan = false;

        for (const match of matches) {
            const before = text.slice(lastIndex, match.index);
            if (before) fragment.appendChild(document.createTextNode(before));

            const stage = DH.status.getStage(settings, match.date);
            if (stage && stage.highlight) {
                const span = document.createElement('span');
                span.className = MARKER_CLASS + ' dh-stage-' + stage.id;
                span.textContent = match.text;
                fragment.appendChild(span);
                wroteSpan = true;
                highlighted++;
            } else {
                fragment.appendChild(document.createTextNode(match.text));
            }

            lastIndex = match.index + match.length;
        }

        const after = text.slice(lastIndex);
        if (after) fragment.appendChild(document.createTextNode(after));

        // Only touch the DOM if we actually highlighted something.
        if (wroteSpan) {
            textNode.parentNode.replaceChild(fragment, textNode);
        }
        return highlighted;
    }

    // Highlights elements carrying machine-readable dates by applying the
    // stage class directly to the element. Returns the number highlighted.
    function processAttrDates(root, today) {
        let highlighted = 0;
        for (const selector of ATTR_SELECTORS) {
            let found = [];
            try {
                found = root.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : [];
            } catch (err) {
                continue; // invalid selector on this document; skip
            }
            if (root.matches && root.matches(selector)) found.push(root);

            for (const el of found) {
                if (!inScope(el)) continue;
                if (el.classList.contains(MARKER_CLASS)) continue;
                const raw = el.getAttribute('datetime') || el.getAttribute('data-datetime');
                if (!raw) continue;
                const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
                if (!m) continue;
                const date = new Date(+m[1], +m[2] - 1, +m[3]);
                const stage = DH.status.getStage(settings, date);
                if (stage && stage.highlight) {
                    el.classList.add(MARKER_CLASS, 'dh-stage-' + stage.id);
                    highlighted++;
                }
            }
        }
        return highlighted;
    }

    function walkAndHighlight(root) {
        const today = DH.status.getToday();
        let highlightCount = 0;

        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    return shouldSkipNode(node)
                        ? NodeFilter.FILTER_REJECT
                        : NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        // Collect first, then mutate -- avoids walker invalidation.
        const nodes = [];
        let node;
        while ((node = walker.nextNode())) nodes.push(node);
        for (const n of nodes) {
            highlightCount += highlightTextNode(n, today);
        }

        highlightCount += processAttrDates(root, today);

        if (settings && settings.debug && !scopeSelectors.length) {
            console.log('[Date Highlighter] scan', { textNodes: nodes.length, highlighted: highlightCount });
        }
    }

    function flushMutations() {
        const batch = pendingMutations;
        pendingMutations = [];

        // Pause observation while we mutate the DOM ourselves.
        observer.disconnect();

        for (const mutation of batch) {
            if (mutation.type === 'childList') {
                for (const added of mutation.addedNodes) {
                    if (added.nodeType === Node.ELEMENT_NODE && inScope(added)) {
                        walkAndHighlight(added);
                    }
                }
            } else if (mutation.type === 'characterData') {
                // Frameworks often update text nodes in-place rather than
                // replacing subtrees, which only fires characterData.
                const parent = mutation.target.parentElement;
                if (parent && inScope(parent)) walkAndHighlight(parent);
            }
        }

        observer.observe(document.body, OBS_CONFIG);
    }

    function start(currentSettings, scope) {
        settings = currentSettings;
        scopeSelectors = Array.isArray(scope) ? scope : [];
        invalidReported.clear();

        for (const root of scopedRoots()) walkAndHighlight(root);

        observer = new MutationObserver((mutations) => {
            pendingMutations.push(...mutations);
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(flushMutations, 250);
        });
        observer.observe(document.body, OBS_CONFIG);
    }

    // Re-runs against fresh settings and scope (used when settings change live).
    function restart(newSettings, scope) {
        stop();
        start(newSettings, scope);
    }

    function stop() {
        if (observer) observer.disconnect();
        observer = null;
        clearTimeout(debounceTimer);
        pendingMutations = [];
    }

    DH.scanner = { start, stop, restart, walkAndHighlight };
})();
