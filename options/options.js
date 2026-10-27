// options.js -- settings editor.
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
const statusLabel = document.getElementById('status');

let settings = null;

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
        minCell.appendChild(numInput(stage.min, -36500, 36500));
        row.appendChild(minCell);

        const maxCell = document.createElement('td');
        maxCell.appendChild(numInput(stage.max, -36500, 36500));
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

function collectStages() {
    const byId = new Map(settings.stages.map(s => [s.id, s]));
    for (const row of stageRows.querySelectorAll('tr')) {
        const stage = byId.get(row.dataset.stageId);
        if (!stage) continue;
        const numbers = row.querySelectorAll('input[type="number"]');
        stage.min = parseInt(numbers[0].value, 10);
        stage.max = parseInt(numbers[1].value, 10);
        stage.highlight = row.querySelector('input[type="checkbox"]').checked;
        for (const box of row.querySelectorAll('input[data-flag]')) {
            stage[box.dataset.flag] = box.checked;
        }
        for (const color of row.querySelectorAll('input[type="color"]')) {
            stage[color.dataset.theme][color.dataset.key] = color.value;
        }
    }
}

// Lines are "domain" or "domain: selector1, selector2". The domain is
// matched by pattern rather than by splitting on ':' because selectors may
// contain colons (e.g. td[data-column-type$=":datepicker"]).
const DOMAIN_PATTERN = /^([a-z0-9*.-]+)\s*(?::\s*(.+))?$/i;

function parseWhitelist(text) {
    const map = {};
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(DOMAIN_PATTERN);
        if (!match) continue;
        const selectors = (match[2] || '')
            .split(',')
            .map(selector => selector.trim())
            .filter(Boolean);
        map[match[1].toLowerCase()] = selectors;
    }
    return map;
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
    enabledToggle.checked = settings.enabled;    renderFormats();
    renderStages();
}

async function save() {
    settings.whitelist = parseWhitelist(whitelistBox.value);
    settings.dayFirst = dayFirstSelect.value === 'day';
    settings.fuzzy = fuzzyToggle.checked;
    settings.theme = themeMode.value;
    settings.debug = debugToggle.checked;
    settings.enabled = enabledToggle.checked;
    settings.disabledFormats = Array.from(formatList.querySelectorAll('input[type="checkbox"]'))
        .filter(box => !box.checked)
        .map(box => box.dataset.formatId);
    collectStages();
    await DH.settings.save(settings);
    showStatus('Saved.');
}

function showStatus(text) {
    statusLabel.textContent = text;
    setTimeout(() => { statusLabel.textContent = ''; }, 2000);
}

saveButton.addEventListener('click', () => save().catch(err => showStatus('Save failed: ' + err.message)));
themeMode.addEventListener('change', () => {
    DH.settings.applyTheme(Object.assign({}, settings, { theme: themeMode.value }));
});
resetButton.addEventListener('click', async () => {
    settings = JSON.parse(JSON.stringify(DH.settings.DEFAULTS));
    await DH.settings.save(settings);
    applyView();
    showStatus('Reset to defaults.');
});

(async function init() {
    settings = await DH.settings.load();
    if (!settings.disabledFormats) settings.disabledFormats = [];
    DH.settings.applyTheme(settings);
    applyView();
})();
