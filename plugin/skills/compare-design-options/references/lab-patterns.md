# Decision-lab patterns and comparison axes

Use this reference to select a lab structure and prevent cosmetic-only variation.

## Format map

| Decision | Preferred format | Hold constant | Vary meaningfully |
|---|---|---|---|
| Whole theme or visual system | Shared-stage switcher | Content, layout, status meaning, viewport | Palette, typography, hierarchy, surfaces, elevation, borders, material signature, data colors |
| Page layout | Shared-stage switcher | Data, actions, priority, states | Region order, scan path, grouping, responsive collapse, action placement |
| Component UX | Side-by-side specimens | Size, content, state, surrounding context | Control model, affordance, disclosure, density, feedback |
| Navigation or information architecture | Shared shell plus task checks | Destinations, permissions, content inventory | Grouping, labels, depth, orientation, mobile behavior |
| Interaction workflow | Interactive flow | Goal, starting data, success criteria, failures | Step count, sequencing, progressive disclosure, confirmation, undo and recovery |
| Density | Side-by-side specimens at fixed width | Record count and information | Compression, hierarchy, wrapping, secondary-detail access |
| Edge states | State matrix or switchable stage | Component geometry and recovery goal | Empty guidance, loading stability, error detail, permissions, offline behavior |

Use a hybrid only when a broad direction also contains a local decision that cannot be judged in context. For example, use a shared theme stage with one fixed component specimen row, not eight separately authored dashboards.

## Fairness rules

- Keep names, values, timestamps, statuses, and data volume identical across options.
- Keep every required action reachable in every option.
- Show options at equal scale and in the same viewport.
- Preserve semantic status meaning; do not make one option look healthier by changing the scenario.
- Give all options equivalent polish. Do not use a deliberately weak straw option.
- Describe trade-offs with the same rubric and level of detail.

## Distinctness test

Write one pairwise sentence explaining why each neighboring option changes the experience. Rework an option when the sentence reduces to a single cosmetic substitution unrelated to the decision.

Seek coherent theses, not a bag of effects. Useful theses include compact command surface, calm guided workspace, scan-first ledger, progressive-focus flow, spatial navigation, or recovery-first form. Each thesis should affect at least two relevant axes.

## Evaluation axes

Select only axes that influence the decision:

- Scanability and information hierarchy
- Task completion speed and action reachability
- Learnability, orientation, and navigation depth
- Density, wrapping, and long-session readability
- Feedback, system status, and confidence
- Error prevention, recovery, undo, and interruption handling
- Keyboard and screen-reader operability
- Mobile reflow and touch target quality
- Brand or material fit
- Implementation complexity, migration risk, and maintainability

For every option, state one benefit, one cost, and one risk using the selected axes. Keep the comparison advisory; the human owns the decision.

## Representative state sets

Choose the smallest set that exposes the design decision:

- **Data surfaces:** normal, empty, loading, error, long text, large count.
- **Controls:** default, hover, focus, disabled, selected, validation error.
- **Navigation:** current location, deep destination, overflow, mobile collapse.
- **Flows:** entry, decision point, progress, recoverable failure, success, cancel or undo.
- **Operational dashboards:** healthy, working, waiting, offline, queued, attention required.

Do not add every state by habit. Include a state when it can change which option the human chooses.
