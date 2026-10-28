// api.js -- the extension API namespace, resolved once per context.
// browser.* is the standard namespace and the one Firefox documents as
// preferred. Its chrome.* porting alias is callback-only in Manifest V2, so a
// promise-style call there resolves to undefined and settings silently fall
// back to defaults. Chromium exposes browser.* from Chrome 148 and Edge 136,
// and returns promises from chrome.* under Manifest V3, so taking browser when
// it exists and falling back to chrome covers every target.
// Everything else in the extension must go through DH.api.
(function () {
    'use strict';

    const root = typeof globalThis !== 'undefined' ? globalThis : window;
    const api = root.browser || root.chrome;

    if (!api || !api.storage || !api.runtime) {
        // Loading this outside an extension context is a wiring mistake, and
        // failing here names it instead of leaving callers with undefined.
        throw new Error('Date Highlighter: no extension API namespace available');
    }

    window.DH = window.DH || {};
    DH.api = api;
})();
