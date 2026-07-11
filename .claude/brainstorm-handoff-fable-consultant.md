# Handoff — tracker information-model redesign brainstorm (fable:consultant → gpt56:consultant)

2026-07-10 · From session `fable:consultant`. The user ran this brainstorm in parallel with two consultants; they are consolidating on you. This file encapsulates my positions and the reasoning behind them. **User-locked decisions are binding; my recommendations are input for you to weigh, not constraints.**

Companion file: `.claude/scratchpad-brainstorm.md` — the full question ledger with per-question status and the user's verbatim answers. Read it; this handoff is the distillation, that file is the trail.

## Problem framing (user's own words, condensed)

No upfront design for the tracker's information model. Chronic confusions: "is what I'm writing a spec or a ticket?", "comment on a spec or a new ticket?". Tickets have tiny bodies and massive comments ("kinda the opposite"). No separation of read-only docs vs work specs. Review section never opened; can't keep up with closing work. Workflow: single engineer, heavy multitasking across ~5 projects with parallel items in each. Wants brownfield improvement, not a rewrite.

## Grounding data (I measured; verify freshness against ~/.golem/tracker.db)

- Kinds in use: work-item 209, spec 36, fix 35, decision 6, question 1 (active, unarchived).
- Body/comment inversion is real: work-item avg 2.7k chars body vs 8.9k comments; spec 7.5k vs 14k (8.1 comments avg). Only kind:decision has fat bodies (~14k).
- 40 tickets in `review` state; 18 in_progress; 69 todo; 159 done.
- A Review Inbox already exists (`dashboard/web/src/other-pages.jsx:477+`) — groups review tickets by parent spec, mark-done + note+fix actions. Never opened by the user. Diagnosis (user-confirmed): no push trigger AND content built on comment soup, so it never earned trust.
- Underuse scan: source_ref 0 uses; links table 6 rows; labels 14 tickets; priority 47; wave 92; streams 27 with 65 ticket refs; comment_dispatches 6 rows.

## USER-LOCKED decisions (do not re-litigate without new information)

1. **Spec = living design document.** Body IS the design (Problem / Approach / Decisions / Open Questions), kept current by EDITS, never narrated through comments. Work items are thin pointers carved from it. (User picked this over thin-container and promoted-ticket models, seeing concrete previews of each.)
2. **Docs live INSIDE the spec.** Spec gets two collapsible child sections: **docs** (reference material — writeups, research, decision records; stateless) and **work items** (user's words: "deeply technical implementation plans; perhaps should be renamed" — rename deferred to implementation). Repo docs/ are an explicitly separate, deferred concern ("on-demand generations… some other time").
3. **The review bottleneck is context re-acquisition, not approval effort.** User verbatim (paraphrased): "I dispatched this 5 hours ago along with 10 other things across 5 projects; not remembering a deliverable's scope/AC is the resistance keeping me from confidently reviewing anything." Every review surface must be self-reconstituting — zero memory assumed, recap of intent+scope+AC before delivery+evidence.
4. **Gate posture: batch-by-spec + tiered.** Features review as ONE spec rollup card when children are built+verified. Low-risk singletons passing explorer verify auto-close into a digest. Only features and risky items reach the human.
5. **Review card = spec rollup + per-child drill-down.** Sections: WHY (frozen at dispatch) · DELIVERED (per-child one-liners, each expanding to that child's closing brief: changed/evidence/verify/deviations) · VERIFY (short human smoke steps) · FLAGS (scope changes, needs-human) · partial approve ("approve done children"). Mocked against real GOL-398; user approved the deeper variant explicitly.
6. **Recap home: hybrid, mechanically enforced.** Closing brief + verification verdict = structured fields on the ticket; the MCP transition to built/review REJECTS if missing. Comments survive only as tagged mid-flight signal ([blocker], [scope-flag], [needs-human]); untagged report dumps banned. (Follows from decisions 3+5: drill-down needs renderable structure.)
7. **Ticket-vs-comment = the scope rule.** Changes/adds acceptance criteria → new linked ticket. Same AC → comment/field on the existing item. No AC at all (writeups, findings) → doc item under the spec, never a comment. Work-item bodies frozen after dispatch.
8. **Risk tier: planner assigns at decomposition** (label). My proposed fallback — planner-less singletons unlabeled → human review (safe default) — was shown and not objected to.
9. **Resume surfaces: attention queue + per-project strips.** Dashboard home = cross-project queue of everything blocked on the human (rollup cards inline, staleness-ordered: reviews, [needs-human] flags, questions, gates). Each project view leads with a resume strip (in-flight, last event, waiting-on-you, auto-closed-since-last-visit).
10. **Trigger: badge + one daily digest** (evening, configurable), deep-linking into the queue. Channel undecided (see open questions).
11. **Migration: amnesty.** Archive done/stale untouched; hand-migrate only live work (~18 in_progress + 40 review + active specs), salvaging closing briefs from comments, re-homing orphan writeups as doc items. New rules enforce forward only.
12. **Scope appetite: all four layers** — conventions/skills, dashboard UI, schema+MCP tools, data cleanup. Full rewrite off the table.
13. **Streams: retire** (user re-confirmed at handoff time). Keep the DB column, remove from conventions/mental model — specs are the grouping container now. User also said: streams "might not be the only ones we should retire… worth looking into" → they WANT a retirement pass (see my candidates below).

## MY recommendations — pending, interrupted mid-ask (reasoning attached)

These were in the final AskUserQuestion batch the user never answered. They are yours to re-present or replace.

- **closing_brief shape → JSON keys** `{changed, evidence, verify_steps, deferred}`, each validated non-empty at transition. Reasoning: heading-regex validation of one markdown blob is gameable (empty sections pass); discrete keys make the card drill-down a direct render and let digests/explorer handoffs lift `verify_steps` standalone. Acceptable middle ground if rigidity worries them: markdown brief + separate verify_steps column (verify is the only part machinery needs to lift).
- **Spec body contract → full phase-gate**: →grounded needs Problem; →designed needs Approach+Decisions non-empty; →building needs ≥1 child; →done needs Open Questions empty or [parked]. Reasoning: the living-doc spec is the ONLY load-bearing piece with no mechanical enforcement; culture already failed once (that's today's comment soup). Known failure mode: agents stuff filler to pass gates — mitigate via manager reconcile spot-checks. Lighter fallback: designed-gate only.
- **Digest channel → phone push (ntfy-style)** over email or dashboard-only. Reasoning: dashboard-only re-creates the exact Review-Inbox failure (works only if you already open the dashboard); the digest's job is to reach the user when they're NOT looking.
- **Retirement candidates** (beyond streams; the user explicitly asked to look for more):
  - `source_ref` column (0 uses) + `comment_dispatches` table (6 rows ever) — dead weight, drop in the same migration that adds closing_brief.
  - `priority` (47 uses) — superseded: attention ordered by staleness, sequencing by wave, routing by risk. No remaining job unless they want a manual queue-jump override.
  - `kind:question` (1 use ever) — [needs-human] flags surface in the attention queue WITH the context of the item they block; strictly better than disconnected question tickets. Gates flow reroutes to flags too.
  - `kind:fix` (38 active) → merge into work-item: a fix is just a parentless work-item; singleton semantics from parentlessness, risk from label, auto-close from explorer PASS. Kind taxonomy collapses to spec / work-item / doc. Cost: backfill 38 rows + skill wording.
  - NOT retirement: `labels` (14 uses) gets REPURPOSED as the risk-tier carrier; `links` (6 rows) becomes load-bearing for the scope rule's "new linked ticket".
  - `kind:decision` already retiring per locked decision 1 — the 6 legacy decision tickets archive under amnesty; fold still-relevant content into spec bodies. (Un-ratified detail.)
- **Sequencing → conventions+schema first, surfaces second, digest/tiering third.** Reasoning: fields GENERATE the structured data; UI RENDERS it; digest PULLS the user in. Building UI first renders empty fields. Amnesty pass rides alongside wave 2/3.

## Risks I flagged (with guards) — carry these forward regardless of your design

1. Living spec body has no mechanical enforcement unless phase gates demand sections → without a guard it regresses to today. (Guard: phase-gate contract above + manager freshness check.)
2. [scope-flag] comments rot without a sweep owner → route flags into the attention queue; flag older than a day = defect in the manager lane. (Real precedent: GOL-402 was discovered mid-build, scope +1.)
3. Auto-close miscalibration is silent by construction (you only see what DID flag) → digest lists every auto-closed item as a one-liner; user audit-samples for the first weeks.
4. Batch-by-spec adds latency on long specs; early children wait → partial approve exists, and per-child explorer verification stays; the human batch is the FINAL gate, not the only gate.

## Open questions for you to resolve with the user

QN1 closing_brief field shape · QN2 spec section contract strictness · QN3 digest channel · QN4 work-item rename (user parked to implementation: keep / "plan" / "task") · QN5 retirement list ratification (streams done; rest above) · QN6 fate of the 6 legacy kind:decision tickets.

Method note that worked well with this user: demonstrative > abstract — every high-stakes question I asked carried a concrete preview (mock cards, rule walkthroughs) built from THEIR real data (GOL-398), and they engaged deeply with those. They also answer in free text when no option fits — leave room for that.
