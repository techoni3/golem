# UI primitives

`@golem/ui` is the private design-system boundary for future React 19
surfaces. It exports semantic CSS tokens, the theme provider, and unstyled
React Aria component wrappers. It does not migrate or import legacy
`dashboard/web/` pages. React is a UI peer; the typed Vite app aliases React
and ReactDOM to its own React 19 installation so React Aria and this package
share one rendered runtime without changing the legacy React 18 dashboard.

## Tokens and themes

Import `@golem/ui/tokens.css` once at an application entry point. The ordered
`golem.tokens`, `golem.primitives`, and `golem.design-lab` layers use only
semantic `--g-*` variables for canvas, raised/sunken surfaces, text, borders,
focus, state colors, spacing, radii, elevation, motion, and the fixed
`--g-passport-max: 520px` bound. `ThemeProvider` stores only an explicit
`system`, `light`, or `dark` preference under `golem.ui.theme`; it reflects
the resolved theme on `<html>`. The dashboard's inline bootstrap validates
that same closed preference set before its module script, so an invalid value
falls back to the system theme and the first paint cannot use it. Native
`prefers-contrast`, `forced-colors`, and `prefers-reduced-motion` media
features stay authoritative; they do not create a second preference store.

## Primitive contract

The package composes React Aria Buttons, links, labeled text/search/select and
combobox fields, checkbox/switch, tabs, menus, modal dialog/drawer, tooltip,
toast/alert, list/table, status, skeleton/state panel, and PassportCard.
Focus-visible, forced-colors, contrast, and reduced-motion behavior are
token-level rules.
Dialog and drawer accept `returnFocusRef`; callers provide the trigger target
when a controlled overlay must return keyboard focus after Escape. The
primitive owns that restoration after teardown; callers must not rescue it by
looking up a DOM id.

`PassportCard` is always at most 520px wide. Its role select stops pointer,
keyboard, and click propagation before it can activate the card surface; that
containment is a public behavioral invariant.

Do not introduce raw palette values, custom keyboard handling for a React Aria
primitive, page/domain props, or imports from `dashboard/web/` here. Use
`Text slot="description"` and `FieldError` through the field wrappers instead
of visually adjacent explanatory text: descriptions and invalid errors must
remain programmatically associated with their inputs.

## Design lab and verification

`apps/dashboard/src/design-lab` remains an isolated source composition and is
not imported by the production dashboard entry. The production bundle mounts
only `DashboardShell` and its typed routes; the bounded legacy compatibility
island remains a deliberate dynamic import until its still-referenced
overlays are migrated. Do not delete the island or its scoped CSS while those
imports remain.

`npm run test:ui-primitives` verifies the primitive lab in a temporary
headless Chrome profile. The dashboard browser matrices separately exercise
every production route at 360, 768, 1280, and wide viewports, keyboard
navigation, accessible names and landmarks, light/dark/system resolution,
forced colors, reduced motion, reconnection, long content, and empty states
against a real control-plane service.
