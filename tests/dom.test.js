// dom.test.js -- scanner and stylesheet tests in a simulated page.
// Requires jsdom (npm install). Every scenario runs against a page whose clock
// is fixed, so expectations never depend on the wall clock, and the suite
// covers both rendering paths: the CSS Custom Highlight API and the span
// fallback used by older browsers.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const MARKER = 'dh-highlight';
const OWNED = 'data-dh';
const SCRIPT_FILES = [
    'content/core/api.js',
    'content/core/settings.js',
    'content/core/status.js',
    'content/core/detect/formats.js',
    'content/core/detect/fuzzy.js',
    'content/core/styles.js',
    'content/scanner.js'
];

const SOURCE_BY_FILE = new Map(
    SCRIPT_FILES.concat('content/content.js')
        .map(file => [file, fs.readFileSync(path.join(ROOT, file), 'utf8')])
);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function localIso(date) {
    return date.getFullYear() + '-' +
        String(date.getMonth() + 1).padStart(2, '0') + '-' +
        String(date.getDate()).padStart(2, '0');
}

// Shifts the page clock to start at `start` while still advancing in real
// time (a frozen clock would also freeze the debounce). Tests can move it
// forward to simulate midnight rollover.
function installFixedClock(window, start) {
    const RealDate = window.Date;
    let offset = start.getTime() - RealDate.now();
    class FakeDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) super(RealDate.now() + offset);
            else super(...args);
        }
        static now() { return RealDate.now() + offset; }
    }
    window.Date = FakeDate;
    return {
        set(date) { offset = date.getTime() - RealDate.now(); }
    };
}

// Minimal stand-in for the CSS Custom Highlight API so the primary rendering
// path is exercised in Node.
function installHighlightApi(window) {
    class FakeHighlight {
        constructor() { this.ranges = new Set(); }
        add(range) { this.ranges.add(range); return this; }
        get size() { return this.ranges.size; }
    }
    const registry = new Map();
    Object.defineProperty(window, 'Highlight', { value: FakeHighlight, configurable: true, writable: true });
    const css = window.CSS || {};
    Object.defineProperty(css, 'highlights', { value: registry, configurable: true, writable: true });
    Object.defineProperty(window, 'CSS', { value: css, configurable: true, writable: true });
    return registry;
}

// The Firefox shape installs promises on browser.* and models the legacy
// chrome.* porting alias without promise support, so a source file that
// reaches for chrome.* cannot pass by accident.
function callbackOnlyApi(api) {
    const wrap = fn => (...args) => {
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        const promise = fn(...args);
        if (callback) promise.then(result => callback(result));
        return undefined;
    };
    return {
        storage: {
            sync: {
                get: wrap((key) => api.storage.sync.get(key)),
                set: wrap((items) => api.storage.sync.set(items))
            }
        }
    };
}

function createPage(options) {
    const opts = options || {};
    const dom = new JSDOM('<!DOCTYPE html><html><head></head><body>' + (opts.html || '') + '</body></html>', {
        url: opts.url || 'https://example.com/',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const window = dom.window;
    const store = Object.assign({}, opts.stored);
    const listeners = [];
    const api = {
        runtime: {},
        storage: {
            sync: {
                async get(key) {
                    return Object.prototype.hasOwnProperty.call(store, key) ? { [key]: store[key] } : {};
                },
                async set(items) { Object.assign(store, items); }
            },
            onChanged: {
                addListener(listener) { listeners.push(listener); },
                fire(changes) { for (const listener of listeners) listener(changes, 'sync'); }
            }
        }
    };
    // Chromium shape by default; 'browser' is the Firefox shape, where
    // promise-based calls live on browser.* only.
    if (opts.namespace === 'browser') {
        window.browser = api;
        window.chrome = callbackOnlyApi(api);
    } else {
        window.chrome = api;
    }
    const clock = installFixedClock(window, opts.now || BASE);
    const registry = opts.highlightApi ? installHighlightApi(window) : null;
    const files = opts.withContent ? SCRIPT_FILES.concat('content/content.js') : SCRIPT_FILES;
    for (const file of files) window.eval(SOURCE_BY_FILE.get(file));

    const page = {
        dom,
        window,
        document: window.document,
        DH: window.DH,
        clock,
        registry,
        settings: JSON.parse(JSON.stringify(window.DH.settings.DEFAULTS)),
        usingHighlightApi: window.DH.scanner.hasHighlightApi,
        start(scope, overrides) {
            const active = overrides
                ? Object.assign({}, page.settings, overrides)
                : page.settings;
            window.DH.scanner.start(active, scope || []);
            return active;
        },
        // Highlights are ranges under the Highlight API and elements otherwise.
        ranges() {
            if (!registry) return 0;
            let total = 0;
            for (const highlight of registry.values()) total += highlight.size;
            return total;
        },
        marks() {
            return window.document.querySelectorAll('.' + MARKER).length;
        },
        owned() {
            return window.document.querySelectorAll('[' + OWNED + ']').length;
        },
        stop() { window.DH.scanner.stop(); },
        // Fires a storage change as the extension's other pages would.
        changeSettings(patch) {
            store.settings = Object.assign({}, store.settings, patch);
            for (const listener of listeners) listener({ settings: { newValue: store.settings } }, 'sync');
        },
        close() {
            window.DH.scanner.stop();
            dom.window.close();
        }
    };
    return page;
}

const BASE = new Date(2026, 9, 27, 10, 0, 0); // 2026-10-27 10:00 local
const TODAY = localIso(BASE);
const YESTERDAY = '2026-10-26';
const TOMORROW = '2026-10-28';

const tests = [];
const test = (name, run) => tests.push({ name, run });

test('the page clock starts at the fixed test date', async () => {
    const page = createPage({ html: '' });
    assert.strictEqual(page.DH.status.dayKey(), TODAY, 'expectations below assume this date');
    page.close();
});

// --- element marking ------------------------------------------------------

for (const highlightApi of [false, true]) {
    const mode = highlightApi ? 'Highlight API' : 'fallback spans';

    test('whole-text date marks the element and keeps its text node [' + mode + ']', async () => {
        const page = createPage({ html: '<table><tr><td id="due">' + TODAY + '</td></tr></table>', highlightApi });
        const cell = page.document.getElementById('due');
        const textNode = cell.firstChild;
        page.start();
        const active = page.settings;

        assert.strictEqual(cell.firstChild, textNode, 'the page text node must be left in place');
        assert.ok(cell.classList.contains(MARKER));
        assert.ok(cell.classList.contains('dh-stage-' + page.DH.status.getStage(active, BASE).id));
        assert.strictEqual(page.marks(), 1);
        assert.strictEqual(page.ranges(), 0, 'element marks never need ranges');
        page.close();
    });

    test('a page text edit clears the stale mark [' + mode + ']', async () => {
        const page = createPage({ html: '<p id="x">' + TODAY + '</p>', highlightApi });
        const paragraph = page.document.getElementById('x');
        const textNode = paragraph.firstChild;
        page.start();
        assert.strictEqual(page.marks(), 1);

        textNode.nodeValue = 'nothing to see here'; // framework commit
        await sleep(400);
        assert.strictEqual(paragraph.textContent, 'nothing to see here');
        assert.strictEqual(page.marks(), 0, 'the mark described the old text');
        assert.strictEqual(page.owned(), 0);
        page.close();
    });

    test('framework replaces the text node inside a mark [' + mode + ']', async () => {
        const page = createPage({ html: '<p id="x">' + TODAY + '</p>', highlightApi });
        const paragraph = page.document.getElementById('x');
        page.start();
        assert.strictEqual(page.marks(), 1);

        paragraph.textContent = TOMORROW; // new text node, same element
        await sleep(400);
        assert.ok(paragraph.classList.contains('dh-stage-tomorrow'), 'mark follows the new text');
        assert.strictEqual(page.marks(), 1);
        page.close();
    });

    test('dates inside running text are highlighted without breaking the text [' + mode + ']', async () => {
        const page = createPage({ html: '<p id="p">Due on ' + TODAY + ' please</p>', highlightApi });
        const before = page.document.body.innerHTML;
        page.start();

        assert.strictEqual(page.document.getElementById('p').textContent, 'Due on ' + TODAY + ' please');
        if (page.usingHighlightApi) {
            assert.strictEqual(page.document.body.innerHTML, before, 'no DOM change at all');
            assert.strictEqual(page.ranges(), 1);
            assert.strictEqual(page.owned(), 0);
        } else {
            assert.strictEqual(page.marks(), 1);
            assert.strictEqual(page.owned(), 1);
            assert.strictEqual(page.document.querySelector('[' + OWNED + '="span"]').textContent, TODAY);
        }
        page.close();
    });

    test('stop() leaves the page exactly as it was found [' + mode + ']', async () => {
        const page = createPage({ html: '<p id="p">Due on ' + TODAY + ' please</p>', highlightApi });
        const before = page.document.body.innerHTML;
        page.start();
        page.stop();

        assert.strictEqual(page.document.body.innerHTML, before, 'text and nodes restored');
        assert.strictEqual(page.marks(), 0);
        assert.strictEqual(page.ranges(), 0);

        page.DH.styles.inject(page.settings);
        assert.ok(page.document.getElementById('dh-styles'));
        page.DH.styles.remove();
        assert.strictEqual(page.document.getElementById('dh-styles'), null);
        page.close();
    });

    test('restart() drops highlights when a stage stops highlighting [' + mode + ']', async () => {
        const page = createPage({ html: '<p id="p">Due on ' + TODAY + ' please</p><p id="plain">' + TODAY + '</p>', highlightApi });
        const active = page.start();
        assert.ok(page.marks() + page.ranges() >= 2);

        const todayStage = active.stages.find(stage => stage.id === 'today');
        todayStage.highlight = false;
        page.window.DH.scanner.start(active, []);
        assert.strictEqual(page.marks(), 0, 'stale styling must go');
        assert.strictEqual(page.ranges(), 0);
        page.close();
    });

    test('scoped sites pick up content rendered after boot [' + mode + ']', async () => {
        const page = createPage({ html: '<div id="app"></div>', highlightApi });
        page.start(['td.due']);

        page.document.getElementById('app').innerHTML =
            '<table><tr><td class="due">' + TODAY + '</td><td class="other">' + TODAY + '</td></tr></table>';
        await sleep(400);

        assert.strictEqual(page.marks(), 1, 'only the scoped cell is highlighted');
        assert.ok(page.document.querySelector('td.due.' + MARKER));
        assert.strictEqual(page.document.querySelector('td.other.' + MARKER), null);
        page.close();
    });

    test('textContent updates are scanned [' + mode + ']', async () => {
        const page = createPage({ html: '<div id="cell">loading</div>', highlightApi });
        page.start();

        page.document.getElementById('cell').textContent = 'Due ' + TODAY;
        await sleep(400);
        assert.strictEqual(page.marks() + page.ranges(), 1);
        page.close();
    });
}

// --- pages to leave alone -------------------------------------------------

test('editable regions are never touched', async () => {
    const page = createPage({ html: '<div id="ed" contenteditable="true">Meeting on ' + TODAY + '</div>' });
    page.start();

    const editor = page.document.getElementById('ed');
    assert.strictEqual(page.marks(), 0);
    assert.strictEqual(page.owned(), 0);

    editor.firstChild.nodeValue = 'Meeting on ' + TOMORROW + ' at noon';
    await sleep(400);
    assert.strictEqual(editor.textContent, 'Meeting on ' + TOMORROW + ' at noon');
    assert.strictEqual(page.marks(), 0);
    page.close();
});

test('inline SVG text and styles are left alone', async () => {
    const page = createPage({
        html: '<svg><text id="lbl">' + TODAY + '</text><style id="css">/* ' + TODAY + ' */ text { fill: red }</style></svg>'
    });
    const before = page.document.body.innerHTML;
    page.start();

    assert.strictEqual(page.document.getElementById('lbl').textContent, TODAY);
    assert.strictEqual(page.document.getElementById('css').textContent, '/* ' + TODAY + ' */ text { fill: red }');
    assert.strictEqual(page.marks(), 0);
    assert.strictEqual(page.document.body.innerHTML, before);
    page.close();
});

test('a <time> element is marked once, with no highlight nested inside it', async () => {
    const page = createPage({ html: '<time id="t" datetime="' + TODAY + '">October 27, 2026</time>', highlightApi: true });
    page.start();

    const time = page.document.getElementById('t');
    assert.strictEqual(time.getAttribute(OWNED), 'el');
    assert.ok(time.classList.contains('dh-stage-today'));
    assert.strictEqual(page.marks(), 1);
    assert.strictEqual(page.ranges(), 0, 'no inner range');
    assert.strictEqual(time.querySelector('.' + MARKER), null);
    page.close();
});

test('datetime instants map to their local calendar date', async () => {
    const evening = new Date(2026, 9, 27, 20, 0, 0); // 8 PM local, next day in UTC
    const page = createPage({
        html: '<time id="t" datetime="' + evening.toISOString() + '">later</time><span id="d" data-datetime="' + TOMORROW + '">x</span>',
        now: evening
    });
    page.start();

    // Under UTC the two agree, so this only fails in timezones where the
    // instant's UTC date differs from the local one (the earlier bug).
    assert.ok(page.document.getElementById('t').classList.contains('dh-stage-today'));
    assert.ok(page.document.getElementById('d').classList.contains('dh-stage-tomorrow'));
    page.close();
});

// --- time-of-day handling -------------------------------------------------

test('"N minutes ago" and "in N hours" use the clock, not midnight', async () => {
    const page = createPage({ html: '<p id="a">5 minutes ago</p>', now: BASE });
    page.start();

    // 10:00 minus five minutes is still today; a midnight base made it overdue.
    assert.ok(page.document.getElementById('a').classList.contains('dh-stage-today'));

    page.document.getElementById('a').textContent = 'in 12 hours';
    await sleep(400);
    assert.ok(page.document.getElementById('a').classList.contains('dh-stage-today'),
        '10:00 plus 12 hours is still today');

    page.document.getElementById('a').textContent = 'in 20 hours';
    await sleep(400);
    assert.ok(page.document.getElementById('a').classList.contains('dh-stage-tomorrow'));
    page.close();
});

// --- observer behaviour ---------------------------------------------------

test('continuous DOM churn still gets scanned', async () => {
    const page = createPage({ html: '<span id="tick">0</span><div id="feed"></div>', now: BASE });
    page.start();

    let count = 0;
    const ticker = page.window.setInterval(() => {
        page.document.getElementById('tick').textContent = String(++count);
    }, 100);

    const item = page.document.createElement('p');
    item.textContent = TODAY;
    page.document.getElementById('feed').appendChild(item);

    await sleep(1600);
    page.window.clearInterval(ticker);
    const found = page.usingHighlightApi ? page.ranges() : page.marks();
    assert.ok(found >= 1, 'the maximum wait must force a flush (found ' + found + ')');

    page.close();
});

test('a mutation flood falls back to a full rescan', async () => {
    const page = createPage({ html: '<div id="feed"></div>', now: BASE });
    page.start();

    const feed = page.document.getElementById('feed');
    for (let i = 0; i < 450; i++) {
        const item = page.document.createElement('span');
        item.textContent = 'item ' + i + ' ' + TODAY;
        feed.appendChild(item);
    }

    await sleep(600);
    const found = page.usingHighlightApi ? page.ranges() : page.marks();
    assert.strictEqual(found, 450, 'every new date is highlighted, without a RangeError');
    page.close();
});

test('crossing midnight re-buckets the page', async () => {
    const page = createPage({ html: '<p id="p">' + TODAY + '</p>', now: BASE });
    page.start();
    assert.ok(page.document.getElementById('p').classList.contains('dh-stage-today'));

    page.clock.set(new Date(2026, 9, 28, 10, 0, 0)); // next day
    const nudge = page.document.createElement('span');
    nudge.textContent = 'x';
    page.document.body.appendChild(nudge);
    await sleep(400);

    assert.ok(page.document.getElementById('p').classList.contains('dh-stage-overdue'),
        'yesterday\'s "today" is now overdue');
    page.close();
});

// --- stylesheet -----------------------------------------------------------

test('stored colours cannot break out of the stylesheet', async () => {
    const page = createPage({ html: '' });
    const hostile = JSON.parse(JSON.stringify(page.settings));
    const todayStage = hostile.stages.find(stage => stage.id === 'today');
    todayStage.light.color = '</style><script>alert(1)</script>';
    todayStage.light.bg = 'url(javascript:alert(1))';

    const css = page.DH.styles.buildCss(hostile);
    assert.ok(!css.includes('<script'), 'hostile colour must not reach the stylesheet');
    assert.ok(!css.includes('javascript:'));
    assert.ok(css.includes('--dh-today-color: inherit'));

    const safe = page.DH.styles.buildCss(page.settings);
    assert.ok(safe.includes('--dh-today-color: ' + todayStageColor(page.settings)));
    assert.ok(safe.includes('::highlight(dh-today)'), 'range styling is emitted');
    assert.ok(safe.includes('prefers-color-scheme: dark'), 'auto theme keeps both palettes');
    page.close();
});

function todayStageColor(settings) {
    const stage = settings.stages.find(item => item.id === 'today');
    return stage.light.color;
}

// --- activation gate (content.js) -----------------------------------------

test('content script activates only on whitelisted sites, and deactivates live', async () => {
    const page = createPage({
        html: '<p>Due ' + TODAY + '</p>',
        url: 'https://jira.example.com/browse/AB-1',
        stored: { settings: { whitelist: { 'jira.example.com': [] } } },
        withContent: true
    });
    await sleep(60);

    assert.ok(page.document.getElementById('dh-styles'), 'styles injected');
    assert.strictEqual(page.marks(), 1);
    assert.strictEqual(page.document.querySelector('p').textContent, 'Due ' + TODAY);

    // Untracking the site in the popup must clear the open tab immediately.
    page.changeSettings({ whitelist: {} });
    await sleep(60);
    assert.strictEqual(page.marks(), 0, 'highlights removed');
    assert.strictEqual(page.document.getElementById('dh-styles'), null, 'stylesheet removed');
    assert.strictEqual(page.owned(), 0);

    // Re-tracking turns it back on without a reload.
    page.changeSettings({ whitelist: { 'jira.example.com': [] } });
    await sleep(60);
    assert.strictEqual(page.marks(), 1);
    page.close();
});

test('content script stays dormant elsewhere, and when switched off', async () => {
    const elsewhere = createPage({
        html: '<p>Due ' + TODAY + '</p>',
        url: 'https://unlisted.example/',
        stored: { settings: { whitelist: { 'jira.example.com': [] } } },
        withContent: true
    });
    await sleep(60);
    assert.strictEqual(elsewhere.marks(), 0);
    assert.strictEqual(elsewhere.document.getElementById('dh-styles'), null);
    elsewhere.close();

    const disabled = createPage({
        html: '<p>Due ' + TODAY + '</p>',
        stored: { settings: { whitelist: { '*': [] }, enabled: false } },
        withContent: true
    });
    await sleep(60);
    assert.strictEqual(disabled.marks(), 0);
    assert.strictEqual(disabled.document.getElementById('dh-styles'), null);

    // Switching the master switch on applies to open tabs.
    disabled.changeSettings({ enabled: true });
    await sleep(60);
    assert.strictEqual(disabled.marks(), 1);
    disabled.close();
});

// --- Firefox namespace shape ----------------------------------------------

test('content script works when only browser.* carries promises', async () => {
    const page = createPage({
        html: '<p>Due ' + TODAY + '</p>',
        url: 'https://jira.example.com/browse/AB-1',
        stored: { settings: { whitelist: { 'jira.example.com': [] } } },
        withContent: true,
        namespace: 'browser'
    });
    await sleep(60);

    assert.strictEqual(page.window.DH.api, page.window.browser,
        'the promise-based namespace must win over the callback-only alias');
    assert.ok(page.document.getElementById('dh-styles'), 'settings loaded and styles injected');
    assert.strictEqual(page.marks(), 1);

    page.changeSettings({ whitelist: {} });
    await sleep(60);
    assert.strictEqual(page.marks(), 0, 'live updates still apply');
    page.close();
});

test('settings round-trip through storage in the Firefox shape', async () => {
    // Guard against resolving the callback-only namespace: that makes load()
    // return defaults and save() throw instead of persisting.
    const page = createPage({ html: '', namespace: 'browser' });
    const clean = Object.assign({}, page.window.DH.settings.DEFAULTS, { whitelist: { 'a.com': ['td'] } });

    const saved = await page.window.DH.settings.save(clean);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(saved.whitelist)), { 'a.com': ['td'] });

    const loaded = await page.window.DH.settings.load();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(loaded.whitelist)), { 'a.com': ['td'] },
        'stored settings must come back rather than the defaults');
    page.close();
});

// --- static wiring --------------------------------------------------------

// Catches typos between the markup and the scripts that drive it, plus any
// manifest path that no longer exists.
test('extension pages and the manifest are wired consistently', async () => {
    const pairs = [
        ['popup/popup.html', 'popup/popup.js'],
        ['options/options.html', 'options/options.js']
    ];
    for (const [htmlFile, jsFile] of pairs) {
        const html = fs.readFileSync(path.join(ROOT, htmlFile), 'utf8');
        const script = fs.readFileSync(path.join(ROOT, jsFile), 'utf8');
        const dom = new JSDOM(html);
        for (const match of script.matchAll(/getElementById\('([^']+)'\)/g)) {
            assert.ok(dom.window.document.getElementById(match[1]),
                htmlFile + ' is missing #' + match[1] + ' used by ' + jsFile);
        }
        dom.window.close();
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const referenced = [
        manifest.action.default_popup,
        manifest.options_ui.page
    ];
    for (const entry of manifest.content_scripts) {
        for (const file of entry.js) referenced.push(file);
    }
    for (const file of referenced) {
        assert.ok(fs.existsSync(path.join(ROOT, file)), 'manifest references missing file ' + file);
    }
    assert.ok(!manifest.permissions.includes('tabs'), 'activeTab replaces the tabs permission');
    assert.ok(manifest.permissions.includes('activeTab'));

    // Firefox requirements: an add-on ID backs storage.sync, and AMO refuses
    // submissions without a data collection declaration.
    const gecko = manifest.browser_specific_settings && manifest.browser_specific_settings.gecko;
    assert.ok(gecko, 'manifest needs browser_specific_settings.gecko for Firefox');
    assert.ok(gecko.id, 'storage.sync needs a stable add-on ID in Firefox');
    assert.ok(!/@example\.(com|org|net)$/.test(gecko.id),
        'the manifest must not ship a placeholder add-on ID');
    assert.ok(gecko.data_collection_permissions.required.includes('none'),
        'AMO needs the data collection declaration');
    assert.strictEqual(manifest.content_scripts[0].js[0], 'content/core/api.js',
        'the API namespace must be resolved before any file uses it');

    // Extension contexts resolve their namespace once, through DH.api. Naming
    // a namespace anywhere else would bypass it, and the chrome.* alias only
    // returns promises in Manifest V3.
    const apiConsumers = [
        'content/content.js',
        'content/scanner.js',
        'content/core/settings.js',
        'content/core/status.js',
        'content/core/styles.js',
        'content/core/detect/formats.js',
        'content/core/detect/fuzzy.js',
        'popup/popup.js',
        'options/options.js'
    ];
    for (const file of apiConsumers) {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.ok(!/\b(?:browser|chrome)\s*\./.test(source),
            file + ' must go through DH.api rather than naming a namespace directly');
    }
});

// --- runner ---------------------------------------------------------------

(async function run() {
    const modes = createPage({ highlightApi: false }).usingHighlightApi;
    assert.strictEqual(modes, false, 'fallback mode must not claim Highlight API support');
    assert.strictEqual(createPage({ highlightApi: true }).usingHighlightApi, true,
        'the test double must enable the Highlight API path');

    for (const entry of tests) {
        await entry.run();
        console.log('ok - ' + entry.name);
    }
    console.log('All DOM tests passed (' + tests.length + ' cases, both rendering paths).');
})().catch(err => {
    console.error(err);
    process.exit(1);
});
