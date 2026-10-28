// settings.js -- storage access, defaults, and validation for Date Highlighter.
// Loaded in the content-script world; exposes window.DH.settings.
// Every value that leaves storage passes through merge(), so callers can rely
// on types, ranges, and colours no matter what is stored.
(function () {
    'use strict';

    const SCHEMA_VERSION = 1;
    const STORAGE_KEY = 'settings';

    const THEMES = ['auto', 'light', 'dark'];
    const STYLE_FLAGS = ['border', 'bold', 'italic', 'underline'];
    const DAY_LIMIT = 36500;
    const HEX_COLOR = /^#[0-9a-f]{6}$/i;

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
        // Format ids from DH.formats that detection must skip.
        disabledFormats: [],
        // Logs boot decisions and scan counts to the page console.
        debug: false,
        stages: defaultStages()
    };

    function isObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    // Plain-data clone; defaults and stored settings hold JSON-safe values only.
    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function bool(value, fallback) {
        return typeof value === 'boolean' ? value : fallback;
    }

    function boundedInt(value, fallback) {
        return (Number.isInteger(value) && Math.abs(value) <= DAY_LIMIT) ? value : fallback;
    }

    function color(value, fallback) {
        return (typeof value === 'string' && HEX_COLOR.test(value.trim())) ? value.trim() : fallback;
    }

    // Stage ranges merge by id so new default stages survive future defaults
    // and stored stages keep user edits. Labels are display-only and always
    // come from the defaults, so stale stored labels never resurface.
    // A range is only applied when both bounds are valid and ordered, so a
    // corrupted value can never half-apply a stage.
    function mergeStages(defaults, stored) {
        const stages = clone(defaults);
        if (!Array.isArray(stored)) return stages;
        const byId = new Map();
        for (const stage of stored) {
            if (isObject(stage) && typeof stage.id === 'string') byId.set(stage.id, stage);
        }
        for (const stage of stages) {
            const saved = byId.get(stage.id);
            if (!saved) continue;
            const min = boundedInt(saved.min, null);
            const max = boundedInt(saved.max, null);
            if (min !== null && max !== null && min <= max) {
                stage.min = min;
                stage.max = max;
            }
            stage.highlight = bool(saved.highlight, stage.highlight);
            for (const flag of STYLE_FLAGS) stage[flag] = bool(saved[flag], stage[flag]);
            for (const themeName of ['light', 'dark']) {
                const palette = isObject(saved[themeName]) ? saved[themeName] : {};
                stage[themeName] = {
                    color: color(palette.color, stage[themeName].color),
                    bg: color(palette.bg, stage[themeName].bg)
                };
            }
        }
        return stages;
    }

    // Format ids are filtered against the registry when it is already loaded,
    // so a stale id never disables anything by accident.
    function normalizeFormats(raw) {
        if (!Array.isArray(raw)) return [];
        const registry = (window.DH && DH.formats && Array.isArray(DH.formats.FORMATS))
            ? new Set(DH.formats.FORMATS.map(format => format.id))
            : null;
        const ids = [];
        for (const value of raw) {
            const id = String(value);
            if (registry && !registry.has(id)) continue;
            if (!ids.includes(id)) ids.push(id);
        }
        return ids;
    }

    // Coerces stored whitelist data into the map form. Legacy array
    // whitelists (plain domain strings from schema 1) become whole-page
    // entries: every entry maps to an empty selector list. A malformed
    // selector list is treated as an empty one (whole page) so a corrupted
    // entry cannot silently stop matching.
    function normalizeWhitelist(raw) {
        if (Array.isArray(raw)) {
            const map = {};
            for (const entry of raw) {
                const key = String(entry).trim().toLowerCase();
                if (key) map[key] = [];
            }
            return map;
        }
        if (!isObject(raw)) return {};
        const map = {};
        for (const [pattern, selectors] of Object.entries(raw)) {
            const key = String(pattern).trim().toLowerCase();
            if (!key) continue;
            if (!Array.isArray(selectors)) {
                map[key] = [];
                continue;
            }
            map[key] = selectors
                .filter(selector => typeof selector === 'string')
                .map(selector => selector.trim())
                .filter(Boolean);
        }
        return map;
    }

    function merge(defaults, stored) {
        const src = isObject(stored) ? stored : {};
        const out = clone(defaults);
        out.schemaVersion = SCHEMA_VERSION;
        out.enabled = bool(src.enabled, defaults.enabled);
        out.dayFirst = bool(src.dayFirst, defaults.dayFirst);
        out.fuzzy = bool(src.fuzzy, defaults.fuzzy);
        out.debug = bool(src.debug, defaults.debug);
        out.theme = THEMES.includes(src.theme) ? src.theme : defaults.theme;
        out.disabledFormats = normalizeFormats(src.disabledFormats);
        out.whitelist = normalizeWhitelist(src.whitelist);
        out.stages = mergeStages(defaults.stages, src.stages);
        return out;
    }

    async function load() {
        let stored = {};
        try {
            const result = await DH.api.storage.sync.get(STORAGE_KEY);
            if (result && result[STORAGE_KEY]) stored = result[STORAGE_KEY];
        } catch (err) {
            // Storage unavailable (e.g. policy); fall back to defaults.
            stored = {};
        }
        return merge(DEFAULTS, stored);
    }

    // Validates before writing so invalid values never reach storage, and
    // resolves with what was stored so callers can refresh their view.
    function save(settings) {
        const clean = merge(DEFAULTS, settings);
        return DH.api.storage.sync.set({ [STORAGE_KEY]: clean }).then(() => clean);
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

    // How a hostname is covered by the whitelist, for labelling controls:
    //   { tracked, exact, pattern }
    // exact is true only when an entry is keyed on this hostname; a wildcard
    // that happens to cover the host reports its own pattern instead, so the
    // UI never claims to untrack something it cannot remove.
    function siteState(whitelist, hostname) {
        const map = normalizeWhitelist(whitelist);
        const host = String(hostname || '').trim().toLowerCase();
        const state = { tracked: false, exact: false, pattern: null };
        if (!host) return state;

        let exact = false;
        let wildcard = null;
        for (const pattern of Object.keys(map)) {
            if (pattern === host) {
                exact = true;
                continue;
            }
            if (pattern === '*') {
                wildcard = wildcard || pattern;
                continue;
            }
            if (pattern.startsWith('*.')) {
                const base = pattern.slice(2);
                if (host === base || host.endsWith('.' + base)) wildcard = wildcard || pattern;
            }
        }

        if (exact) return { tracked: true, exact: true, pattern: host };
        if (wildcard) return { tracked: true, exact: false, pattern: wildcard };
        return state;
    }

    // Adds or removes an exact hostname entry. Wildcard entries are never
    // touched, so removing a site can never widen what gets scanned.
    function toggleSite(whitelist, hostname) {
        const map = clone(normalizeWhitelist(whitelist));
        const host = String(hostname || '').trim().toLowerCase();
        if (!host) return map;
        if (Object.prototype.hasOwnProperty.call(map, host)) {
            delete map[host];
        } else {
            map[host] = []; // empty selectors = whole page
        }
        return map;
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
    DH.settings = {
        load, save, merge, hostAllowed, siteState, toggleSite,
        normalizeWhitelist, applyTheme, DEFAULTS, SCHEMA_VERSION
    };
})();
