# Doc: <short title — what this page answers or explores>

<!-- FORM RULES — keep this comment block; it governs how every section below is written.
Goal: maximum human scan-efficiency. Diagrams over prose. Tables over lists. Bullets over
paragraphs. STE: short sentences, active voice, one term per concept.
Emoji anchors (one meaning each, never decorative — same vocabulary as Global Rules):
  ✅ done/pass · ❌ fail/rejected · ⚠️ risk/caveat · 🔒 locked · ❓ open · 🎯 goal ·
  🚫 non-goal · 📌 load-bearing fact · ▶ next/action
Contrast: > [!NOTE] context · > [!WARNING] risk · > [!IMPORTANT] locked/critical.
No inline HTML color/style spans.
Diagram palette — same as templates/spec, pick by relevance, ONE concern per diagram, one-line
caption under each: flowchart · sequenceDiagram · classDiagram · erDiagram · stateDiagram-v2 ·
journey · timeline · eventmodeling (command → event → read-model loops ONLY) · quadrantChart.
Prefer tall over wide — a wide, shallow diagram reads poorly; re-orient (flowchart TD) or
split rather than widen.
Color keys meaning: one meaning per hue per diagram, muted mid-tone fills (classDef) legible
on light and dark themes; never decorative.
Mermaid gotchas: no ";" inside sequenceDiagram message text; escape "|" as "\|" inside table
cells; blank line after </summary> before markdown; the body must never START with an HTML tag.
Validate every block before saving: mermaid-cli exits 0 even on broken langium-based types —
render to SVG and check it for an error marker, not just the exit code.
One template, two shapes — keep the sections the job needs, delete the rest:
  research/exploration → Question · Summary · Findings · Implications · Method
  brainstorm scratchpad → Question · Summary · one section per exploration thread
-->

## Question

<!-- form: the commission in 1–2 lines — what this doc answers, or which decisions it explores,
and for which spec or decision (name the parent). -->

## Summary

<!-- form: the standing answer up front, ≤7 STE bullets — most readers read only this; keep it
current as the page evolves. Scratchpad shape: the standing insights, and which spec decision
(D#) each thread feeds. -->

- <bullet>

## Findings

<!-- form: research shape. Facts with evidence, diagram-first: palette diagrams with captions
for shape and structure, 📌 bullets for facts a diagram cannot carry, tables for comparisons.
ALL file:line refs live in the collapsed Evidence table — never inline in the reading flow. -->

```mermaid
flowchart LR
  A[what exists] --> B[one concern per diagram]
```

*Caption: <one line — what this diagram shows>.*

- 📌 <fact a diagram cannot carry>

### Evidence

<details>
<summary>fact → source refs</summary>

| 📌 Fact | Refs |
|---|---|
| <fact> | `path/file.ext:12-34` |

</details>

## <exploration thread>

<!-- form: scratchpad shape — one section per exploration thread: topology and ontology
explainers, tangents, wild options not yet attached to a decision. Decisions themselves live
ONLY in the parent spec's canonical blocks (templates/spec § Decisions) — never duplicate them
here; this page builds the understanding that feeds them. This is the human's comment surface —
expect replies on the spec, on this scratchpad, and in chat.
When a thread has served its purpose: note which D# it fed (the spec's locked block links back
via Trail:), then wrap the worked material in <details> — archived for reference, out of the
way. -->

```mermaid
flowchart TD
  A[the thing explored] --> B[what it reveals]
```

*Caption: <one line — what this shows>.*

- 📌 <insight the diagram cannot carry>
- ▶ feeds: <D# in the parent spec>

## Implications

<!-- form: optional — what the findings mean for the commissioning spec or decision, plus your
recommendation. Delete when not needed. -->

## Method

<!-- form: optional — how this was gathered: commands run, sources consulted, scope covered.
Keep when credibility or reproducibility matters; delete otherwise. -->
