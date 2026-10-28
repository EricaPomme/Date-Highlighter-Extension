// options.js -- settings editor.
// Saves are validated here (whole-day ranges, parseable site lines) and
// sanitized again in DH.settings.save, so invalid values never reach storage.
'use strict';

const whitelistBox = document.getElementById('whitelist');
const formatList = document.getElementById('format-list');
const dayFirstSelect = document.getElementById('day-first');
const fuzzyToggle = document.getElementById('fuzzy-toggle');
const stageRows = document.getElementById('stage-rows');
const themeMode = document.getElementById('theme-mode');
const debugToggle = document.getElementById('debug-toggle');
const enabledToggle = document.getElementById('enabled-toggle');
const saveButton = document.getElementById('save');
const resetButton = document.getElementById('reset');
const reloadButton = document.getElementById('reload');
const statusLabel = document.getElementById('status');

const DAY_LIMIT = 36500;

let settings = null;
let dirty = false;
let statusTimer = null;
// JSON of the last settings this page wrote, so the storage change Chrome
// echoes back to the writer is not mistaken for another tab's edit.
let lastSaved = null;

// Formats are shown as checkboxes; the registry stays the single source of
// truth for ids and labels.
function renderFormats() {
    formatList.textContent = '';
    for (const format of DH.formats.FORMATS) {
        const label = document.createElement('label');
        label.className = 'row';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !settings.disabledFormats.includes(format.id);
        checkbox.dataset.formatId = format.id;

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(format.label));
        formatList.appendChild(label);
    }
}

function numInput(value, min, max) {
    const input = document.createElement('input');
    input.type = 'number';
    input.value = value;
    input.min = min;
    input.max = max;
    return input;
}

function colorInput(value) {
    const input = document.createElement('input');
    input.type = 'color';
    input.value = value;
    return input;
}

function renderStages() {
    stageRows.textContent = '';
    for (const stage of settings.stages) {
        const row = document.createElement('tr');

        const nameCell = document.createElement('td');
        nameCell.textContent = stage.label;
        row.appendChild(nameCell);

        const minCell = document.createElement('td');
        minCell.appendChild(numInput(stage.min, -DAY_LIMIT, DAY_LIMIT));
        row.appendChild(minCell);

        const maxCell = document.createElement('td');
        maxCell.appendChild(numInput(stage.max, -DAY_LIMIT, DAY_LIMIT));
        row.appendChild(maxCell);

        const hlCell = document.createElement('td');
        const hlInput = document.createElement('input');
        hlInput.type = 'checkbox';
        hlInput.checked = stage.highlight;
        hlCell.appendChild(hlInput);
        row.appendChild(hlCell);

        for (const flag of ['border', 'bold', 'italic', 'underline']) {
            const cell = document.createElement('td');
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = stage[flag];
            input.dataset.flag = flag;
            cell.appendChild(input);
            row.appendChild(cell);
        }

        const cells = [
            [stage.light.color, 'light', 'color'],
            [stage.light.bg, 'light', 'bg'],
            [stage.dark.color, 'dark', 'color'],
            [stage.dark.bg, 'dark', 'bg']
        ].map(([value, theme, key]) => {
            const cell = document.createElement('td');
            const input = colorInput(value);
            input.dataset.theme = theme;
            input.dataset.key = key;
            cell.appendChild(input);
            row.appendChild(cell);
            return cell;
        });

        row.dataset.stageId = stage.id;
        stageRows.appendChild(row);
    }
}

// Reads the stage table back into fresh stage objects. Returns either
// { stages } or { error }, so a typo blocks the save instead of storing a
// range that can never match.
function readStages() {
    const byId = new Map(settings.stages.map(stage => [stage.id, stage]));
    const stages = [];

    for (const row of stageRows.querySelectorAll('tr')) {
        const current = byId.get(row.dataset.stageId);
        if (!current) continue;

        const numbers = row.querySelectorAll('input[type="number"]');
        const min = Number.parseInt(numbers[0].value, 10);
        const max = Number.parseInt(numbers[1].value, 10);
        const invalid = !Number.isInteger(min) || !Number.isInteger(max) ||
            Math.abs(min) > DAY_LIMIT || Math.abs(max) > DAY_LIMIT || min > max;

        numbers[0].classList.toggle('invalid', invalid);
        numbers[1].classList.toggle('invalid', invalid);
        if (invalid) {
            return {
                error: current.label + ': use whole day offsets from -' + DAY_LIMIT +
                    ' to ' + DAY_LIMIT + ', with From no greater than To.'
            };
        }

        const stage = {
            id: current.id,
            min: min,
            max: max,
            highlight: row.querySelector('input[type="checkbox"]').checked
        };
        for (const box of row.querySelectorAll('input[data-flag]')) {
            stage[box.dataset.flag] = box.checked;
        }
        const colors = { light: {}, dark: {} };
        for (const input of row.querySelectorAll('input[type="color"]')) {
            colors[input.dataset.theme][input.dataset.key] = input.value;
        }
        stage.light = { color: colors.light.color, bg: colors.light.bg };
        stage.dark = { color: colors.dark.color, bg: colors.dark.bg };

        stages.push(stage);
    }

    return { stages };
}

// Lines are "domain" or "domain: selector1, selector2". The domain is
// matched by pattern rather than by splitting on ':' because selectors may
// contain colons (e.g. td[data-column-type$=":datepicker"]). Later lines win.
const DOMAIN_PATTERN = /^([a-z0-9*.-]+)\s*(?::\s*(.+))?$/i;

function parseWhitelist(text) {
    const map = {};
    const skipped = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(DOMAIN_PATTERN);
        if (!match) {
            skipped.push(trimmed);
            continue;
        }
        const selectors = (match[2] || '')
            .split(',')
            .map(selector => selector.trim())
            .filter(Boolean);
        map[match[1].toLowerCase()] = selectors;
    }
    return { map, skipped };
}

function formatWhitelist(map) {
    return Object.entries(map)
        .map(([domain, selectors]) =>
            selectors.length ? domain + ': ' + selectors.join(', ') : domain)
        .join('\n');
}

function applyView() {
    whitelistBox.value = formatWhitelist(settings.whitelist);
    dayFirstSelect.value = settings.dayFirst ? 'day' : 'month';
    fuzzyToggle.checked = settings.fuzzy;
    themeMode.value = settings.theme;
    debugToggle.checked = settings.debug;
    enabledToggle.checked = settings.enabled;
    renderFormats();
    renderStages();
}

async function save() {
    const read = readStages();
    if (read.error) {
        showStatus(read.error, true);
        return;
    }
    const sites = parseWhitelist(whitelistBox.value);
    const next = {
        enabled: enabledToggle.checked,
        whitelist: sites.map,
        dayFirst: dayFirstSelect.value === 'day',
        fuzzy: fuzzyToggle.checked,
        theme: themeMode.value,
        disabledFormats: Array.from(formatList.querySelectorAll('input[type="checkbox"]'))
            .filter(box => !box.checked)
            .map(box => box.dataset.formatId),
        debug: debugToggle.checked,
        stages: read.stages
    };

    // Cleared before the write so edits typed while it is in flight keep the
    // page dirty instead of being silently dropped.
    dirty = false;
    settings = await DH.settings.save(next) || settings;
    lastSaved = JSON.stringify(settings);
    reloadButton.hidden = true;
    applyView();
    const skipped = sites.skipped.length;
    showStatus(skipped
        ? 'Saved. Ignored ' + skipped + ' unreadable site line' + (skipped === 1 ? '.' : 's.')
        : 'Saved.');
}

function showStatus(text, isError) {
    statusLabel.textContent = text;
    statusLabel.classList.toggle('error', !!isError);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
        statusLabel.textContent = '';
        statusLabel.classList.remove('error');
    }, 3000);
}

saveButton.addEventListener('click', () => {
    save().catch(err => showStatus('Save failed: ' + (err && err.message ? err.message : err), true));
});

themeMode.addEventListener('change', () => {
    DH.settings.applyTheme(Object.assign({}, settings, { theme: themeMode.value }));
});

const advancedSection = document.getElementById('advanced-section');
const advancedToggle = advancedSection.querySelector('.collapse-toggle');
const advancedBody = advancedSection.querySelector('.collapse-body');

advancedToggle.addEventListener('click', () => {
    const open = advancedBody.hidden;
    advancedBody.hidden = !open;
    advancedToggle.setAttribute('aria-expanded', String(open));
});

reloadButton.addEventListener('click', async () => {
    dirty = false;
    lastSaved = null;
    settings = await DH.settings.load();
    DH.settings.applyTheme(settings);
    reloadButton.hidden = true;
    applyView();
    showStatus('Reloaded.');
});

resetButton.addEventListener('click', async () => {
    if (!confirm('Reset all settings to their defaults? Your site list is kept.')) return;
    const defaults = JSON.parse(JSON.stringify(DH.settings.DEFAULTS));
    defaults.whitelist = settings.whitelist;
    dirty = false;
    settings = await DH.settings.save(defaults) || settings;
    lastSaved = JSON.stringify(settings);
    reloadButton.hidden = true;
    applyView();
    showStatus('Reset to defaults.');
});

// Any edit marks the page dirty so an external change cannot silently
// overwrite unsaved work. Programmatic value assignment fires no events.
document.addEventListener('input', () => { dirty = true; });
document.addEventListener('change', () => { dirty = true; });

DH.api.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'sync' || !changes.settings) return;
    const loaded = await DH.settings.load();
    // Chrome delivers the change back to the page that wrote it too.
    if (lastSaved !== null && JSON.stringify(loaded) === lastSaved) return;
    if (dirty) {
        reloadButton.hidden = false;
        showStatus('Settings changed in another tab. Reload to pick them up.', true);
        return;
    }
    lastSaved = null;
    settings = loaded;
    DH.settings.applyTheme(settings);
    applyView();
});

(async function init() {
    settings = await DH.settings.load();
    DH.settings.applyTheme(settings);
    applyView();
})();
