// popup.js -- track/untrack the current site, open settings, and toggle
// which date formats are highlighted.
// Every edit reloads settings first, then persists, so concurrent edits from
// the options page are merged rather than overwritten.
'use strict';

const trackButton = document.getElementById('track-site');
const openOptions = document.getElementById('open-options');
const formatList = document.getElementById('format-list');
const fuzzyToggle = document.getElementById('fuzzy-toggle');
const statusLabel = document.getElementById('status');

let settings = null;
let hostname = null;
let busy = false;
let statusTimer = null;

async function getActiveHostname() {
    try {
        const [tab] = await DH.api.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url) return null;
        const url = new URL(tab.url);
        return url.protocol.startsWith('http') ? url.hostname.toLowerCase() : null;
    } catch (err) {
        return null;
    }
}

function applyView() {
    const state = hostname === null
        ? { tracked: false, exact: false, pattern: null }
        : DH.settings.siteState(settings.whitelist, hostname);

    if (hostname === null) {
        trackButton.textContent = 'No site available';
        trackButton.title = 'Open a web page to track its site.';
    } else if (state.exact) {
        trackButton.textContent = 'Untrack ' + hostname;
        trackButton.title = 'Remove this site from the whitelist.';
    } else if (state.tracked) {
        // Covered by a wildcard entry: naming it beats offering an untrack
        // that could only add a second, wider entry for this host.
        trackButton.textContent = 'Tracked via ' + state.pattern;
        trackButton.title = 'Covered by the ' + state.pattern + ' entry. Edit it in Settings.';
    } else {
        trackButton.textContent = 'Track ' + hostname;
        trackButton.title = 'Highlight dates on this site.';
    }
    // Only exact entries can be removed from here.
    const toggleable = hostname !== null && !busy && (state.exact || !state.tracked);
    trackButton.disabled = !toggleable;

    fuzzyToggle.checked = settings.fuzzy;
    fuzzyToggle.disabled = busy;
    for (const box of formatList.querySelectorAll('input[type="checkbox"]')) {
        box.checked = !settings.disabledFormats.includes(box.dataset.formatId);
        box.disabled = busy;
    }
}

function showStatus(text, isError) {
    statusLabel.textContent = text;
    statusLabel.classList.toggle('error', !!isError);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
        statusLabel.textContent = '';
        statusLabel.classList.remove('error');
    }, 2500);
}

// Reloads, applies the edit, then saves and re-renders. Failures (quota,
// storage policy) surface instead of silently discarding the change.
async function update(mutate) {
    if (busy) return;
    busy = true;
    applyView();
    try {
        const fresh = await DH.settings.load();
        mutate(fresh);
        settings = await DH.settings.save(fresh) || fresh;
        showStatus('Saved');
    } catch (err) {
        showStatus('Save failed: ' + (err && err.message ? err.message : err), true);
    } finally {
        busy = false;
        applyView();
    }
}

trackButton.addEventListener('click', () => {
    if (hostname === null) return;
    update(next => {
        next.whitelist = DH.settings.toggleSite(next.whitelist, hostname);
    });
});

openOptions.addEventListener('click', () => {
    DH.api.runtime.openOptionsPage();
});

fuzzyToggle.addEventListener('change', () => {
    const value = fuzzyToggle.checked;
    update(next => { next.fuzzy = value; });
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
            const enabled = checkbox.checked;
            update(next => {
                const disabled = new Set(next.disabledFormats);
                if (enabled) disabled.delete(format.id);
                else disabled.add(format.id);
                next.disabledFormats = Array.from(disabled);
            });
        });

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(format.label));
        formatList.appendChild(label);
    }
}

(async function init() {
    settings = await DH.settings.load();
    DH.settings.applyTheme(settings);
    hostname = await getActiveHostname();
    renderFormats();
    applyView();
})();
