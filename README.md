# Date Highlighter

Browser extension (Manifest V3) that highlights dates on whitelisted sites by
urgency stage: overdue, today, tomorrow, soon, upcoming, and future. Successor
to the Jira-specific *Jira Date Redifier*.

Runs in Chromium browsers (Chrome, Edge) and in Firefox.

## Table of Contents

- [Features](#features)
- [Layout](#layout)
- [How highlighting is applied](#how-highlighting-is-applied)
- [Refining selectors](#refining-selectors)
  - [Example: Jira (anonymized)](#example-jira-anonymized)
- [Development](#development)
- [Packaging](#packaging)
- [Deferred](#deferred)

## Features

- **Detection** of dates as raw text (multiple formats), fuzzy phrases
  ("tomorrow", "in two days", "next Friday"), and machine-readable
  `<time datetime>` / `data-datetime` attributes.
- **Configurable stages** with independent light/dark colours, editable
  thresholds, per-stage text styling (border, bold, italic, underline), and
  automatic `prefers-color-scheme` detection (or a forced theme).
- **Whitelist-only activation** per site; `*` allows all sites, and
  `*.example.com` covers a domain plus subdomains. Entries may carry CSS
  selectors (`domain: selector1, selector2`) that restrict highlighting to
  matching elements -- e.g. `*.atlassian.net: td[data-column-type$=":datepicker"]`
  highlights dates only inside Jira date-picker columns. An entry without
  selectors scans the whole page.
- **Selectable formats** - enable or disable each format independently:

  | Format | Example |
  | --- | --- |
  | ISO | 2026-10-23 |
  | Month name | October 23, 2026 |
  | Day month year | 23 October 2026 |
  | Numeric slash | 23/10/26 (day-first or month-first setting) |

- **Popup** for quick control: track/untrack the current site, toggle formats
  and fuzzy dates, and a link to the full settings page.
- **Live updates** - saving settings, untracking a site, or switching the
  master switch off takes effect in open tabs immediately, with no reload.
- **Stays out of the way** - editable regions are never touched, inline SVG
  text is left alone, and the page's own text nodes are preserved wherever
  possible.

## Layout

- `content/` - content script (API namespace alias, whitelist gate with
  per-domain selector scoping, scanner, format registry, fuzzy parser, style
  injection)
- `popup/` - toolbar popup
- `options/` - full settings page (whitelist and selectors, formats, stage
  colours and thresholds, theme)
- `tests/` - Node test suites (see [Development](#development))

## How highlighting is applied

Two strategies share one scan, and both are undone when a site is untracked or
settings change:

- **Element marks.** When an element's entire text is a single date -- a Jira
  due-date cell, a `<time>` element, a table cell -- the stage class goes on
  that element. The page keeps its own text nodes, and the full chip styling
  (background, 1px outline, padding, bold, italic, underline) applies.
- **Ranges.** A date inside running text is registered with the CSS Custom
  Highlight API, which highlights the text without touching the DOM at all.
  That API supports colour, background colour, and underline only, so dates in
  prose do not get the chip outline, bold, or italic treatment. Browsers
  without the API fall back to wrapping the date in a `<span>`, which does
  replace the surrounding text node.

Positions and marks carry a `data-dh` attribute, so cleanup only ever removes
what the extension created. Both paths skip `contenteditable` hosts (typing in
a Jira comment box is never disturbed), form controls, `<script>`/`<style>`
content, and inline SVG.

Pages that stay open across midnight are re-bucketed automatically, and so are
tabs restored from the background the next day.

## Refining selectors

By default a whitelisted domain scans the whole page. On busy sites this can
over-highlight; attach CSS selectors to the entry to restrict highlighting to
the elements you actually care about:

```text
*.atlassian.net: td[data-column-type$=":datepicker"]
```

An entry may carry several selectors, comma-separated after the colon. The
scanner highlights dates found inside any element matching any of them.
Scoped entries also pick up content that the site renders later (SPA boards,
inline-edit views, re-rendered panes) without a reload.

### Example: Jira (anonymized)

A Jira board's "Due date" column renders something like:

```html
<td data-column-type=" issuance:datepicker">
  <div data-testid="issue-field-inline-edit-read-view-container.ui.container"
       data-vc="issue-field-inline-edit-read-view-container">
    <button aria-label="Edit Due date, 10/22/2026"></button>
    <span>Oct 22, 2026</span>
  </div>
</td>
```

The cell is identifiable by its `data-column-type` attribute ending in
`:datepicker`, so one selector covers every due-date cell on the board:

```text
*.atlassian.net: td[data-column-type$=":datepicker"]
```

Some views (inline-edit read views, detail panes) render the same field
outside a datepicker column. In that case add a second selector that targets
the text container directly:

```text
*.atlassian.net: td[data-column-type$=":datepicker"], [data-vc="issue-field-inline-edit-read-view-container"] > span
```

Tips:

- Prefer attribute hooks the app itself provides (`data-testid`, `data-vc`,
  `data-column-type`) over generated class names, which change between
  releases.
- Match on structure, not on the date text itself.
- Scope to the innermost element that contains the date (`... > span`
  rather than a wide container) to avoid highlighting unrelated text.
- Selectors must be valid CSS. Invalid selectors are ignored; enable
  **Debug logging** in Advanced settings to see a console warning naming the
  offending selector.
- Because a site's entries can be covered by several patterns, the popup says
  **Tracked via `*.example.com`** and leaves the wildcard to the settings page
  rather than adding a second, wider entry for that one host.

## Development

Load the directory as an unpacked extension (Edge: `edge://extensions`,
Chrome: `chrome://extensions`, Firefox: `about:debugging#/runtime/this-firefox`,
both with developer mode enabled), or use `web-ext` for Firefox:

```sh
npx web-ext run
npx web-ext lint
```

Settings live in the `sync` storage area. The extension requests `storage` and
`activeTab` only: site access is read from the popup when you open it, not
granted for every page.

Every extension context resolves its namespace once, in `content/core/api.js`,
exposing it as `DH.api`. Firefox only supports promises from `chrome.*` in
Manifest V3 (Firefox 106 and later) and treats `browser.*` as the preferred
namespace, so the alias takes `browser` when it exists and falls back to
`chrome`. Chromium exposes `browser` alongside `chrome` from Chrome 148 and
Edge 136. Do not call either namespace directly elsewhere: the test suite
fails if a source file names one.

Firefox notes:

- `browser_specific_settings.gecko.id` is required. Without it a temporary
  (developer) install receives a temporary add-on ID and every `storage.sync`
  call is rejected, which leaves the extension with defaults and failed saves.
  The published ID is `DateHighlighterExt@pomme.cafe`; changing it after
  release would register a different add-on, so treat it as fixed.
- `gecko.data_collection_permissions.required` must list `none`: the extension
  transmits nothing, and AMO requires the declaration for new submissions.
- `gecko.strict_min_version` is `146.0`, which buys the CSS Custom Highlight
  API (Firefox 140) plus `text-decoration` inside `::highlight()` (Firefox
  146). Lower it to `140.0` to cover older ESR builds at the cost of the
  underline styling on range highlights; browsers below that use the span
  fallback.
- The manifest keys above are Firefox-only and ignored by Chromium, so one
  manifest serves both stores. Packaging a store zip (excluding `tests/` and
  `node_modules/`) is not scripted yet.

Tests run on Node with no build step (jsdom is the only developer dependency):

```sh
npm install
npm test
```

- `tests/test.js` - pure logic: formats, fuzzy parsing, stage bucketing, date
  attributes, whitelist matching, stored-settings validation.
- `tests/dom.test.js` - scanner behaviour in a simulated page, covering both
  rendering paths, scoped sites, editable regions, SVG, mutation storms, and
  midnight rollover. It also runs the content script against Firefox's
  namespace shape, where only `browser.*` carries promises.
- `tests/ui.test.js` - popup and options behaviour, including save failures,
  invalid ranges, reset, and the Firefox namespace shape.

Expectations are expressed in local calendar terms, so the whole suite passes
in any timezone; run it with `TZ=America/Toronto npm test` (or any other zone)
to confirm after touching date math.

## Packaging

Two platform trios build the same two versioned archives into `dist/`, reading
the version from `manifest.json`:

- `Date-Highlighter-<version>.zip` - the store package: the extension payload
  with `manifest.json` at the archive root, ready for the Chrome Web Store,
  Edge Add-ons, or addons.mozilla.org. One archive serves all three, and it
  stays a `.zip` on every platform because the stores require zip uploads.
- `Date-Highlighter-<version>-bundle.zip` (Windows) or
  `Date-Highlighter-<version>-bundle.tar.gz` (Unix) - the same payload plus the
  platform installer inside a single `Date-Highlighter/` folder. Extract it
  into the install location directly, or extract it anywhere and run the
  bundled installer.

Both trios copy the same payload (`manifest.json`, `content/`, `popup/`,
`options/`), skip the same exclusions (`.git`, `node_modules`, `tests`, `dist`,
`web-ext-artifacts`), clean the same artifact folders, and support a dry run:
`-WhatIf` on PowerShell, `-n` on POSIX sh.

### Windows (PowerShell 5.1 and 7+)

```powershell
.\pack.ps1                          # both archives into dist\
.\pack.ps1 -OutputPath D:\Builds    # somewhere else
.\pack.ps1 -WhatIf                  # report without writing

.\install.ps1                       # %LOCALAPPDATA%\Date-Highlighter\extension
.\install.ps1 -Destination D:\Extensions\Date-Highlighter
.\install.ps1 -WhatIf

.\cleanup.ps1                       # removes dist\ and web-ext-artifacts\
.\cleanup.ps1 -WhatIf
```

### macOS, Linux, BSD (POSIX sh)

```sh
./pack.sh                           # both archives into dist/
./pack.sh -o /tmp/builds            # somewhere else

./install.sh                        # ${XDG_DATA_HOME:-$HOME/.local/share}/Date-Highlighter/extension
./install.sh -p ~/extensions/Date-Highlighter
DEST=~/extensions/Date-Highlighter ./install.sh
./install.sh -n                     # report without writing

./cleanup.sh                        # removes dist/ and web-ext-artifacts/
./cleanup.sh -n
./cleanup.sh -p /path/to/checkout   # clean another checkout
```

`pack.sh` needs `tar`, plus Info-ZIP `zip` or `python3` for the store package
(`zip` is preferred when both are present). `install.sh` clean-replaces an
existing install, so no stale file survives an upgrade; a destination that
cannot be written exits non-zero with the manual `mkdir -p` command and a note
that system locations may need `sudo`. The sh scripts are dash-compatible
(`sh -n` clean, verified under dash and bash); `cleanup.sh` refuses to delete
anything unless the root holds `.git` or `manifest.json`, and every `rm -rf`
passes through an allowlist and prefix guard.

Run `npx web-ext lint` before packaging to validate the manifest for Firefox;
both trios exclude `tests/`, `node_modules/`, and the packaging scripts from the
archives. The payload, exclusion, and artifact lists are duplicated per script
by design so each one stays standalone; when they change, update all six.

## Deferred

Time-of-day handling, non-English month names, icons for the store listings,
and per-site content-script registration
(`chrome.scripting.registerContentScripts`) so the content script is not
loaded on unlisted sites at all.
