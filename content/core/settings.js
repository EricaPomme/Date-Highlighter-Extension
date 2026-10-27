// settings.js -- storage access and defaults for Date Highlighter.
// Loaded in the content-script world; exposes window.DH.settings.
(function () {
    'use strict';

    const SCHEMA_VERSION = 1;
    const STORAGE_KEY = 'settings';

    // Stage bounds are day offsets relative to today (0 = today, negative = past).
    // min/max are inclusive. Stages are checked in array order; first match wins.
    // Style flags: border = rounded chip with a 1px text-colour outline, bold/italic/underline = text.
    function defaultStages() {
        return [
            {
                id: 'overdue', label: 'Overdue', min: -36500, max: -1, highlight: true,
                border: true, bold: true, italic: false, underline: false,
                light: { color: '#ad0000', bg: '#fff3f3' },
                dark: { color: '#ff6b6b', bg: '#5c1a1a' }
            },
            {
                id: 'today', label: 'Today', min: 0, max: 0, highlight: true,
                border: true, bold: true, italic: false, underline: false,
                light: { color: '#ff9100', bg: '#fff0e6' },
                dark: { color: '#ffb84d', bg: '#5c3a10' }
            },
            {
                id: 'tomorrow', label: 'Tomorrow', min: 1, max: 1, highlight: true,
                border: true, bold: true, italic: false, underline: false,
                light: { color: '#c49000', bg: '#fffbe6' },
                dark: { color: '#ffd54d', bg: '#5c4d10' }
            },
            {
                id: 'soon', label: 'Soon', min: 2, max: 3, highlight: true,
                border: true, bold: false, italic: false, underline: false,
                light: { color: '#c49000', bg: '#fffbe6' },
                dark: { color: '#ffd54d', bg: '#5c4d10' }
            },
            {
                id: 'upcoming', label: 'Upcoming', min: 4, max: 13, highlight: false,
                border: true, bold: false, italic: false, underline: false,
                light: { color: '#1a7f37', bg: '#eaf6ee' },
                dark: { color: '#5bd07a', bg: '#1a4a2c' }
            },
            {
                id: 'future', label: 'Future', min: 14, max: 36500, highlight: false,
                border: true, bold: false, italic: false, underline: false,
                light: { color: '#555555', bg: '#f2f2f2' },
                dark: { color: '#aaaaaa', bg: '#3d3d3d' }
            }
        ];
    }

    const DEFAULTS = {
        schemaVersion: SCHEMA_VERSION,
        enabled: true,
        // Map of host pattern -> array of CSS selectors limiting where
        // highlights apply. '*' allows all sites; an empty selector array
        // scans the whole page. Patterns may be an exact hostname
        // ('example.com') or a leading wildcard ('*.example.com').
        whitelist: {},
        dayFirst: true,
        fuzzy: true,
        // Theme applies to page highlights and the extension's own UI pages.
        // 'auto' follows prefers-color-scheme; 'light' and 'dark' force a theme.
        theme: 'auto',
        disabledFormats: [],
        // Logs boot decisions and scan counts to the page console.
        debug: false,
        stages: defaultStages()
    };

    // Shallow merge for scalars; stages merge by id so new default stages
    // survive schema bumps and stored stages keep user colour edits. Labels
    // are display-only and always come from the defaults, so stale stored
    // labels (e.g. old "(x-y days)" suffixes) never resurface.
    function mergeStages(defaults, stored) {
        if (!Array.isArray(stored)) return defaults;
        const byId = new Map(stored.map(s => [s.id, s]));
        return defaults.map(d => {
            const s = byId.get(d.id);
            if (!s) return d;
            const overlay = Object.assign({}, s);
            delete overlay.label;
            return Object.assign({}, d, overlay);
        });
    }

    function merge(defaults, stored) {
        const out = Object.assign({}, defaults, stored);
        out.stages = mergeStages(defaults.stages, stored.stages);
        out.whitelist = normalizeWhitelist(stored.whitelist);
        return out;
    }

    async function load() {
        let stored = {};
        try {
            const result = await chrome.storage.sync.get(STORAGE_KEY);
            if (result && result[STORAGE_KEY]) stored = result[STORAGE_KEY];
        } catch (err) {
            // Storage unavailable (e.g. policy); fall back to defaults.
            stored = {};
        }
        return merge(DEFAULTS, stored);
    }

    function save(settings) {
        settings.schemaVersion = SCHEMA_VERSION;
        return chrome.storage.sync.set({ [STORAGE_KEY]: settings });
    }

    // Coerces stored whitelist data into the map form. Legacy array
    // whitelists (plain domain strings from schema 1) become whole-page
    // entries: every entry maps to an empty selector list.
    function normalizeWhitelist(raw) {
        if (Array.isArray(raw)) {
            const map = {};
            for (const entry of raw) {
                const key = String(entry).trim().toLowerCase();
                if (key) map[key] = [];
            }
            return map;
        }
        return (raw && typeof raw === 'object') ? raw : {};
    }

    // Resolves a hostname against the whitelist map. Returns the selector
    // array for the matching domain ([] means scan the whole page), or null
    // when the hostname is not whitelisted. '*' allows every site.
    // '*.example.com' matches example.com and any subdomain. When several
    // patterns match, their selector lists are unioned; any matching entry
    // with an empty selector list grants whole-page scanning immediately.
    function hostAllowed(whitelist, hostname) {
        const map = normalizeWhitelist(whitelist);
        const host = (hostname || '').toLowerCase();
        const merged = [];
        for (const [pattern, selectors] of Object.entries(map)) {
            const entry = String(pattern).trim().toLowerCase();
            if (!entry) continue;
            if (entry === '*') return [];
            const matches = entry === host ||
                (entry.startsWith('*.') &&
                    (host === entry.slice(2) || host.endsWith('.' + entry.slice(2))));
            if (!matches) continue;
            if (!Array.isArray(selectors) || !selectors.length) return [];
            for (const sel of selectors) {
                const clean = String(sel).trim();
                if (clean) merged.push(clean);
            }
        }
        return merged.length ? merged : null;
    }

    // Applies the user's theme preference to an extension page: 'auto'
    // removes the override so prefers-color-scheme applies; 'light'/'dark'
    // set data-theme, which the stylesheets use to force a palette.
    function applyTheme(settings) {
        const root = document.documentElement;
        if (settings.theme === 'light' || settings.theme === 'dark') {
            root.dataset.theme = settings.theme;
        } else {
            delete root.dataset.theme;
        }
    }

    window.DH = window.DH || {};
    DH.settings = { load, save, hostAllowed, normalizeWhitelist, applyTheme, DEFAULTS, SCHEMA_VERSION };
})();
