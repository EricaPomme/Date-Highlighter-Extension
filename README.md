# Date Highlighter

Browser extension (Manifest V3) that highlights dates on whitelisted sites by
urgency stage: overdue, today, tomorrow, soon, upcoming, and future. Successor
to the Jira-specific *Jira Date Redifier*.

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

- **Popup** for quick control: global enable, current-site toggle, and a link
  to the full settings page.

## Layout

- `content/` - content script (whitelist gate with per-domain selector
  scoping, scanner, format registry, fuzzy parser, style injection)
- `popup/` - toolbar popup
- `options/` - full settings page (whitelist and selectors, formats, stage
  colours and thresholds, theme)

## Refining selectors

By default a whitelisted domain scans the whole page. On busy sites this can
over-highlight; attach CSS selectors to the entry to restrict highlighting to
the elements you actually care about:

```text
*.atlassian.net: td[data-column-type$=":datepicker"]
```

An entry may carry several selectors, comma-separated after the colon. The
scanner highlights dates found inside any element matching any of them.

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

## Development

Load the directory as an unpacked extension (Edge: `edge://extensions`,
Chrome: `chrome://extensions`, enable Developer mode). Settings live in
`chrome.storage.sync`.

## Deferred

Time-of-day handling, non-English month names, and Firefox packaging.
