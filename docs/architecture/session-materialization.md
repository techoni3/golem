# Logical session materialization

`@golem/runtime` owns the `SessionService` façade; `@golem/persistence` owns
the SQLite projection.  Producers submit validated `RuntimeSignalV1` facts and
never open the database directly.  A project must already be materialized
before a session fact is accepted.

## Canonical rows

`logical_sessions` is the project-scoped identity.  Each immutable
`session_generations` row carries harness, lifecycle, clocks, and lifecycle
provenance.  `session_projection` and `generation_projection` add revisions,
metadata, field provenance, parent/resume links, actor activity, and dashboard
observation without changing the legacy table shapes.  `session_aliases` is
scoped by project, harness, alias kind, producer, and value; unresolved or
conflicting evidence returns `review` and is never auto-linked.

## Ordering and lifecycle

Source-observed time wins over receipt time; an event-id/producer tie break
resolves equal timestamps.  Lifecycle stage/rank is monotonic: terminal states
cannot resurrect, while late activity may update the separate activity fact
without changing terminal state.  Reordered facts are retained as pending until
their generation exists, then replayed inside the same owner transaction.

Accepted semantic changes emit one deterministic tracker outbox explanation.
`SessionService.observe` updates only the observation projection, so dashboard
observation cannot impersonate actor activity.

The focused evidence is `test/sessions/session-service.test.mjs` plus the
`cross-harness-session-lifecycle` and `session-reorder-restart-replay` J2
journeys.  Endpoint leases, delivery, cards, and harness parsing remain outside
this materializer.
