// content.js -- bootstrapper.
// Checks the global toggle and site whitelist before doing any DOM work.
// A whitelisted domain may carry CSS selectors that restrict scanning to
// matching subtrees; an empty selector list scans the whole page.
(function () {
    'use strict';

    const DH = window.DH;
    if (!DH || !DH.settings) return;

    let active = false;

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
        DH.styles.inject(settings);
        DH.scanner.start(settings, scope);
        active = true;
    }

    // Settings edits from the popup/options page apply to open tabs live.
    chrome.storage.onChanged.addListener(async (changes, area) => {
        if (area !== 'sync' || !changes.settings) return;
        const settings = await DH.settings.load();
        const scope = settings.enabled
            ? DH.settings.hostAllowed(settings.whitelist, location.hostname)
            : null;

        if (scope !== null && !active) {
            DH.styles.inject(settings);
            DH.scanner.start(settings, scope);
            active = true;
        } else if (scope !== null && active) {
            DH.styles.inject(settings);
            DH.scanner.restart(settings, scope);
        } else if (scope === null && active) {
            DH.scanner.stop();
            active = false;
        }
    });

    boot();
})();