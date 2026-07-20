# UI primitives

`@golem/ui` is the private design-system boundary for future React 19
surfaces. It exports semantic CSS tokens, the theme provider, and unstyled
React Aria component wrappers. It does not migrate or import legacy
`dashboard/web/` pages. React is a UI peer; the typed Vite app aliases React
and ReactDOM to its own React 19 installation so React Aria and this package
share one rendered runtime without changing the legacy React 18 dashboard.

## Tokens and themes

Import `@golem/ui/tokens.css` once at an application entry point. Components
use only semantic `--g-*` variables for canvas, surfaces, text, borders,
focus, state colors, spacing, radii, motion, layering, and the fixed
`--g-passport-max: 520px` bound. `ThemeProvider` stores only an explicit
`system`, `light`, or `dark` preference under `golem.ui.theme`; it reflects
the resolved theme on `<html>`. The dashboard entry repeats the small
bootstrap before its module script so the first paint uses that resolved
theme.

## Primitive contract

The package composes React Aria Buttons, links, labeled text/search/select and
combobox fields, checkbox/switch, tabs, menus, modal dialog/drawer, tooltip,
toast/alert, list/table, status, skeleton/state panel, and PassportCard.
Focus-visible, contrast, and reduced-motion behavior are token-level rules.
Dialog and drawer accept `returnFocusRef`; callers provide the trigger target
when a controlled overlay must return keyboard focus after Escape.

`PassportCard` is always at most 520px wide. Its role select stops pointer,
keyboard, and click propagation before it can activate the card surface; that
containment is a public behavioral invariant.

Do not introduce raw palette values, custom keyboard handling for a React Aria
primitive, page/domain props, or imports from `dashboard/web/` here. Use
`Text slot="description"` and `FieldError` through the field wrappers instead
of visually adjacent explanatory text: descriptions and invalid errors must
remain programmatically associated with their inputs.

## Design lab and verification

`apps/dashboard` mounts this isolated composition at `/design-lab`; it is not
a production-page migration. `npm run test:ui-primitives` builds both private
workspaces, serves only the generated Vite output from an ephemeral loopback
server, and drives a temporary headless Chrome profile through theme, keyboard
overlay, focus, tab, PassportCard, narrow viewport, and reduced-motion flows.
