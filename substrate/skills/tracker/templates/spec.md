# Spec: <subject>

## 1. TLDR

Five lines, always current: what this is and where it stands. Rewrite as the spec evolves — a
reader should never have to reconstruct status from the sections below.

## 2. Intent

The distilled canonical why: the problem or desire, in a few sentences.

<details>
<summary>Raw thoughts (preserved verbatim)</summary>

The human's original notes, in their own language. Never rewrite or tidy these.

</details>

## 3. Grounding

<details open>
<summary>Load-bearing facts only — each with a source ref, each tied to a decision</summary>

Only facts that change a decision. Three facts is a normal section; a system tour is a violation.

- <fact> (`path/file.js:123`) — feeds D<n>
- <fact> (<link>) — feeds D<n>

</details>

## 4. Requirements

<details open>
<summary>Goals / Qualities / Non-goals — all the whats</summary>

**Goals**

- <functional requirement, checkable>

**Qualities**

- <only the non-functionals that matter here; delete when none>

**Non-goals**

- <explicit exclusions, so scope cannot grow silently>

</details>

## 5. Decisions

<details open>
<summary>Living register — an open question is an undecided decision</summary>

Debate lives here; when decided, the entry collapses to call + why and the conclusion is written
into Requirements or Design where it belongs. Reopen a decided entry only with the human.

### D1 — <title> · open

- Context: <what forces this decision>
- Options: <the realistic options with trade-offs>
- Recommendation: <yours, with the reason>

### D2 — <title> · decided

- Call: <what was decided>
- Why: <the reason, one or two lines>

</details>

## 6. Design

<details open>
<summary>The hows — grounded, referencing decisions by id</summary>

The chosen direction, contracts, data shapes, and touch points — deep enough that a builder never
reconstructs the design conversation. Reference D<n> instead of re-arguing it.

</details>

## 7. Acceptance

<details open>
<summary>Agent-runnable end-to-end scenarios</summary>

Each criterion is an executable scenario — an agent with a browser or simulator can run this
section directly and drop the evidence as comments.

- [ ] <open X, do Y, observe Z>

</details>

## Rollout

Optional — delete unless migration or sequencing genuinely exists.

> [!NOTE]
> Child tasks and supporting docs hang under this ticket via parent_id and render below the body.
