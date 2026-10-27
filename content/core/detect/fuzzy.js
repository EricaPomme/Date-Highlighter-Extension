// fuzzy.js -- relative ("fuzzy") date phrases.
// MVP grammar: today/yesterday/tomorrow, next/last <weekday>,
// "in N days|weeks|months|years", "N ... ago", with spelled-out numbers
// one through ten plus "a", "an", and "a couple of".
(function () {
    'use strict';

    const NUM_WORDS = {
        'a couple of': 2,
        'a': 1,
        'an': 1,
        'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
        'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10
    };

    const WEEKDAYS = {
        'sunday': 0, 'sun': 0,
        'monday': 1, 'mon': 1,
        'tuesday': 2, 'tues': 2, 'tue': 2,
        'wednesday': 3, 'wed': 3,
        'thursday': 4, 'thurs': 4, 'thur': 4, 'thu': 4,
        'friday': 5, 'fri': 5,
        'saturday': 6, 'sat': 6
    };

    // Ordered longest-first so "a couple of" beats "a" during matching.
    const NUM_SOURCE = 'a couple of|ten|nine|eight|seven|six|five|four|three|two|one|an|a|\\d{1,3}';
    const UNIT_SOURCE = 'days?|weeks?|months?|years?|hours?|hrs?|minutes?|mins?';
    const WEEKDAY_SOURCE = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday|tues|thurs|thur|sun|mon|tue|wed|thu|fri|sat';

    const FUZZY_REGEX = new RegExp(
        '\\b(today|tomorrow|yesterday)\\b' +
        '|\\b(next|last)\\s+(' + WEEKDAY_SOURCE + ')\\b' +
        '|\\bin\\s+(' + NUM_SOURCE + ')\\s+(' + UNIT_SOURCE + ')\\b' +
        '|\\b(' + NUM_SOURCE + ')\\s+(' + UNIT_SOURCE + ')\\s+ago\\b',
        'gi'
    );

    function parseNumber(token) {
        const key = token.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(NUM_WORDS, key)) return NUM_WORDS[key];
        const n = parseInt(key, 10);
        return isNaN(n) ? null : n;
    }

    function addUnits(date, amount, unit) {
        const d = new Date(date);
        // 'minutes' and 'months' share the 'm' prefix, so match on
        // distinguishing substrings rather than the first character.
        if (/min/.test(unit)) {
            d.setMinutes(d.getMinutes() + amount);
        } else if (/^h/.test(unit)) {
            d.setHours(d.getHours() + amount);
        } else if (/^d/.test(unit)) {
            d.setDate(d.getDate() + amount);
        } else if (/^w/.test(unit)) {
            d.setDate(d.getDate() + amount * 7);
        } else if (/^month/.test(unit)) {
            // Calendar arithmetic so "in one month" lands on the same day-of-month.
            d.setMonth(d.getMonth() + amount);
        } else if (/^y/.test(unit)) {
            d.setFullYear(d.getFullYear() + amount);
        }
        return d;
    }

    // Next occurrence of the weekday strictly after `today` (1..7 days out).
    function nextWeekday(today, weekday) {
        const delta = (weekday - today.getDay() + 7) % 7 || 7;
        return addUnits(today, delta, 'day');
    }

    // Previous occurrence of the weekday strictly before `today` (1..7 days back).
    function lastWeekday(today, weekday) {
        const delta = (today.getDay() - weekday + 7) % 7 || 7;
        return addUnits(today, -delta, 'day');
    }

    // Builds a Date at local midnight relative to today's date.
    function resolvePhrase(match, today) {
        const text = match[0].toLowerCase();

        if (text === 'today') return new Date(today);
        if (text === 'tomorrow') return addUnits(today, 1, 'day');
        if (text === 'yesterday') return addUnits(today, -1, 'day');

        if (match[2]) {
            const weekday = WEEKDAYS[match[3].toLowerCase()];
            return match[2].toLowerCase() === 'next'
                ? nextWeekday(today, weekday)
                : lastWeekday(today, weekday);
        }

        if (match[4]) {
            const amount = parseNumber(match[4]);
            if (amount === null) return null;
            return addUnits(today, amount, match[5].toLowerCase());
        }

        if (match[6]) {
            const amount = parseNumber(match[6]);
            if (amount === null) return null;
            return addUnits(today, -amount, match[7].toLowerCase());
        }

        return null;
    }

    // All fuzzy matches in `text`, sorted by position.
    function findMatches(text, today) {
        const matches = [];
        FUZZY_REGEX.lastIndex = 0;
        let m;
        while ((m = FUZZY_REGEX.exec(text)) !== null) {
            const date = resolvePhrase(m, today);
            if (date) {
                matches.push({ index: m.index, length: m[0].length, text: m[0], date });
            }
            if (m[0].length === 0) FUZZY_REGEX.lastIndex++; // safety against empty matches
        }
        matches.sort((a, b) => a.index - b.index);
        return matches;
    }

    window.DH = window.DH || {};
    DH.fuzzy = { findMatches };
})();
