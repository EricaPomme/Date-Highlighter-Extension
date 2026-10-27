// styles.js -- CSS injection driven by settings.
// Colour values live in CSS custom properties on :root so theme switching
// never rewrites the stage rules themselves.
(function () {
    'use strict';

    const STYLE_ID = 'dh-styles';

    function varBlock(stages, theme) {
        const lines = [];
        for (const stage of stages) {
            const c = stage[theme] || stage.light;
            lines.push('  --dh-' + stage.id + '-color: ' + c.color + ';');
            lines.push('  --dh-' + stage.id + '-bg: ' + c.bg + ';');
        }
        return lines.join('\n');
    }

    function stageRules(stages) {
        return stages.map(stage => {
            const lines = ['  color: var(--dh-' + stage.id + '-color) !important;'];
            if (stage.bold) lines.push('  font-weight: 800 !important;');
            if (stage.italic) lines.push('  font-style: italic !important;');
            if (stage.underline) lines.push('  text-decoration: underline !important;');
            if (stage.border) {
                // Padded background box, matching the prior art addon.
                lines.push('  background: var(--dh-' + stage.id + '-bg) !important;');
                lines.push('  padding: 0 2px !important;');
                lines.push('  border-radius: 2px !important;');
            }
            return '.dh-stage-' + stage.id + ' {\n' + lines.join('\n') + '\n}';
        }).join('\n\n');
    }

    // Builds the full stylesheet for the current settings. theme 'auto' emits
    // both light and dark blocks with a prefers-color-scheme media query;
    // 'light' and 'dark' emit only the requested block.
    function buildCss(settings) {
        const parts = [':root {\n' + varBlock(settings.stages, 'light') + '\n}'];
        if (settings.theme === 'auto') {
            parts.push('@media (prefers-color-scheme: dark) {\n:root {\n' +
                varBlock(settings.stages, 'dark') + '\n}\n}');
        } else if (settings.theme === 'dark') {
            parts.push(':root {\n' + varBlock(settings.stages, 'dark') + '\n}');
        }
        parts.push(stageRules(settings.stages));
        return parts.join('\n\n');
    }

    function inject(settings) {
        let style = document.getElementById(STYLE_ID);
        if (!style) {
            style = document.createElement('style');
            style.id = STYLE_ID;
            (document.head || document.documentElement).appendChild(style);
        }
        style.textContent = buildCss(settings);
    }

    window.DH = window.DH || {};
    DH.styles = { inject, buildCss, STYLE_ID };
})();
