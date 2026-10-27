// formats.js -- registry of absolute date formats.
// Each format: { id, label, regex (global), parse(match, settings) -> Date|null }.
// The scanner merges matches from every enabled format plus fuzzy detection;
// overlaps resolve to the earliest index, then the longest match.
(function () {
    'use strict';

    // Month names resolve by their first three letters, so full names and
    // common abbreviations share one lookup.
    const MONTH_LOOKUP = {
        jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
        jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
    };

    const MONTH_SOURCE = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';

    function monthFromName(name) {
        return MONTH_LOOKUP[name.slice(0, 3).toLowerCase()];
    }

    function makeDate(year, month, day) {
        const d = new Date(year, month, day);
        // Reject rollover dates such as "Feb 30, 2026".
        return (d.getMonth() === month && d.getDate() === day) ? d : null;
    }

    // 2-digit years map to the 2000s, matching the Jira addon's behaviour.
    function expandYear(year) {
        return year < 100 ? 2000 + year : year;
    }

    function parseIso(match) {
        const m = match.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return null;
        return makeDate(+m[1], +m[2] - 1, +m[3]);
    }

    function parseMonthDayYear(match) {
        const m = match.match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/);
        if (!m) return null;
        const month = monthFromName(m[1]);
        if (month === undefined) return null;
        return makeDate(+m[3], month, +m[2]);
    }

    function parseDayMonthYear(match) {
        const m = match.match(/^(\d{1,2}) ([A-Za-z]+) (\d{4})$/);
        if (!m) return null;
        const month = monthFromName(m[2]);
        if (month === undefined) return null;
        return makeDate(+m[3], month, +m[1]);
    }

    // "23/10/26" or "3/10/2026" -- ambiguous; day-first or month-first comes
    // from the user's dayFirst setting.
    function parseNumericSlash(match, settings) {
        const m = match.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
        if (!m) return null;
        const a = +m[1];
        const b = +m[2];
        const year = expandYear(+m[3]);
        const day = settings.dayFirst ? a : b;
        const month = settings.dayFirst ? b : a;
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        return makeDate(year, month - 1, day);
    }

    const FORMATS = [
        {
            id: 'iso',
            label: 'ISO (2026-10-23)',
            regex: /\b\d{4}-\d{2}-\d{2}\b/g,
            parse: parseIso
        },
        {
            id: 'month-day-year',
            label: 'October 23, 2026',
            regex: new RegExp('\\b(?:' + MONTH_SOURCE + ') \\d{1,2}, \\d{4}\\b', 'gi'),
            parse: parseMonthDayYear
        },
        {
            id: 'day-month-year',
            label: '23 October 2026',
            regex: new RegExp('\\b\\d{1,2} (?:' + MONTH_SOURCE + ') \\d{4}\\b', 'gi'),
            parse: parseDayMonthYear
        },
        {
            id: 'numeric-slash',
            label: '01/04/26 (day first) / 04/01/26 (month first)',
            regex: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
            parse: parseNumericSlash
        }
    ];

    // All matches found by every enabled format in `text`, sorted by position.
    function findMatches(text, settings) {
        const matches = [];
        for (const format of FORMATS) {
            format.regex.lastIndex = 0;
            let m;
            while ((m = format.regex.exec(text)) !== null) {
                const date = format.parse(m[0], settings);
                if (date) {
                    matches.push({ index: m.index, length: m[0].length, text: m[0], date });
                }
                if (m[0].length === 0) format.regex.lastIndex++; // safety against empty matches
            }
        }
        matches.sort((a, b) => a.index - b.index);
        return matches;
    }

    window.DH = window.DH || {};
    DH.formats = { FORMATS, findMatches };
})();
