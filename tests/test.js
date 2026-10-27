// test.js -- lightweight logic tests run with Node (no DOM needed).
// Stubs the browser globals the core modules expect, then exercises the
// format registry, fuzzy parser, status bucketing, and whitelist matcher.
'use strict';

const path = require('path');
const assert = require('assert');

global.window = global;
global.chrome = { storage: { sync: {} } }; // unused by load path under test

const core = p => require(path.join(__dirname, '..', 'content', 'core', p));
core('settings.js');
core('status.js');
core(path.join('detect', 'formats.js'));
core(path.join('detect', 'fuzzy.js'));

const { DEFAULTS, hostAllowed } = window.DH.settings;
const { findMatches: findFormatMatches } = window.DH.formats;
const { findMatches: findFuzzyMatches } = window.DH.fuzzy;
const { getStage, getToday } = window.DH.status;

const settings = JSON.parse(JSON.stringify(DEFAULTS));
const today = getToday();

function fmtMatch(text) {
    const all = findFormatMatches(text, settings);
    return all.map(m => m.date.toISOString().slice(0, 10));
}

// --- format tests ---
assert.deepStrictEqual(fmtMatch('Due 2026-10-23 okay'), ['2026-10-23']);
assert.deepStrictEqual(fmtMatch('October 23, 2026'), ['2026-10-23']);
assert.deepStrictEqual(fmtMatch('23 Oct 2026'), ['2026-10-23']);
assert.deepStrictEqual(fmtMatch('23/10/26'), ['2026-10-23']); // day-first default
settings.dayFirst = false;
assert.deepStrictEqual(fmtMatch('10/23/26'), ['2026-10-23']);
assert.deepStrictEqual(fmtMatch('23/10/26'), []); // month-first: month 23 is invalid
settings.dayFirst = true;
assert.deepStrictEqual(fmtMatch('Feb 30, 2026'), []); // invalid date rejected
assert.deepStrictEqual(fmtMatch('no dates here'), []);

// --- fuzzy tests ---
function iso(d) {
    // Local-date formatting, not toISOString (which renders UTC and can
    // shift afternoon times into the next calendar day).
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
}
function fuzzy(text) {
    settings.fuzzy = true;
    return findFuzzyMatches(text, today).map(m => iso(m.date));
}
assert.deepStrictEqual(fuzzy('Tomorrow'), [iso(new Date(today.getTime() + 86400000))]);
assert.deepStrictEqual(fuzzy('yesterday'), [iso(new Date(today.getTime() - 86400000))]);
assert.deepStrictEqual(fuzzy('in two days'), [iso(new Date(today.getTime() + 2 * 86400000))]);
assert.deepStrictEqual(fuzzy('in 3 weeks'), [iso(new Date(today.getTime() + 21 * 86400000))]);
assert.deepStrictEqual(fuzzy('ten days ago'), [iso(new Date(today.getTime() - 10 * 86400000))]);
assert.deepStrictEqual(fuzzy('next Friday').length, 1);
assert.deepStrictEqual(fuzzy('last monday').length, 1);
assert.deepStrictEqual(fuzzy('in a couple of weeks'), [iso(new Date(today.getTime() + 14 * 86400000))]);
assert.deepStrictEqual(fuzzy('nothing fuzzy'), []);

// --- time-of-day fuzzy tests ---
// Relative hour/minute phrases resolve against the actual time, then get
// bucketed by their calendar date ("In 12 hours" at 3 PM is tomorrow).
function fuzzyFrom(base, text) {
    return findFuzzyMatches(text, base).map(m => iso(m.date));
}
const midday = new Date(today);
midday.setHours(15, 0, 0, 0); // 3:00 PM
const threeAMTomorrow = new Date(midday.getTime() + 12 * 3600000);
assert.deepStrictEqual(fuzzyFrom(midday, 'In 12 hours'), [iso(threeAMTomorrow)]);
assert.deepStrictEqual(fuzzyFrom(midday, 'In 2 hours'), [iso(midday)]); // 5 PM, same day
const fivePMAgo = new Date(midday.getTime() - 20 * 60000);
assert.deepStrictEqual(fuzzyFrom(midday, '20 minutes ago'), [iso(fivePMAgo)]);
assert.deepStrictEqual(fuzzyFrom(midday, '45 mins ago'), [iso(new Date(midday.getTime() - 45 * 60000))]);
const tomorrow1am = new Date(midday.getTime() + 10 * 3600000); // 1 AM next day
assert.deepStrictEqual(fuzzyFrom(midday, 'in ten hours'), [iso(tomorrow1am)]);

// --- status tests ---
function stageOf(offset) {
    const d = new Date(today);
    d.setDate(d.getDate() + offset);
    return getStage(settings, d).id;
}
assert.strictEqual(stageOf(-1), 'overdue');
assert.strictEqual(stageOf(0), 'today');
assert.strictEqual(stageOf(1), 'tomorrow');
assert.strictEqual(stageOf(2), 'soon');
assert.strictEqual(stageOf(3), 'soon');
assert.strictEqual(stageOf(4), 'upcoming');
assert.strictEqual(stageOf(13), 'upcoming');
assert.strictEqual(stageOf(14), 'future');

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

console.log('All tests passed.');
