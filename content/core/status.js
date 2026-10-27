// status.js -- day-offset math, stage bucketing, and machine-readable dates.
(function () {
    'use strict';

    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

    // Today's date at local midnight for clean day-level comparisons.
    function getToday() {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d;
    }

    function startOfDay(date) {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        return d;
    }

    // Whole-day difference between the date and today (negative = past).
    function diffDays(date) {
        return Math.round((startOfDay(date).getTime() - getToday().getTime()) / MS_PER_DAY);
    }

    // Returns the matching stage definition for a date, or null when no
    // stage range covers it (should not happen with contiguous defaults).
    function getStage(settings, date) {
        const offset = diffDays(date);
        for (const stage of settings.stages) {
            if (offset >= stage.min && offset <= stage.max) return stage;
        }
        return null;
    }

    // Local calendar key ('YYYY-MM-DD'). Used to notice the clock crossing
    // midnight while a page stays open.
    function dayKey(date) {
        const d = date || new Date();
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    // Local calendar date with rollover rejection (mirrors formats.js).
    function makeLocalDate(year, month, day) {
        const d = new Date(year, month, day);
        return (d.getMonth() === month && d.getDate() === day) ? d : null;
    }

    // Parses <time datetime> / [data-datetime] values. A bare YYYY-MM-DD is a
    // local calendar date and is taken literally. A value carrying a time or
    // offset is an instant, so it is reduced to the local calendar date it
    // lands on here: 2026-10-28T04:00:00Z is still October 27th in UTC-8.
    function dateFromAttribute(raw) {
        if (typeof raw !== 'string') return null;
        const text = raw.trim();
        const parts = LOCAL_DATE.exec(text);
        if (parts) return makeLocalDate(+parts[1], +parts[2] - 1, +parts[3]);
        const instant = new Date(text);
        return Number.isNaN(instant.getTime()) ? null : startOfDay(instant);
    }

    window.DH = window.DH || {};
    DH.status = { getToday, diffDays, getStage, dayKey, dateFromAttribute };
})();
