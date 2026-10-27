// popup.js -- track/untrack the current site, open settings, and toggle
// which date formats are highlighted.
'use strict';

const trackButton = document.getElementById('track-site');
const openOptions = document.getElementById('open-options');
const formatList = document.getElementById('format-list');
const fuzzyToggle = document.getElementById('fuzzy-toggle');

let settings = null;
let hostname = null;

async function getActiveHostname() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url) return null;
        const url = new URL(tab.url);
        return url.protocol.startsWith('http') ? url.hostname.toLowerCase() : null;
    } catch (err) {
        return null;
    }
}

function applyView() {
    const tracked = hostname !== null && DH.settings.hostAllowed(settings.whitelist, hostname) !== null;
    trackButton.textContent = hostname === null
        ? 'No site available'
        : tracked
            ? 'Untrack ' + hostname
            : 'Track ' + hostname;
    trackButton.disabled = hostname === null;

    fuzzyToggle.checked = settings.fuzzy;
    for (const box of formatList.querySelectorAll('input[type="checkbox"]')) {
        box.checked = !settings.disabledFormats.includes(box.dataset.formatId);
    }
}

async function save() {
    await DH.settings.save(settings);
    applyView();
}

trackButton.addEventListener('click', () => {
    if (hostname === null) return;
    const map = Object.assign({}, settings.whitelist);
    if (Object.prototype.hasOwnProperty.call(map, hostname)) {
        delete map[hostname];
    } else {
        map[hostname] = []; // empty selectors = whole page
    }
    settings.whitelist = map;
    save();
});

openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
});

fuzzyToggle.addEventListener('change', () => {
    settings.fuzzy = fuzzyToggle.checked;
    save();
});

// Renders one checkbox per registered format; unchecking adds the format id
// to settings.disabledFormats.
function renderFormats() {
    formatList.textContent = '';
    for (const format of DH.formats.FORMATS) {
        const label = document.createElement('label');
        label.className = 'row';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.formatId = format.id;
        checkbox.addEventListener('change', () => {
            const disabled = new Set(settings.disabledFormats);
            if (checkbox.checked) {
                disabled.delete(format.id);
            } else {
                disabled.add(format.id);
            }
            settings.disabledFormats = Array.from(disabled);
            save();
        });

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(format.label));
        formatList.appendChild(label);
    }
}

(async function init() {
    settings = await DH.settings.load();
    if (!settings.disabledFormats) settings.disabledFormats = [];
    DH.settings.applyTheme(settings);
    hostname = await getActiveHostname();
    renderFormats();
    applyView();
})();
