// test.js -- lightweight logic tests run with Node (no DOM needed).
// Stubs the browser globals the core modules expect, then exercises the
// format registry, fuzzy parser, status bucketing, date attributes, and
// whitelist matcher. All expectations are expressed in local calendar terms,
// so the suite passes in any timezone. DOM behaviour lives in dom.test.js.
'use strict';

const path = require('path');
const assert = require('assert');

global.window = global;
global.chrome = { storage: { sync: {} }, runtime: {} }; // namespace stub for api.js

const core = p => require(path.join(__dirname, '..', 'content', 'core', p));
core('api.js');
core('settings.js');
core('status.js');
core(path.join('detect', 'formats.js'));
core(path.join('detect', 'fuzzy.js'));

const {
    DEFAULTS, hostAllowed, siteState, toggleSite, merge
} = window.DH.settings;
const { findMatches: findFormatMatches } = window.DH.formats;
const { findMatches: findFuzzyMatches } = window.DH.fuzzy;
const { getStage, getToday, dayKey, dateFromAttribute } = window.DH.status;

const settings = JSON.parse(JSON.stringify(DEFAULTS));
const today = getToday();

// Local-date formatting, not toISOString, which renders UTC and shifts
// afternoon times into the next calendar day east of UTC.
function iso(date) {
    return dayKey(date);
}

function plusDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

function fmtMatch(text, overrides) {
    const active = overrides ? Object.assign({}, settings, overrides) : settings;
    return findFormatMatches(text, active).map(m => iso(m.date));
}

// --- format tests ---
assert.deepStrictEqual(fmtMatch('Due 2026-10-23 okay'), ['2026-10-23']);
assert.deepStrictEqual(fmtMatch('October 23, 2026'), ['2026-10-23']);
assert.deepStrictEqual(fmtMatch('23 Oct 2026'), ['2026-10-23']);
assert.deepStrictEqual(fmtMatch('23/10/26'), ['2026-10-23']); // day-first default
assert.deepStrictEqual(fmtMatch('10/23/26', { dayFirst: false }), ['2026-10-23']);
assert.deepStrictEqual(fmtMatch('23/10/26', { dayFirst: false }), []); // month 23 is invalid
assert.deepStrictEqual(fmtMatch('Feb 30, 2026'), []); // invalid date rejected
assert.deepStrictEqual(fmtMatch('no dates here'), []);

// Disabled formats are skipped (the toggles used to be ignored entirely).
assert.deepStrictEqual(fmtMatch('2026-10-23', { disabledFormats: ['iso'] }), []);
assert.deepStrictEqual(fmtMatch('October 23, 2026', { disabledFormats: ['month-day-year'] }), []);
assert.deepStrictEqual(fmtMatch('23 Oct 2026', { disabledFormats: ['day-month-year'] }), []);
assert.deepStrictEqual(fmtMatch('23/10/26', { disabledFormats: ['numeric-slash'] }), []);
assert.deepStrictEqual(
    fmtMatch('mix 2026-10-23 and Oct 23, 2026', { disabledFormats: ['iso'] }),
    ['2026-10-23']);
assert.deepStrictEqual(
    fmtMatch('2026-10-23', { disabledFormats: 'not-an-array' }),
    ['2026-10-23']); // malformed setting must not disable everything

// --- fuzzy tests ---
function fuzzy(text, base) {
    return findFuzzyMatches(text, base || today).map(m => iso(m.date));
}

assert.deepStrictEqual(fuzzy('Tomorrow'), [iso(plusDays(today, 1))]);
assert.deepStrictEqual(fuzzy('yesterday'), [iso(plusDays(today, -1))]);
assert.deepStrictEqual(fuzzy('in two days'), [iso(plusDays(today, 2))]);
assert.deepStrictEqual(fuzzy('in 3 weeks'), [iso(plusDays(today, 21))]);
assert.deepStrictEqual(fuzzy('ten days ago'), [iso(plusDays(today, -10))]);
assert.deepStrictEqual(fuzzy('next Friday').length, 1);
assert.deepStrictEqual(fuzzy('last monday').length, 1);
assert.deepStrictEqual(fuzzy('in a couple of weeks'), [iso(plusDays(today, 14))]);
assert.deepStrictEqual(fuzzy('nothing fuzzy'), []);

// Relative hour/minute phrases resolve against the actual time of day and are
// then bucketed by the calendar date they land on.
const afternoon = new Date(today);
afternoon.setHours(15, 0, 0, 0);
assert.deepStrictEqual(fuzzy('In 12 hours', afternoon), [iso(new Date(afternoon.getTime() + 12 * 3600000))]);
assert.deepStrictEqual(fuzzy('In 2 hours', afternoon), [iso(afternoon)]); // 5 PM, same day
assert.deepStrictEqual(fuzzy('20 minutes ago', afternoon), [iso(new Date(afternoon.getTime() - 20 * 60000))]);
assert.deepStrictEqual(fuzzy('45 mins ago', afternoon), [iso(new Date(afternoon.getTime() - 45 * 60000))]);
assert.deepStrictEqual(fuzzy('in ten hours', afternoon), [iso(new Date(afternoon.getTime() + 10 * 3600000))]);

// --- status tests ---
function stageOf(offset) {
    return getStage(settings, plusDays(today, offset)).id;
}
assert.strictEqual(stageOf(-1), 'overdue');
assert.strictEqual(stageOf(0), 'today');
assert.strictEqual(stageOf(1), 'tomorrow');
assert.strictEqual(stageOf(2), 'soon');
assert.strictEqual(stageOf(3), 'soon');
assert.strictEqual(stageOf(4), 'upcoming');
assert.strictEqual(stageOf(13), 'upcoming');
assert.strictEqual(stageOf(14), 'future');

// --- machine-readable date attributes ---
assert.strictEqual(iso(dateFromAttribute('2026-10-23')), '2026-10-23'); // taken literally, never shifted
assert.strictEqual(dateFromAttribute('2026-02-30'), null); // rollover rejected
assert.strictEqual(dateFromAttribute('not a date'), null);
assert.strictEqual(dateFromAttribute(''), null);
assert.strictEqual(dateFromAttribute(null), null);
// A value with a time is an instant: it lands on whatever local date that
// instant falls in, which is not always its UTC date.
{
    const instant = new Date('2026-10-28T04:00:00Z');
    assert.strictEqual(iso(dateFromAttribute('2026-10-28T04:00:00Z')), iso(instant));
    assert.strictEqual(iso(dateFromAttribute(instant.toISOString())), iso(instant));
}

// --- day keys ---
assert.strictEqual(dayKey(new Date(2026, 0, 5)), '2026-01-05');

// --- whitelist tests ---
// hostAllowed returns the selector array for the matching domain entry
// ([] = whole page) or null when the hostname is not whitelisted.
assert.deepStrictEqual(hostAllowed(['*'], 'anything.example'), []);
assert.deepStrictEqual(hostAllowed(['example.com'], 'example.com'), []);
assert.strictEqual(hostAllowed(['example.com'], 'sub.example.com'), null);
assert.deepStrictEqual(hostAllowed(['*.example.com'], 'sub.example.com'), []);
assert.deepStrictEqual(hostAllowed(['*.example.com'], 'example.com'), []);
assert.strictEqual(hostAllowed(['*.example.com'], 'notexample.com'), null);
assert.strictEqual(hostAllowed([], 'example.com'), null);

// Map form: domain -> selector list.
assert.deepStrictEqual(
    hostAllowed({ '*.atlassian.net': ['td[data-column-type$=":datepicker"]'] }, 'foo.atlassian.net'),
    ['td[data-column-type$=":datepicker"]']);
assert.strictEqual(hostAllowed({ 'example.com': ['td.x'] }, 'sub.example.com'), null);
assert.strictEqual(hostAllowed({ 'example.com': ['td.x'] }, 'notexample.com'), null);
assert.deepStrictEqual(hostAllowed({ 'a.com': [], 'b.com': ['s1'] }, 'a.com'), []);
assert.deepStrictEqual(hostAllowed({ '*': [], 'a.com': ['s1'] }, 'a.com'), []);
assert.deepStrictEqual(
    hostAllowed({ 'a.com': ['s1', 's2'], '*.a.com': ['s3'] }, 'sub.a.com'),
    ['s3']);
assert.deepStrictEqual(
    hostAllowed({ 'a.com': ['s1', ''], 'b.com': [] }, 'a.com'),
    ['s1']);
assert.deepStrictEqual(
    hostAllowed({ 'a.com': 'not-an-array', 'b.com': null }, 'a.com'),
    []); // malformed selector list falls back to whole page

// --- site state and toggling (popup button) ---
assert.deepStrictEqual(siteState({ 'a.com': [] }, 'a.com'), { tracked: true, exact: true, pattern: 'a.com' });
assert.deepStrictEqual(siteState({ 'a.com': [] }, 'sub.a.com'), { tracked: false, exact: false, pattern: null });
assert.deepStrictEqual(siteState({ '*.a.com': [] }, 'sub.a.com'), { tracked: true, exact: false, pattern: '*.a.com' });
assert.deepStrictEqual(siteState({ '*.a.com': [] }, 'a.com'), { tracked: true, exact: false, pattern: '*.a.com' });
assert.deepStrictEqual(siteState({ '*': [] }, 'anything.example'), { tracked: true, exact: false, pattern: '*' });
assert.deepStrictEqual(siteState({}, 'a.com'), { tracked: false, exact: false, pattern: null });
assert.deepStrictEqual(hostAllowed({'a.com': ['s1']}, 'a.com'), ['s1']);
assert.deepStrictEqual(siteState({ 'a.com': ['s1'] }, 'a.com'), { tracked: true, exact: true, pattern: 'a.com' });

// Toggling only ever touches the exact hostname entry, so untracking a site
// that is covered by a wildcard cannot widen what gets scanned.
assert.deepStrictEqual(toggleSite({}, 'a.com'), { 'a.com': [] });
assert.deepStrictEqual(toggleSite({ 'a.com': ['s1'], 'b.com': [] }, 'a.com'), { 'b.com': [] });
assert.deepStrictEqual(
    toggleSite({ '*.a.com': ['td.x'] }, 'sub.a.com'),
    { '*.a.com': ['td.x'], 'sub.a.com': [] });
assert.deepStrictEqual(
    toggleSite({ '*': [] }, 'a.com'),
    { '*': [], 'a.com': [] });
// The input map is never mutated.
{
    const original = { 'a.com': [] };
    toggleSite(original, 'a.com');
    assert.deepStrictEqual(original, { 'a.com': [] });
}

// --- stored settings validation ---
{
    const dirty = merge(DEFAULTS, {
        enabled: 'yes',                 // wrong type
        theme: 'neon',                  // unknown theme
        dayFirst: true,
        disabledFormats: ['iso', 'nope', 42],
        whitelist: { 'a.com': ['td.x', 7], '': [] },
        stages: [
            { id: 'today', min: 'x', max: 3, highlight: 'yep', light: { color: 'red' } },
            { id: 'overdue', min: 5, max: 1 } // inverted range
        ]
    });
    assert.strictEqual(dirty.enabled, DEFAULTS.enabled);
    assert.strictEqual(dirty.theme, DEFAULTS.theme);
    assert.strictEqual(dirty.dayFirst, true);
    assert.deepStrictEqual(dirty.disabledFormats, ['iso']);
    assert.deepStrictEqual(dirty.whitelist, { 'a.com': ['td.x'] });
    const todayStage = dirty.stages.find(stage => stage.id === 'today');
    assert.strictEqual(todayStage.min, 0);              // default pair kept
    assert.strictEqual(todayStage.max, 0);              // because min was unreadable
    assert.strictEqual(todayStage.highlight, true);
    assert.strictEqual(todayStage.light.color, DEFAULTS.stages[1].light.color);
    const overdue = dirty.stages.find(stage => stage.id === 'overdue');
    assert.strictEqual(overdue.min, -36500);            // inverted pair rejected
    assert.strictEqual(overdue.max, -1);
}

// Colour values are constrained to hex triplets: they end up in CSS that runs
// on other sites' pages.
{
    const injected = merge(DEFAULTS, {
        stages: [{ id: 'today', highlight: true, light: { color: '</style><script>x</script>', bg: 'url(evil)' } }]
    });
    const stage = injected.stages.find(s => s.id === 'today');
    assert.strictEqual(stage.light.color, DEFAULTS.stages[1].light.color);
    assert.strictEqual(stage.light.bg, DEFAULTS.stages[1].light.bg);
}

// Loading must not hand out the defaults themselves, otherwise editing a
// loaded settings object in place would rewrite DEFAULTS (and break Reset).
{
    const loaded = merge(DEFAULTS, {});
    assert.notStrictEqual(loaded.stages, DEFAULTS.stages);
    assert.notStrictEqual(loaded.stages[0], DEFAULTS.stages[0]);
    assert.notStrictEqual(loaded.stages[0].light, DEFAULTS.stages[0].light);
    loaded.stages[0].light.color = '#123456';
    assert.strictEqual(DEFAULTS.stages[0].light.color, '#ad0000');
}

console.log('All logic tests passed.');
