// status.js -- day-offset math and stage bucketing.
(function () {
    'use strict';

    const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

    window.DH = window.DH || {};
    DH.status = { getToday, diffDays, getStage };
})();
