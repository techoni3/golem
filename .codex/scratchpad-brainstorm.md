# GOL-415 directional-intent record

Purpose: preserve the design direction while Golem evolves through small, independent, safe patches initiated by concrete user problems.

## Execution shape

- status: superseded
- previous_direction: one implementation work item for `golem:terra:builder`
- final_direction: GOL-415 is not executable and will never be dispatched; each future problem gets its own small contract, patch, rollback boundary, and independent verification
- reason: a broad self-rewrite would disrupt the substrate while it supports active work in other projects

## Thread A: Stored contracts and approval boundaries

### Q1. Completion and verification result storage
- status: answered
- decision: hybrid typed records; machine-critical fields are discrete, narrative values may contain Markdown
- blocks: schema, MCP contracts, phase validation, review rendering
- options: hybrid typed records; fully discrete rows; structured Markdown payloads

### Q2. Approved-spec revision semantics
- status: answered
- decision: no delta reapproval; approval is a durable historical decision, the spec remains freely editable, dispatched work stays frozen, and execution-impacting changes use amended/new work plus attention rather than whole-spec reapproval
- blocks: revision schema, reapproval attention, work-contract amendment behavior
- options: material-delta reapproval; any-edit reapproval; approval freezes spec

### Q3. Risk tiers and auto-close eligibility
- status: answered
- decision: three tiers; low auto-closes after independent PASS, medium uses parent rollup or standalone human acceptance, high requires explicit human gates
- blocks: planner inputs, verification routing, digest and human gate rules
- options: three tiers; two tiers; auto-close disabled initially

## Thread B: Lifecycle and review mechanics

### Q4. Spec phase gates
- status: answered
- decision: accept the conservative lifecycle/review bundle
- depends_on: Q1, Q2
- proposed default: required structured sections at grounded/designed/planned/closing, validated for substance only where machinery can do so reliably

### Q5. Durable review record shape
- status: answered
- decision: immutable record references immutable result/revision versions and snapshots the exact ask, verdict, conditions, actor, and timestamp
- depends_on: Q1, Q2
- proposed default: immutable record references an immutable spec revision and result versions, while snapshotting the exact ask, verdict, conditions, actor, and timestamp

### Q6. Partial acceptance and dependency unblocking
- status: answered
- decision: accepted children become terminal and unblock dependencies; rejected/incomplete children remain open; parent stays open until required scope is terminal or explicitly removed
- proposed default: accepted children become terminal and unblock dependencies; rejected/incomplete children remain open; parent spec stays executing/closing until all required scope is terminal or explicitly removed

## Thread C: V1 product surface

### Q7. Capture entry points
- status: answered
- decision: global command plus project-local action; direct New work and New spec remain equally visible
- proposed default: global command plus project-local action; direct New work and New spec remain equally visible

### Q8. Document subtypes and revision display
- status: answered
- decision: research, analysis, reference, and decision-record; ordinary revision history until parent freeze
- proposed default: research, analysis, reference, decision-record; ordinary revision history until the parent freezes

### Q9. Digest and urgent-notification channel
- status: answered
- decision: dashboard-only daily digest in v1; urgent in-app attention for blockers, failures, and credentials; external push deferred
- proposed default: dashboard-only daily digest in v1; urgent in-app attention for blockers, failures, and credentials; external push deferred

### Q10. User-facing work name
- status: answered
- decision: retain `work-item` internally; display `Execution plan` in the typed drawer and `Work` in compact navigation
- proposed default: retain `work-item` internally; display `Execution plan` in the typed drawer and `Work` in compact navigation

## Thread D: Brownfield retirement

### Q11. Retirement policy
- status: answered
- decision: hide and stop creating retired surfaces in v1; retain compatible columns/rows and avoid destructive schema drops
- proposed default: hide and stop creating streams/source_ref/comment-dispatch/question/decision/fix surfaces in v1; retain compatible columns/rows and avoid destructive schema drops

### Q12. Legacy decisions
- status: answered
- decision: fold still-relevant decisions into active specs/docs during live-data cleanup; archive the rest without rewriting history
- proposed default: fold still-relevant decisions into active specs/docs during live-data cleanup; archive the rest without rewriting history

## Thread E: Coherent project progress and sequencing

### Q13. Replace Plan, Milestones, and Internal sequencing
- status: answered
- decision: replace the separate surfaces with one derived Project Journey; retire PLAN.md and manual milestones as product progress sources; retire streams; keep wave only as an optional internal dispatch gate shown as Now/Next/Waiting context
- user_observation: all three attempt to visualize timeline/progress and fail; carrying them feels like dead weight
- scope: PLAN.md parser/watchers, milestone journal events and feeds, streams, ticket waves/dependencies, tracker progress percentages, project-page sections, global project summaries
- governing constraint: prefer one derived model over parallel manually maintained progress systems
- recon: dispatched read-only audit to `golem:hy:explorer` on 2026-07-10

### Q14. Reevaluate the remaining project-page segments and data
- status: answered
- decision: replace the seven re-orderable project sections with a fixed resumption hierarchy: Needs You, Project Journey, meaningful changes since visit, compact Current actors; full inventories and diagnostics remain secondary pages/drawers
- scope: Tickets vs Specs, Team vs Sessions, activity/events, project cards, and any data whose only purpose is a weak or duplicated panel
- decision test: every surviving segment must answer one distinct user question and derive from an authoritative source

### Candidate direction under audit
- status: answered
- retire `PLAN.md` as a product source; specs plus frozen work contracts already own design and execution planning
- retire manual milestones as a product progress source; derive “since you looked” from tracker phase/result/review/attention events
- retire streams and their panel; retain wave/dependency mechanics only where they gate work inside a parent spec, surfaced as plain next/waiting-on context rather than a separate sequencing model
- remove project completion percentages based on equal ticket counts; show lifecycle phase and concrete rollups such as built/verified/accepted/blocked counts
- replace re-orderable project sections with one fixed resumption hierarchy: Needs You → Project Journey → meaningful changes since visit → compact Current actors
- Project Journey groups work under active specs/initiatives, uses a separate direct-work lane for parentless atomic work, and derives phase rollups plus Now/Next/Waiting without persisting another progress model
- full cross-project Specs and Tracker pages remain inventory/search surfaces; the project page is the primary resumption surface rather than another pair of boards
- collapse Team and Sessions into one compact current-actors surface; keep full agent/session diagnostics on the Agents page and session drawer
- preserve raw tracker/journal events for audit/debugging without treating the raw feed as a user-facing progress narrative

## Closeout sequence

1. GOL-415 is rewritten as a directional north star and parked.
2. No implementation plan or child is created from this record.
3. The user supplies one concrete problem at a time.
4. Each problem is grounded and delivered as the smallest safe vertical patch.
5. Operational learning may revise GOL-415 without reopening a master program.

---

# GOL-416 / GOL-417 communication-backbone diagnosis

Purpose: diagnose unreliable agent-to-agent handoffs and excessive event-subscription interruptions before choosing replacement mechanics.

## Current evidence

- status: diagnosis complete; awaiting user answers before solution brainstorming
- confirmed: sender-side `202 {"ok":true}` means an HTTP channel/bridge accepted a push; it is not a durable receipt, model acknowledgment, work-start, completion, or reply-delivery signal
- confirmed: immediate ticket dispatch assigns the ticket before channel push and returns top-level `ok: true` even when the nested channel result is unsuccessful (`dashboard/server/index.js:1397-1439`)
- confirmed: opencode `/push` starts `client.session.prompt(...)` without awaiting it, marks the session busy, and returns 202 (`shims/opencode/index.js:477-488`)
- confirmed: `session_notify` sends an ordinary brief containing no sender id, reply-to, or correlation id; `ack`/`respond` publish to dashboard SSE rather than to the originating session
- confirmed: `dashboard/server/dispatch-queue.js` treats native session `status === "idle"` plus a live channel row as eligible for both queued dispatch and event-digest delivery
- confirmed: the same drainer uses a shared 60-second per-session cooldown for dispatches and subscription digests
- confirmed: GOL-339 records a real `when_idle` dispatch that remained pending after the target was observed idle; immediate redispatch succeeded
- confirmed: GOL-411 addresses a separate live opencode defect where sibling sessions sharing one server can lack individual channel rows; its implementation is still incomplete
- confirmed: GOL-338 describes self-echo and indiscriminate multi-subscriber fan-out; GOL-350 and GOL-352 through GOL-357 are a proposed solution cluster, not accepted direction
- confirmed: two diagnostic dispatches in this investigation returned 202 immediately, while target-authored work-start transitions appeared about 46 seconds and 125 seconds later; transport acceptance was not work-start evidence
- confirmed: production audit found 385 subscriptions, 186 active, and 371 using the broad default tracker/lifecycle/custom classes
- confirmed: 4,108 digest-eligible ticket/spec events occurred in seven days; `state_change` (1,485), `commented` (1,023), and dispatch events (938) dominate
- confirmed: 946 child events were mirrored into spec-tree topics in seven days, approximately 23% of digest-eligible volume
- confirmed: the current session had 12 active subscriptions, including completed/parked work with no expiry; 10 were suspended, leaving only GOL-416 and GOL-417 active
- completed: GOL-350 and children GOL-352 through GOL-357 were archived with preservation comments; none had been built
- unknown: which exact two project/session pairs produced the incidents observed on 2026-07-10
- unknown: whether the missing manager reply was never emitted, misaddressed, accepted but not injected, or injected but not acted on

## Thread A: Delivery truth and work truth

### Q1. What must a sender be allowed to claim after each delivery stage?
- status: answered
- decision: assignment/queued, acknowledged, and working are distinct; a correlated target acknowledgment is sufficient for the manager to know the worker picked up the message, while lack of acknowledgment should support a check-in path
- note: the manager cannot require immediate work-start because a busy worker may legitimately pick up later
- blocks: status language, receipt protocol, timeout/retry behavior, dashboard state
- decision surface: accepted by transport; delivered into target context; acknowledged by target; work started with evidence; result returned

### Q2. Should direct session messages remain a work-control primitive?
- status: exploring
- direction: durable tracker work remains authoritative; a durable correlated message envelope controls handoff/ack/check-in, while harness push is only the wake-up transport
- blocks: whether reliable orchestration depends on push messages or durable tracker state
- decision surface: push is authoritative; push is a wake-up hint over durable work; direct messages are advisory only

### Q3. What should happen when the target accepts a push but produces no acknowledgment?
- status: answered
- decision: a model-free monitor sends one correlated check-in to the same worker, then escalates exact evidence to the manager if acknowledgment still does not arrive; no automatic reassignment
- depends_on: Q1, Q2
- decision surface: retry same session; mark delivery uncertain and require human/manager action; reclaim work for another session; no automatic action

## Thread B: Session identity and liveness

### Q4. What does `idle` need to mean operationally?
- status: pending
- blocks: queued-delivery eligibility and honest manager status
- decision surface: process waiting for input; model available and channel-consumer active; no current ticket work; separate these into distinct signals

### Q5. Is one persistent session per role still a requirement?
- status: pending
- blocks: recovery model and importance of warm context
- decision surface: persistent role sessions; disposable workers launched from durable work; hybrid with persistence as a cache

### Q6. How quickly may stale channel/session identity be declared unusable?
- status: pending
- depends_on: Q4, Q5
- decision surface: heartbeat lease; explicit consumer acknowledgment; harness-specific liveness; manual-only recovery

## Thread C: Observation versus interruption

### Q7. What kinds of tracker changes deserve a live model turn?
- status: answered
- decision: explicit action only; directly addressed asks, blockers, failures, or human decisions may wake a model; ordinary history/lifecycle remains pull-based
- research question: can passive lifecycle events be queued outside model context and injected together with the next real brief without triggering an LLM turn in Claude Code and opencode?
- blocks: subscription semantics and token budget
- decision surface: only explicit asks/blockers; lifecycle changes plus explicit asks; user-configurable event classes; no automatic model wake-ups

### Q8. Who chooses the live recipient of a change?
- status: pending
- blocks: comment/event addressing and manager visibility
- decision surface: event author; ticket ownership/role policy; central router; recipient pulls from an inbox

### Q9. Should subscriptions observe history, trigger work, or be split into two primitives?
- status: exploring
- direction: split durable observation from actionable wake-up; optionally attach accumulated passive observations to the next real action if harness mechanics support it safely
- capability result: the common behavior is feasible, but the transport differs by harness; use a Golem-owned durable buffer as the cross-harness source of truth rather than treating opencode's stronger native primitive as the product contract
- blocks: whether a broad topic subscription can remain safe
- decision surface: observation only; wake-up only; explicit split between durable watch and actionable notification

## Thread D: Retirement scope

### Q10. Which prior record should be archived as the superseded event-subscription attempt?
- status: answered
- candidates: GOL-350 plus GOL-352 through GOL-357 (solution cluster); GOL-338 and GOL-339 (original problem records); GOL-386 (two-day-old mixed notes covering both idle builders and subscriptions)
- decision: GOL-350 plus GOL-352 through GOL-357 archived as the superseded solution cluster; GOL-338/GOL-339 preserved as incident evidence
- decision: archive GOL-386 now that its observations are captured in GOL-416/GOL-417

## User correction on diagnostic scope

- status: answered
- decision: do not spend effort reconstructing the exact two incidents; use the symptoms to expose system weaknesses that make the class of failure possible, then brownfield those weaknesses so recurrence is structurally prevented
- implication: incident-specific attribution is optional supporting evidence, not a prerequisite for architecture work

## Investigation routing

- GOL-416 dispatched read-only to `golem:dsf:explorer`
- GOL-417 dispatched read-only to `golem:hy:explorer`
- no implementation or solution design is authorized yet

## Working diagnosis

The backbone currently conflates four different facts:

1. A durable ticket assignment exists.
2. An intermediary accepted an HTTP push.
3. The target model received and acknowledged the message.
4. The target is actively doing evidenced work and can return a result to the requester.

Only the first two are reliably represented. Managers can therefore report “working” after assignment/push even though neither receipt nor work-start has been proven. The reverse path is weaker: ordinary notifications and dispatches carry no requester identity or reply correlation, while `ack`/`respond` are dashboard-facing rather than sender-facing.

Subscriptions compound the problem rather than compensate for it. They automatically accumulate, have no expiry, broadcast by topic/class without actor or recipient relevance, mirror child events into spec trees, and turn every eligible mutation into a model interruption when the subscriber becomes idle. Durable history and live wake-up are currently the same primitive.

## Passive next-turn context capability

- status: researched and mechanically verified in GOL-419
- Claude Code channel: no silent/no-reply insert; every `notifications/claude/channel` event becomes model work, and transport completion is not an acknowledgment
- Claude Code hook: `UserPromptSubmit.additionalContext` can add context alongside the next real human prompt without creating an extra turn; `SessionStart.additionalContext` refreshes on startup/resume/compact
- opencode message API: `client.session.prompt({ noReply: true })` persists a user message and returns before starting the inference loop
- opencode plugin: stable `chat.message` can mutate the next real user message before the existing model call; experimental message/system transforms exist but are not required
- common brownfield direction: keep passive events in a Golem-owned, durable, bounded per-session buffer/cursor; drain a compact batch only when a real turn already exists
- Claude Code real-turn seams: `UserPromptSubmit` for human prompts; append the passive batch to an actionable channel brief before sending it
- opencode real-turn seams: `chat.message` for human prompts; append the passive batch to an actionable bridge brief before sending it; native `noReply` remains an optional optimization, not the cross-harness contract
- important consequence: passive lifecycle observation need not wake either model, even though Claude Code lacks native silent insertion

## Current convergence

- decided: diagnose and brownfield the weakness class; exact incident reconstruction is unnecessary
- decided: a correlated worker acknowledgment, not transport acceptance or immediate work-start, tells the manager the worker picked up the handoff
- decided: explicit actions only wake a model
- decided: ordinary lifecycle/history is passive and may be attached to the next real turn
- decided: GOL-350 plus GOL-352 through GOL-357 and GOL-386 are archived
- decided: overdue acknowledgment monitoring is model-free, provided its state is visible and intuitively accessible; manager self-wake timers are fallback only
- decided: one correlated ping, then manager escalation; never automatic reassignment on a missing ack
- decided: compact relevant passive delta if it is deterministic and AI-free; raw events only if deterministic coalescing proves unexpectedly costly
- confirmed: deterministic coalescing is sufficient; relevance comes from structured routing, not AI classification
- exploring: durable message-envelope states, ack timeout start/deadline, and the exact low-clutter communication-health surface
- open: initial passive-event allowlist and consumption/retry semantics

## Brownfield leverage discovered

- existing model-free monitor: `dashboard/server/dispatch-queue.js` checks unacknowledged dispatches every drainer tick using configurable `dispatch.unackedWindowMinutes`
- existing persisted lifecycle: `dispatch_delivery_attempted`, `dispatch_unacked_warning`, `dispatch_unacked_dismissed`, supersession, and target-activity auto-resolution in `dashboard/server/tracker-db.js`
- existing UI: clickable/dismissible unacked badges already render on agent/session cards and ticket cards via `UnackedDispatchBadge`
- current semantic weakness: acknowledgment is inferred from later ticket activity and actor aliases, not an explicit correlated ack from the target
- brownfield direction: retain the monitor/event/UI spine; replace inferred ack with durable message envelopes and explicit `ack(message_id)`; add one ping and escalation stages
- visibility direction: quiet normal state, overdue badge on involved session/ticket, escalation into attention, and a drill-down communication timeline; raw traffic lives in an Agents diagnostics drawer rather than a permanent project panel

## Next decision batch

### Q11. Communication-health surface placement
- status: pending
- options: Agents header health indicator + drill-down drawer; dedicated top-level traffic page; project Current Actors integration only

### Q12. When should the acknowledgment deadline start?
- status: pending
- options: after actual delivery attempt to an idle target; after any transport acceptance; status-aware deadline with queued state exempt

### Q13. Initial passive-event allowlist
- status: answered
- decision: phase change, assignment, blocker, verification/result; explicitly addressed comments are actionable rather than passive

---

# GOL-420 implementation plan

- status: planned and handed to manager lane
- parent: GOL-420, `phase=planned`
- builder: user-selected `golem:terra:builder`
- execution rule: one sequential main-checkout writer; manager dispatches only the next wave after prior verification

## Waves

1. GOL-421 — durable actionable envelopes, truthful dispatch facts, explicit correlated ack/reply
2. GOL-422 — one model-free ping then one escalation, reusing GOL-140 monitor and badges
3. GOL-423 — deterministic passive buffer/cursor and Claude Code next-turn injection
4. GOL-424 — opencode parity and safe retirement of broad subscription wake-ups/auto-subscription
5. GOL-425 — compact Agents communication health indicator, Needs You escalation, and drill-down timeline

## Settled implementation defaults

- new additive `message_envelopes` ledger; existing `dispatch_queue` remains scheduler
- ack deadline starts five minutes after actual delivery opportunity, never while queued
- explicit `ack(message_id)` validates target identity and routes to stored sender/reply session id
- one ping then one escalation; no ownership mutation or auto-reassign
- passive buffer is deterministic, capped at 20 ticket groups/4096 bytes, and AI-free
- common Golem-owned buffer; Claude Code uses `UserPromptSubmit.additionalContext`, opencode uses stable `chat.message`
- legacy subscription wake-ups cut over only after both adapters pass; historical rows remain
- existing local badges are extended; one Agents health indicator opens a drawer; no project panel
- 18 journey-level tests cover persistence, queueing, ack/reply, restart, ping/escalation, passive projection, both harnesses, subscription cutover, and desktop/mobile UI

## Handoff

- no live roled manager was present
- readiness notification sent to `sol:consultant`, which previously acted in the manager lane for GOL-411
- requested manager actions: verify readiness, close stale GOL-402, dispatch only GOL-421 to Terra, route independent verification before later waves
