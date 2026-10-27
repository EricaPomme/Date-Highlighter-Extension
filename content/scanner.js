// scanner.js -- DOM walking, match merging, highlighting, and change watching.
// Two rendering strategies share one scan:
//   - Element marks: when a leaf element's whole text is a date, the stage
//     class goes on the element and the page keeps its own text nodes.
//   - Ranges: dates inside running text are registered through the CSS Custom
//     Highlight API, which needs no DOM change at all. Browsers without that
//     API fall back to wrapping matches in spans, which does replace the
//     page's text node.
// Everything this extension injects carries the data-dh attribute, so cleanup
// only ever touches our own nodes.
(function () {
    'use strict';

    const DH = window.DH;

    // Marks anything this extension has styled; used for skip logic.
    const MARKER_CLASS = 'dh-highlight';
    const HIGHLIGHT_SELECTOR = '.' + MARKER_CLASS;
    // Ownership attribute: 'el' for elements we styled directly, 'span' for
    // wrappers we created in the fallback path.
    const OWNED_ATTR = 'data-dh';
    const OWNED_SELECTOR = '[' + OWNED_ATTR + ']';
    // Generic machine-readable date attributes: <time datetime>, [data-datetime].
    const ATTR_SELECTORS = ['time[datetime]', '[data-datetime]'];

    const HTML_NS = 'http://www.w3.org/1999/xhtml';
    // Text in these never carries a date worth marking, and wrapping an
    // <option> or <textarea> would corrupt the page.
    const SKIP_TAGS = new Set([
        'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'TITLE'
    ]);

    const OBS_CONFIG = { childList: true, subtree: true, characterData: true };
    const DEBOUNCE_MS = 250;
    // A page that mutates faster than the debounce must still get scanned.
    const MAX_WAIT_MS = 1000;
    // Queue cap: past this, a whole-subtree rescan is cheaper and bounded.
    const MAX_PENDING = 400;
    const ROLLOVER_MS = 60 * 1000;

    const hasHighlightApi = (function () {
        try {
            return typeof Highlight === 'function' &&
                typeof Highlight.prototype.add === 'function' &&
                typeof CSS !== 'undefined' && !!CSS.highlights &&
                typeof CSS.highlights.set === 'function';
        } catch (err) {
            return false;
        }
    })();

    let settings = null;
    // CSS selectors limiting scans to matching subtrees. Empty = whole page.
    let scopeSelectors = [];
    // Invalid selectors already reported under debug logging; reported once
    // per selector so mutation-driven rescans don't spam the console.
    const invalidReported = new Set();

    let observer = null;
    let debounceTimer = null;
    let rolloverTimer = null;
    let pendingMutations = [];
    let pendingSince = 0;
    let needsFullRescan = false;
    // Day the current highlights were computed for; crossing midnight makes
    // every stage decision on the page stale.
    let scannedDay = null;

    // Ranges registered with the Highlight API, plus a per-text-node index so
    // a rescanned node can drop its own ranges without a full rebuild.
    let rangeEntries = [];
    const nodeRanges = new WeakMap();
    let activeHighlightNames = new Set();

    function reportInvalid(selector) {
        if (!settings || !settings.debug || invalidReported.has(selector)) return;
        invalidReported.add(selector);
        console.warn('[Date Highlighter] ignoring invalid selector: ' + selector);
    }

    function debugLog(message, data) {
        if (!settings || !settings.debug) return;
        if (data === undefined) console.log('[Date Highlighter] ' + message);
        else console.log('[Date Highlighter] ' + message, data);
    }

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
        if (!scopeSelectors.length) return document.body ? [document.body] : [];
        const roots = [];
        for (const selector of scopeSelectors) {
            try {
                for (const el of document.querySelectorAll(selector)) roots.push(el);
            } catch (err) {
                reportInvalid(selector);
            }
        }
        return roots;
    }

    // True inside a contenteditable host: highlighting there would edit the
    // user's own text and move their caret.
    function isEditable(element) {
        if (typeof element.isContentEditable === 'boolean') return element.isContentEditable;
        const host = element.closest('[contenteditable]');
        if (!host) return false;
        return (host.getAttribute('contenteditable') || '').toLowerCase() !== 'false';
    }

    function shouldSkipNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return true;
        if (document.designMode === 'on') return true;
        const parent = node.parentElement;
        if (!parent) return true;
        // Foreign content (inline SVG, MathML): HTML wrappers are not rendered
        // there, and the chip styles do not apply.
        if (parent.namespaceURI !== HTML_NS) return true;
        if (SKIP_TAGS.has(parent.tagName)) return true;
        if (isEditable(parent)) return true;
        // Respect per-domain scope selectors.
        if (!inScope(parent)) return true;
        // Don't re-process nodes already inside a highlight.
        if (parent.closest(HIGHLIGHT_SELECTOR)) return true;
        return false;
    }

    function stageClass(stage) {
        return 'dh-stage-' + stage.id;
    }

    function markElement(element, stage) {
        const className = stageClass(stage);
        if (element.getAttribute(OWNED_ATTR) === 'el') {
            if (element.classList.contains(className)) return;
            unmarkElement(element);
        }
        element.setAttribute(OWNED_ATTR, 'el');
        element.classList.add(MARKER_CLASS, className);
    }

    function unmarkElement(element) {
        element.removeAttribute(OWNED_ATTR);
        element.classList.remove(MARKER_CLASS);
        for (const name of Array.from(element.classList)) {
            if (name.startsWith('dh-stage-')) element.classList.remove(name);
        }
    }

    // Fallback-path cleanup: put the text back and drop the wrapper.
    function unwrapSpan(span) {
        const parent = span.parentNode;
        if (!parent) return;
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
        if (typeof parent.normalize === 'function') parent.normalize();
    }

    // Removes every mark this extension owns inside `root` (default: document).
    function removeMarks(root) {
        const scope = (root && typeof root.querySelectorAll === 'function') ? root : document;
        const owned = [];
        if (scope !== document && scope.getAttribute && scope.getAttribute(OWNED_ATTR)) owned.push(scope);
        for (const el of scope.querySelectorAll(OWNED_SELECTOR)) owned.push(el);
        for (const el of owned) {
            if (el.getAttribute(OWNED_ATTR) === 'span') unwrapSpan(el);
            else unmarkElement(el);
        }
    }

    // Releases an element mark that the page's own text edit invalidated.
    // Returns false when the text is ours - inside a wrapper we created - which
    // callers must leave alone.
    function releaseFromElementMark(node) {
        const parent = node.parentElement;
        if (!parent) return false;
        const owner = parent.closest(OWNED_SELECTOR);
        if (!owner) return true;
        if (owner.getAttribute(OWNED_ATTR) === 'span') return false;
        unmarkElement(owner);
        return true;
    }

    function addRange(node, index, length, stage) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + length);
        const entry = { name: DH.styles.HIGHLIGHT_PREFIX + stage.id, range };
        rangeEntries.push(entry);
        let list = nodeRanges.get(node);
        if (!list) {
            list = [];
            nodeRanges.set(node, list);
        }
        list.push(entry);
    }

    function dropNodeRanges(node) {
        const list = nodeRanges.get(node);
        if (!list || !list.length) return;
        nodeRanges.delete(node);
        for (const entry of list) {
            const index = rangeEntries.indexOf(entry);
            if (index !== -1) rangeEntries.splice(index, 1);
        }
    }

    // Drops ranges whose text has left the document, then republishes the
    // registry: one Highlight per stage, rebuilt from what we still own.
    function syncHighlights() {
        if (!hasHighlightApi) return;
        rangeEntries = rangeEntries.filter(entry => entry.range.startContainer.isConnected);
        const byName = new Map();
        for (const entry of rangeEntries) {
            let list = byName.get(entry.name);
            if (!list) {
                list = [];
                byName.set(entry.name, list);
            }
            list.push(entry.range);
        }
        for (const name of activeHighlightNames) {
            if (!byName.has(name)) CSS.highlights.delete(name);
        }
        for (const [name, ranges] of byName) {
            const highlight = new Highlight();
            for (const range of ranges) highlight.add(range);
            CSS.highlights.set(name, highlight);
        }
        activeHighlightNames = new Set(byName.keys());
    }

    function clearHighlights() {
        if (hasHighlightApi) {
            for (const name of activeHighlightNames) CSS.highlights.delete(name);
        }
        activeHighlightNames = new Set();
        rangeEntries = [];
        removeMarks(document);
    }

    // Merge responds to overlapping matches: earliest index wins, ties go to
    // the longer match so "in two days" beats a stray "two".
    function mergeMatches(text, now) {
        const all = DH.formats.findMatches(text, settings);
        if (settings.fuzzy) {
            for (const match of DH.fuzzy.findMatches(text, now)) all.push(match);
        }
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

    // True when the element's entire visible text is exactly this one match,
    // so the stage can be applied to the element without touching its nodes.
    function canMarkElement(element, node, text, match) {
        if (element === document.documentElement || element === document.body) return false;
        if (element.children.length) return false;
        if (element.childNodes.length !== 1 || element.firstChild !== node) return false;
        if (element.getAttribute(OWNED_ATTR) === 'span') return false;
        return text.trim() === match.text;
    }

    // Fallback for browsers without the Highlight API: wraps each match in a
    // span. This replaces the page's text node, which frameworks that keep
    // their own node references can notice.
    function wrapMatches(textNode, text, matches) {
        const fragment = document.createDocumentFragment();
        let highlighted = 0;
        let lastIndex = 0;
        let wroteSpan = false;

        for (const match of matches) {
            const before = text.slice(lastIndex, match.index);
            if (before) fragment.appendChild(document.createTextNode(before));

            const stage = DH.status.getStage(settings, match.date);
            if (stage && stage.highlight) {
                const span = document.createElement('span');
                span.className = MARKER_CLASS + ' ' + stageClass(stage);
                span.setAttribute(OWNED_ATTR, 'span');
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
        if (wroteSpan && textNode.parentNode) {
            textNode.parentNode.replaceChild(fragment, textNode);
        }
        return wroteSpan ? highlighted : 0;
    }

    function highlightTextNode(textNode, now) {
        if (!textNode.nodeValue) return 0;
        const parent = textNode.parentElement;
        // Element marks follow the page's own text, so re-evaluate them
        // whenever the text under them changes.
        if (parent) {
            const owner = parent.closest(OWNED_SELECTOR);
            if (owner && owner.getAttribute(OWNED_ATTR) === 'el') unmarkElement(owner);
        }
        // A rescan of the same node replaces its ranges rather than adding to them.
        if (hasHighlightApi) dropNodeRanges(textNode);

        const text = textNode.nodeValue;
        const matches = mergeMatches(text, now);
        if (!matches.length) return 0;

        // Whole-text match on a leaf element: style the element, leave its
        // text nodes alone (framework-safe, and gives the full chip styling).
        if (parent && matches.length === 1 && canMarkElement(parent, textNode, text, matches[0])) {
            const stage = DH.status.getStage(settings, matches[0].date);
            if (!stage || !stage.highlight) return 0;
            markElement(parent, stage);
            return 1;
        }

        if (hasHighlightApi) {
            let highlighted = 0;
            for (const match of matches) {
                const stage = DH.status.getStage(settings, match.date);
                if (!stage || !stage.highlight) continue;
                addRange(textNode, match.index, match.length, stage);
                highlighted++;
            }
            return highlighted;
        }

        return wrapMatches(textNode, text, matches);
    }

    function walkText(root, now) {
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

        let highlighted = 0;
        for (const textNode of nodes) highlighted += highlightTextNode(textNode, now);
        return highlighted;
    }

    // Highlights elements carrying machine-readable dates by applying the
    // stage class directly to the element. Returns the number highlighted.
    function processAttrDates(root) {
        let highlighted = 0;
        for (const selector of ATTR_SELECTORS) {
            const found = [];
            try {
                if (root.matches && root.matches(selector)) found.push(root);
                if (root.querySelectorAll) {
                    for (const el of root.querySelectorAll(selector)) found.push(el);
                }
            } catch (err) {
                continue; // invalid selector on this document; skip
            }

            for (const el of found) {
                if (!inScope(el)) continue;
                if (el.getAttribute(OWNED_ATTR)) continue;
                const raw = el.getAttribute('datetime') || el.getAttribute('data-datetime');
                const date = DH.status.dateFromAttribute(raw);
                if (!date) continue;
                const stage = DH.status.getStage(settings, date);
                if (!stage || !stage.highlight) continue;
                markElement(el, stage);
                highlighted++;
            }
        }
        return highlighted;
    }

    function scanRoot(root) {
        if (!root || root.isConnected === false) return 0;
        const now = new Date();
        // Machine-readable attributes first, so a <time> element is marked
        // once instead of nesting a second highlight inside it.
        let highlighted = processAttrDates(root);
        highlighted += walkText(root, now);
        return highlighted;
    }

    function whilePaused(task) {
        if (observer) observer.disconnect();
        try {
            task();
        } finally {
            const root = document.documentElement || document.body;
            if (observer && root) observer.observe(root, OBS_CONFIG);
        }
    }

    // Clears everything and rescans from scratch. Used on restart, when the
    // queue overflows, and when the day rolls over.
    function rebuild() {
        clearHighlights();
        let highlighted = 0;
        for (const root of scopedRoots()) highlighted += scanRoot(root);
        syncHighlights();
        return highlighted;
    }

    function applyMutations(batch) {
        const now = new Date();
        for (const mutation of batch) {
            if (mutation.type === 'childList') {
                const target = mutation.target;
                // Contents changed inside an element mark: that mark described
                // the old text, so release it and re-evaluate the element.
                if (target && target.nodeType === Node.ELEMENT_NODE &&
                    target.getAttribute(OWNED_ATTR) === 'el') {
                    unmarkElement(target);
                    scanRoot(target);
                    continue;
                }
                for (const added of mutation.addedNodes) {
                    if (added.nodeType === Node.ELEMENT_NODE) {
                        scanRoot(added);
                    } else if (added.nodeType === Node.TEXT_NODE) {
                        if (!releaseFromElementMark(added)) continue;
                        if (added.parentElement && !shouldSkipNode(added)) highlightTextNode(added, now);
                    }
                }
            } else if (mutation.type === 'characterData') {
                // Frameworks often update text nodes in-place rather than
                // replacing subtrees, which only fires characterData.
                const node = mutation.target;
                if (!releaseFromElementMark(node)) continue;
                if (shouldSkipNode(node)) continue;
                highlightTextNode(node, now);
            }
        }
    }

    function flushMutations() {
        // A flush that survives a stop() must not resurrect highlights.
        if (!observer) return;
        debounceTimer = null;
        pendingSince = 0;
        const batch = pendingMutations;
        pendingMutations = [];
        let full = needsFullRescan;
        needsFullRescan = false;
        // A tab left open overnight keeps yesterday's stages on screen.
        if (scannedDay && DH.status.dayKey() !== scannedDay) full = true;

        whilePaused(() => {
            if (full) {
                const highlighted = rebuild();
                debugLog('rescan', { highlighted });
            } else {
                applyMutations(batch);
                syncHighlights();
            }
        });
        scannedDay = DH.status.dayKey();
    }

    function scheduleFlush() {
        if (pendingSince === 0) pendingSince = Date.now();
        const elapsed = Date.now() - pendingSince;
        const wait = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - elapsed));
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(flushMutations, wait);
    }

    function onMutations(mutations) {
        if (!needsFullRescan) {
            for (const mutation of mutations) pendingMutations.push(mutation);
            if (pendingMutations.length > MAX_PENDING) {
                needsFullRescan = true;
                pendingMutations = [];
            }
        }
        scheduleFlush();
    }

    function checkRollover() {
        if (!scannedDay || DH.status.dayKey() === scannedDay) return;
        whilePaused(() => {
            const highlighted = rebuild();
            debugLog('day rollover rescan', { highlighted });
        });
        scannedDay = DH.status.dayKey();
    }

    function onVisibilityChange() {
        if (document.visibilityState === 'visible') checkRollover();
    }

    function start(currentSettings, scope) {
        stop();
        settings = currentSettings;
        scopeSelectors = Array.isArray(scope) ? scope : [];
        invalidReported.clear();
        scannedDay = DH.status.dayKey();

        let highlighted = 0;
        for (const root of scopedRoots()) highlighted += scanRoot(root);
        syncHighlights();

        observer = new MutationObserver(onMutations);
        const observeRoot = document.documentElement || document.body;
        if (observeRoot) observer.observe(observeRoot, OBS_CONFIG);
        rolloverTimer = setInterval(checkRollover, ROLLOVER_MS);
        document.addEventListener('visibilitychange', onVisibilityChange);

        debugLog('scan', { scope: scopeSelectors, highlighted, ranges: rangeEntries.length });
    }

    // Re-runs against fresh settings and scope (used when settings change live).
    function restart(newSettings, scope) {
        stop();
        start(newSettings, scope);
    }

    // Leaves the page as it was found: no marks, no ranges, no listeners.
    function stop() {
        if (observer) observer.disconnect();
        observer = null;
        clearTimeout(debounceTimer);
        debounceTimer = null;
        if (rolloverTimer) clearInterval(rolloverTimer);
        rolloverTimer = null;
        document.removeEventListener('visibilitychange', onVisibilityChange);
        pendingMutations = [];
        pendingSince = 0;
        needsFullRescan = false;
        scannedDay = null;
        invalidReported.clear();
        clearHighlights();
    }

    DH.scanner = { start, stop, restart, scanRoot, hasHighlightApi };
})();
