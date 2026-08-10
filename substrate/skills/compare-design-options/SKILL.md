---
name: compare-design-options
description: Create an interactive standalone HTML decision lab comparing UI/UX directions before production implementation. Use to evaluate alternatives for visual themes, layouts, component UX, navigation, flows, density, or empty and error states. Not for choosing between technical approaches.
---

# Compare design options

Turn an unresolved design choice into a realistic browser-rendered comparison. Build the smallest
artifact that makes the decision visible, preserve production code during exploration, and stop
after the human selects a winner or hybrid.

Read [references/lab-patterns.md](references/lab-patterns.md) before choosing the comparison
format and evaluation axes.

## Establish the real product context

1. Read the repository instructions and codebase map, then inspect the actual shell, target
   views, design tokens, data shapes, interactions, and responsive rules. Read source and types
   instead of guessing at frameworks.
2. Use real product terminology and representative content. Derive states and constraints from
   the current implementation; name unknowns explicitly.
3. Capture the decision in one sentence: what the human must choose, what stays invariant, and
   which axes may vary.

Do not edit production UI files, tokens, behavior, routes, or persistence during comparison. Add
only an isolated decision-lab artifact in a clearly non-production location such as
`docs/design/`, unless the human names another location.

## Shape the comparison

**Compare 2–4 distinct options by default.** Use more only when the human asks or the decision
genuinely needs them — every extra option dilutes the contrast that makes the choice easy. Give
each option a name, one design thesis, and a real difference on the decision's relevant axes; if
two options differ only by a token value when that is not the decision, merge them. Include the
current direction as a labeled baseline when comparison against existing behavior matters. State
each option's main benefit, cost, and risk without declaring a winner.

Pick the smallest useful format:

- a **shared-stage switcher** when the decision changes a whole theme, page composition, or
  navigation system;
- a **side-by-side comparison** when the decision is local and simultaneous viewing matters;
- an **interactive flow lab** only when sequencing, disclosure, or state transitions *are* the
  decision.

Hold the important content constant across options: same data, copy, actions, states, and
viewport. Include only the interactions, responsive behavior, and edge states that can change the
decision — a focused specimen beats a miniature product.

## Build and verify

Create one self-contained HTML file with inline CSS/JS/SVG, no build steps or external
dependencies. Keep option data structured so every direction renders the same content. Use
semantic controls, a visible active-option indicator, keyboard access, and sufficient contrast.
Add persistence or deep links only when they materially help the review.

Load `golem:browsing` before browser work, then open the artifact and inspect it rendered —
source review alone is not verification. Switch through every option, exercise the keyboard path
and any decision-relevant states, check both desktop and mobile widths for clipping or overflow,
and check the console. Fix visible defects before presenting.

## Hand off the decision

Deliver the artifact path or URL, name the options, and summarize the meaningful trade-offs. Ask
the human to choose one winner or a specific hybrid (the base option plus the exact elements to
borrow). Stop there — do not select for the human or implement the winning direction until the
human approves that as a separate step.
