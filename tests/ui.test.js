// ui.test.js -- popup and options page behaviour in a simulated browser.
// Covers the controls that write settings: track/untrack semantics, format
// toggles, save failures, stage validation, and the reset/reload paths.
// Requires jsdom (npm install).
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Values read back out of a jsdom window belong to another realm, so their
// prototypes differ from Node's; compare plain copies instead.
function plain(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function readSource(file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function stripScripts(html) {
    return html.replace(/<script[\s\S]*?<\/script>/g, '');
}

// Minimal chrome API surface: an in-memory sync store plus a tab URL.
function chromeStub(window, options) {
    const opts = options || {};
    const store = Object.assign({}, opts.stored);
    return {
        store,
        tabs: { query: async () => (opts.tabUrl === null ? [] : [{ url: opts.tabUrl || 'https://example.com/page' }]) },
        runtime: { openOptionsPage() { opts.onOpenOptions && opts.onOpenOptions(); } },
        storage: {
            sync: {
                async get(key) {
                    return Object.prototype.hasOwnProperty.call(store, key)
                        ? { [key]: store[key] }
                        : {};
                },
                async set(items) {
                    if (opts.failSave) throw new Error('QUOTA_BYTES quota exceeded');
                    for (const [key, value] of Object.entries(items)) store[key] = value;
                }
            },
            onChanged: {
                listeners: [],
                addListener(listener) { this.listeners.push(listener); },
                fire(changes) {
                    for (const listener of this.listeners) listener(changes, 'sync');
                }
            }
        }
    };
}

function createPage(page, options) {
    const opts = options || {};
    const dom = new JSDOM(stripScripts(readSource(page.html)), {
        url: opts.url || 'https://extension.test/' + page.html,
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const window = dom.window;
    window.chrome = chromeStub(window, opts);
    if (opts.confirmAnswer !== undefined) {
        window.confirm = () => opts.confirmAnswer;
    }
    for (const file of page.scripts) window.eval(readSource(file));
    return {
        dom,
        window,
        document: window.document,
        chrome: window.chrome,
        close() { dom.window.close(); }
    };
}

const POPUP = {
    html: 'popup/popup.html',
    scripts: ['content/core/settings.js', 'content/core/detect/formats.js', 'popup/popup.js']
};

const OPTIONS = {
    html: 'options/options.html',
    scripts: [
        'content/core/settings.js',
        'content/core/detect/formats.js',
        'options/options.js'
    ]
};

const tests = [];
const test = (name, run) => tests.push({ name, run });

// --- popup ----------------------------------------------------------------

test('popup tracks and untracks an exact hostname', async () => {
    const page = createPage(POPUP, { tabUrl: 'https://jira.example.com/browse/AB-1' });
    await sleep(30);
    const button = page.document.getElementById('track-site');

    assert.strictEqual(button.textContent, 'Track jira.example.com');
    assert.strictEqual(button.disabled, false);

    button.click();
    await sleep(30);
    assert.deepStrictEqual(plain(page.chrome.store.settings.whitelist), { 'jira.example.com': [] });
    assert.strictEqual(button.textContent, 'Untrack jira.example.com');
    assert.strictEqual(button.disabled, false, 'an exact entry must stay removable');

    button.click();
    await sleep(30);
    assert.deepStrictEqual(plain(page.chrome.store.settings.whitelist), {});
    assert.strictEqual(button.textContent, 'Track jira.example.com');
    page.close();
});

test('popup names the wildcard that covers the site instead of widening it', async () => {
    const page = createPage(POPUP, {
        tabUrl: 'https://foo.atlassian.net/jira',
        stored: { settings: { whitelist: { '*.atlassian.net': ['td[data-column-type$=":datepicker"]'] } } }
    });
    await sleep(30);
    const button = page.document.getElementById('track-site');

    assert.strictEqual(button.textContent, 'Tracked via *.atlassian.net');
    assert.strictEqual(button.disabled, true, 'no untrack that cannot remove the entry');
    assert.ok(button.title.includes('*.atlassian.net'));

    button.click();
    await sleep(30);
    assert.deepStrictEqual(plain(page.chrome.store.settings.whitelist),
        { '*.atlassian.net': ['td[data-column-type$=":datepicker"]'] },
        'the wildcard entry must be untouched');
    page.close();
});

test('popup reports a site that cannot be tracked', async () => {
    for (const tabUrl of [null, 'chrome://extensions/']) {
        const page = createPage(POPUP, { tabUrl });
        await sleep(30);
        const button = page.document.getElementById('track-site');
        assert.strictEqual(button.textContent, 'No site available');
        assert.strictEqual(button.disabled, true);
        page.close();
    }
});

test('popup format checkboxes write disabledFormats', async () => {
    const page = createPage(POPUP, {});
    await sleep(30);
    const boxes = page.document.querySelectorAll('#format-list input[type="checkbox"]');
    assert.ok(boxes.length >= 4);
    assert.ok(Array.from(boxes).every(box => box.checked));

    boxes[0].checked = false;
    boxes[0].dispatchEvent(new page.window.Event('change', { bubbles: true }));
    await sleep(30);

    assert.deepStrictEqual(plain(page.chrome.store.settings.disabledFormats), [boxes[0].dataset.formatId]);
    page.close();
});

test('popup surfaces storage failures', async () => {
    const page = createPage(POPUP, { failSave: true });
    await sleep(30);
    page.document.getElementById('track-site').click();
    await sleep(30);

    const status = page.document.getElementById('status');
    assert.ok(status.textContent.startsWith('Save failed'), 'got: ' + status.textContent);
    assert.ok(status.classList.contains('error'));
    page.close();
});

// --- options --------------------------------------------------------------

test('options saves valid stage ranges', async () => {
    const page = createPage(OPTIONS, {});
    await sleep(30);
    const rows = page.document.querySelectorAll('#stage-rows tr');
    const numbers = rows[3].querySelectorAll('input[type="number"]'); // Soon
    numbers[0].value = '2';
    numbers[1].value = '5';

    page.document.getElementById('save').click();
    await sleep(30);

    const stored = page.chrome.store.settings;
    const soon = stored.stages.find(stage => stage.id === 'soon');
    assert.deepStrictEqual([soon.min, soon.max], [2, 5]);
    assert.strictEqual(page.document.getElementById('status').textContent, 'Saved.');
    page.close();
});

test('options refuses to save an unusable range', async () => {
    const page = createPage(OPTIONS, {});
    await sleep(30);
    const rows = page.document.querySelectorAll('#stage-rows tr');
    const numbers = rows[3].querySelectorAll('input[type="number"]');
    numbers[0].value = '9';
    numbers[1].value = '4'; // From after To

    page.document.getElementById('save').click();
    await sleep(30);

    const status = page.document.getElementById('status');
    assert.ok(status.textContent.includes('From no greater than To'), 'got: ' + status.textContent);
    assert.ok(numbers[0].classList.contains('invalid'));
    assert.strictEqual(page.chrome.store.settings, undefined, 'nothing written');
    page.close();
});

test('options reports unreadable site lines', async () => {
    const page = createPage(OPTIONS, {});
    await sleep(30);
    page.document.getElementById('whitelist').value = 'example.com\nnot a host: ~~~\n*.a.com: td.x';

    page.document.getElementById('save').click();
    await sleep(30);

    const stored = page.chrome.store.settings;
    assert.deepStrictEqual(plain(stored.whitelist), { 'example.com': [], '*.a.com': ['td.x'] });
    assert.ok(page.document.getElementById('status').textContent.includes('Ignored 1 unreadable site line'),
        'got: ' + page.document.getElementById('status').textContent);
    page.close();
});

test('options reset keeps the site list and asks first', async () => {
    const stored = { settings: { whitelist: { 'a.com': ['td.x'] }, theme: 'dark', fuzzy: false } };

    const declined = createPage(OPTIONS, { stored, confirmAnswer: false });
    await sleep(30);
    declined.document.getElementById('reset').click();
    await sleep(30);
    assert.deepStrictEqual(plain(declined.chrome.store.settings), stored.settings, 'declined reset changes nothing');
    declined.close();

    const accepted = createPage(OPTIONS, { stored: JSON.parse(JSON.stringify(stored)), confirmAnswer: true });
    await sleep(30);
    accepted.document.getElementById('reset').click();
    await sleep(30);
    const after = accepted.chrome.store.settings;
    assert.deepStrictEqual(plain(after.whitelist), { 'a.com': ['td.x'] }, 'sites are kept');
    assert.strictEqual(after.theme, 'auto');
    assert.strictEqual(after.fuzzy, true);
    accepted.close();
});

test('reset after editing cannot resurrect unsaved edits', async () => {
    // Regression: merging used to hand out the defaults themselves, so editing
    // a loaded settings object rewrote DEFAULTS and reset brought edits back.
    const page = createPage(OPTIONS, { confirmAnswer: true });
    await sleep(30);
    const rows = page.document.querySelectorAll('#stage-rows tr');
    rows[1].querySelectorAll('input[type="number"]')[1].value = '2'; // Today: To = 2
    page.document.getElementById('save').click();
    await sleep(30);

    page.document.getElementById('reset').click();
    await sleep(30);
    page.document.getElementById('reset').click();
    await sleep(30);

    const today = page.chrome.store.settings.stages.find(stage => stage.id === 'today');
    assert.deepStrictEqual([today.min, today.max], [0, 0], 'defaults must survive a reset cycle');
    page.close();
});

test('options notices settings changed elsewhere without clobbering edits', async () => {
    const page = createPage(OPTIONS, {});
    await sleep(30);

    // Clean page: an external change is applied straight away.
    page.chrome.storage.onChanged.fire({ settings: { newValue: {} } });
    await sleep(30);
    assert.strictEqual(page.document.getElementById('reload').hidden, true);

    // Dirty page: the change is announced instead of overwriting the editor.
    page.document.getElementById('whitelist').dispatchEvent(new page.window.Event('input', { bubbles: true }));
    page.chrome.storage.onChanged.fire({ settings: { newValue: {} } });
    await sleep(30);
    assert.strictEqual(page.document.getElementById('reload').hidden, false);
    assert.ok(page.document.getElementById('status').textContent.includes('changed in another tab'));

    page.document.getElementById('reload').click();
    await sleep(30);
    assert.strictEqual(page.document.getElementById('reload').hidden, true);
    assert.strictEqual(page.document.getElementById('status').textContent, 'Reloaded.');
    page.close();
});

test('options ignores the storage echo of its own save', async () => {
    const page = createPage(OPTIONS, {});
    await sleep(30);
    page.document.getElementById('save').click();
    await sleep(30);
    assert.strictEqual(page.document.getElementById('status').textContent, 'Saved.');

    // Chrome reports a page's own write back through onChanged.
    page.chrome.storage.onChanged.fire({ settings: { newValue: page.chrome.store.settings } });
    await sleep(30);
    assert.strictEqual(page.document.getElementById('reload').hidden, true, 'no self-inflicted notice');
    assert.strictEqual(page.document.getElementById('status').textContent, 'Saved.');
    page.close();
});

test('options theme change previews immediately', async () => {
    const page = createPage(OPTIONS, {});
    await sleep(30);
    const select = page.document.getElementById('theme-mode');
    select.value = 'dark';
    select.dispatchEvent(new page.window.Event('change', { bubbles: true }));
    assert.strictEqual(page.document.documentElement.dataset.theme, 'dark');
    page.close();
});

test('options renders an extension page without script errors', async () => {
    const errors = [];
    const page = createPage(OPTIONS, {});
    page.window.addEventListener('error', event => errors.push(event.message));
    await sleep(30);
    assert.deepStrictEqual(plain(errors), []);
    assert.strictEqual(page.document.querySelectorAll('#stage-rows tr').length, 6);
    assert.strictEqual(page.document.querySelectorAll('#format-list input').length, 4);
    page.close();
});

// --- runner ---------------------------------------------------------------

(async function run() {
    for (const entry of tests) {
        await entry.run();
        console.log('ok - ' + entry.name);
    }
    console.log('All UI tests passed (' + tests.length + ' cases).');
})().catch(err => {
    console.error(err);
    process.exit(1);
});


