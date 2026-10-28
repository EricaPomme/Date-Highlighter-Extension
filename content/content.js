// content.js -- bootstrapper.
// Checks the global toggle and site whitelist before doing any DOM work.
// A whitelisted domain may carry CSS selectors that restrict scanning to
// matching subtrees; an empty selector list scans the whole page.
(function () {
    'use strict';

    const DH = window.DH;
    if (!DH || !DH.settings) return;

    let active = false;

    function activate(settings, scope) {
        DH.styles.inject(settings);
        // scanner.start() tears down any previous run first, so this also
        // handles live settings edits.
        DH.scanner.start(settings, scope);
        active = true;
    }

    function deactivate() {
        DH.scanner.stop();
        DH.styles.remove();
        active = false;
    }

    async function boot() {
        const settings = await DH.settings.load();
        const scope = DH.settings.hostAllowed(settings.whitelist, location.hostname);
        if (settings.debug) {
            console.log('[Date Highlighter] boot', {
                enabled: settings.enabled, scope, hostname: location.hostname
            });
        }
        if (!settings.enabled || scope === null) {
            return; // no styles, no scanning, no observers
        }
        activate(settings, scope);
    }

    // Settings edits from the popup/options page apply to open tabs live.
    DH.api.storage.onChanged.addListener(async (changes, area) => {
        if (area !== 'sync' || !changes.settings) return;
        const settings = await DH.settings.load();
        const scope = settings.enabled
            ? DH.settings.hostAllowed(settings.whitelist, location.hostname)
            : null;

        if (scope === null) {
            if (active) deactivate();
            return;
        }
        activate(settings, scope);
    });

    boot();
})();
