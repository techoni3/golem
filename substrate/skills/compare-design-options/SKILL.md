---
name: compare-design-options
description: Create an interactive standalone HTML decision lab comparing UI/UX directions before production implementation. Use to evaluate 5–8 alternatives for visual themes, page layouts, component UX, navigation, interaction flows, density, or empty and error states. Not for choosing between technical approaches.
---

# Compare Design Options

Turn an unresolved design choice into a realistic browser-rendered comparison. Preserve production code during exploration and stop after the user selects a winner or hybrid.

Read [references/lab-patterns.md](references/lab-patterns.md) before choosing the comparison format and evaluation axes.

## Establish the real product context

1. Read repository instructions and the codebase map before exploring.
2. Inspect the actual shell, target views/components, design tokens, data shapes, interactions, responsive rules, and existing tests. Read source and types instead of guessing at frameworks or APIs.
3. Use real product terminology and representative content. Derive states and constraints from the current implementation; identify unknowns explicitly.
4. Capture the decision in one sentence: what the user must choose, what remains invariant, and which axes may vary.

Do not edit production UI files, tokens, behavior, routes, or persistence during this comparison stage. Add only an isolated decision-lab artifact in a clearly non-production location such as `docs/design/`, unless the user names another location.

## Choose the smallest useful lab

- Use a **shared-stage switcher** when the decision changes a whole theme, page composition, shell, navigation system, or other broad context. Render one realistic stage and switch its complete direction in place.
- Use a **side-by-side component comparison** when the decision is local and simultaneous visual comparison matters more than navigation. Keep examples at the same size and state.
- Use an **interactive flow lab** when sequencing, disclosure, recovery, or state transitions are the decision. Let the user perform the same task through every option.

Combine formats only when one format would hide a material trade-off. Do not build a miniature product when a focused specimen answers the decision.

## Define a fair comparison contract

Before coding, fix the common stage:

- Use the same realistic data, copy, actions, status meanings, states, and viewport across options.
- Include the current direction as a labeled baseline when comparison against existing behavior matters.
- Choose 5–8 options. Give each a clear name, one design thesis, and a distinct interaction or visual system.
- Make options materially different on the decision's relevant axes. If two options differ only by a color value, spacing nudge, or border radius when that is not the decision, merge or redesign one.
- State the main benefit, cost, and risk for every option without declaring a winner.

## Build the decision lab

Create one self-contained HTML file with inline CSS, JavaScript, and SVG where practical. Avoid build steps and external dependencies unless the repository already provides a reliable local asset.

Include:

- A concise decision header describing the question and invariants.
- A polished option control that always identifies the active option and supports direct keyboard use.
- Realistic shared content at production-like density, including important success and edge states.
- A consistent trade-off summary for the active option.
- A way to compare deeply: preserve the active option, view, and useful lab state in `localStorage`; use a URL hash or query parameter when direct linking materially helps review.
- Responsive layouts at desktop and mobile widths without changing the comparison's content contract.
- Semantic controls, visible `:focus-visible` treatment, sensible tab order, labels, sufficient contrast, non-color status cues, and no keyboard traps.
- `prefers-reduced-motion` handling for every nonessential transition or animation.

Keep option data and rendering structured so every direction receives the same content and states. Avoid duplicating whole page trees when tokens or small render functions can express the variation clearly.

## Render and inspect

Load any applicable repository browser-testing instructions before browser work. Serve or open the artifact in a real browser and inspect it visually; source review alone is not verification.

Verify mechanically:

1. Switch through every option and confirm its name, thesis, and material differences appear.
2. Exercise the complete keyboard path, including option selection, flow controls, focus visibility, and Escape behavior for overlays.
3. Reload and confirm persisted/deep-linked state restores safely.
4. Inspect representative desktop and mobile screenshots for clipping, overflow, illegible contrast, unstable layout, and occluded floating controls.
5. Exercise reduced motion and the relevant loading, empty, error, long-content, offline, or permission states.
6. Check the browser console and record the exact validation commands and outputs.

Iterate on visible defects before presenting the lab. Do not claim visual quality without browser-rendered evidence.

## Hand off the decision

Deliver the artifact path or live URL, name all options, and summarize the meaningful trade-offs. Ask the user to choose:

- one winner, or
- a specific hybrid naming the base option and the exact elements to borrow.

Stop there. Do not select for the user, migrate tokens, or implement the winning direction in production until the user explicitly approves it as a separate implementation step.
