// styles.js -- CSS injection driven by settings.
// Colour values live in CSS custom properties on :root so theme switching
// never rewrites the stage rules themselves.
// Two consumption paths share those variables: .dh-stage-* classes applied to
// elements and injected wrappers, and ::highlight() rules for ranges
// registered through the CSS Custom Highlight API.
(function () {
    'use strict';

    const STYLE_ID = 'dh-styles';
    const HIGHLIGHT_PREFIX = 'dh-';
    const HEX_COLOR = /^#[0-9a-f]{6}$/i;

    // Guard applied at build time as well as in settings.merge, so settings
    // objects that never passed through storage validation cannot break the
    // stylesheet - these values end up on other sites' pages.
    function colorValue(value, fallback) {
        const text = String(value == null ? '' : value).trim();
        return HEX_COLOR.test(text) ? text : fallback;
    }

    function stageId(stage) {
        return String(stage && stage.id ? stage.id : '').replace(/[^a-z0-9-]/gi, '');
    }

    function varBlock(stages, theme) {
        const lines = [];
        for (const stage of stages) {
            const palette = stage[theme] || stage.light || {};
            const id = stageId(stage);
            if (!id) continue;
            lines.push('  --dh-' + id + '-color: ' + colorValue(palette.color, 'inherit') + ';');
            lines.push('  --dh-' + id + '-bg: ' + colorValue(palette.bg, 'transparent') + ';');
        }
        return lines.join('\n');
    }

    function stageRules(stages) {
        return stages.map(stage => {
            const id = stageId(stage);
            if (!id) return '';
            const lines = ['  color: var(--dh-' + id + '-color) !important;'];
            if (stage.bold) lines.push('  font-weight: 800 !important;');
            if (stage.italic) lines.push('  font-style: italic !important;');
            if (stage.underline) lines.push('  text-decoration: underline !important;');
            if (stage.border) {
                // Faint rounded background chip plus a 1px outline in the
                // same colour as the foreground text.
                lines.push('  background: var(--dh-' + id + '-bg) !important;');
                lines.push('  border: 1px solid var(--dh-' + id + '-color) !important;');
                lines.push('  padding: 0 2px;');
                lines.push('  border-radius: 2px !important;');
            }
            return '.dh-stage-' + id + ' {\n' + lines.join('\n') + '\n}';
        }).filter(Boolean).join('\n\n');
    }

    // Highlight pseudo-elements accept colour, background colour, and text
    // decoration only: bold, italic, padding, and borders cannot be expressed
    // there, so dates inside running text use this reduced treatment.
    function highlightRules(stages) {
        return stages.filter(stage => stage.highlight).map(stage => {
            const id = stageId(stage);
            if (!id) return '';
            const lines = [
                '  color: var(--dh-' + id + '-color);',
                '  background-color: var(--dh-' + id + '-bg);'
            ];
            if (stage.underline) lines.push('  text-decoration: underline;');
            return '::highlight(' + HIGHLIGHT_PREFIX + id + ') {\n' + lines.join('\n') + '\n}';
        }).filter(Boolean).join('\n\n');
    }

    // Builds the full stylesheet for the current settings. theme 'auto' emits
    // both light and dark blocks with a prefers-color-scheme media query;
    // 'light' and 'dark' emit only the requested block.
    function buildCss(settings) {
        const stages = Array.isArray(settings.stages) ? settings.stages : [];
        const parts = [':root {\n' + varBlock(stages, 'light') + '\n}'];
        if (settings.theme === 'auto') {
            parts.push('@media (prefers-color-scheme: dark) {\n:root {\n' +
                varBlock(stages, 'dark') + '\n}\n}');
        } else if (settings.theme === 'dark') {
            parts.push(':root {\n' + varBlock(stages, 'dark') + '\n}');
        }
        parts.push(stageRules(stages));
        parts.push(highlightRules(stages));
        return parts.filter(Boolean).join('\n\n');
    }

    function inject(settings) {
        let style = document.getElementById(STYLE_ID);
        if (!style) {
            style = document.createElement('style');
            style.id = STYLE_ID;
            (document.head || document.documentElement).appendChild(style);
        }
        style.textContent = buildCss(settings);
        return style;
    }

    function remove() {
        const style = document.getElementById(STYLE_ID);
        if (style && style.parentNode) style.parentNode.removeChild(style);
    }

    window.DH = window.DH || {};
    DH.styles = { inject, remove, buildCss, STYLE_ID, HIGHLIGHT_PREFIX };
})();
