# Typed tracker core (GOL-35)

`@golem/tracker` owns typed work-item behavior: ticket/spec/question/decision/fix
creation, display ids, deterministic phase machines, comments and replies,
links, streams, ranks/waves, list/search/get, and legacy payload normalization.
It has no SQLite constructor, HTTP server, runtime liveness rule, or adapter
registry reader.

`@golem/persistence` owns the private SQLite `TrackerCoreRepository` and the
explicit `tracker/003-live-tracker-core` migration. A control-plane composition
capability is the only way to obtain the narrow storage port; the port derives
resource revision and outbox evidence from the canonical `events.id` in one
SQLite transaction. UI, CLI, MCP, and adapters only use API/facade
surfaces and cannot import the repository or persistence constructor.

## Compatibility and migration

Opening an unmanaged legacy `tracker.db` is read-compatible and does not change
its bytes, journal mode, counts, or display ids. Applying the approved
checksummed tracker plan is explicit. It creates canonical live rows on a fresh
managed database;
the typed repository directly reads and writes the existing live
`tickets`, `comments`, `links`, `streams`, and `events` rows. The canonical
`TKT-*` and per-project display allocation is therefore shared immediately.

The C1–C3 compatibility facade maps typed records to the existing snake-case
REST/MCP payload shapes. The shipped dashboard opens its normal tracker facade
and attaches a tracker-only migration-neutral capability before routes, so
the existing REST/MCP routes delegate typed mutations over one live row. A
legacy update (including kind/state/phase plus ordinary fields) is validated
and committed by one explicit-CAS typed transaction; it emits the same
specialized state/phase/assignment and dispatch-settlement records, stamps
the lifecycle columns, and addresses durable comment dispatches without a
partial transition. Phase evidence is derived from durable rows, and an
exceptional done skip requires a trusted authenticated manager/human
`ActorContext`; the transaction records a revision-bound
`manager_skip_authorized` event. Caller text, comment prose, actor strings,
or artifact booleans cannot fabricate completion. Envelope settlement carries
the exact emitted `dispatch_completion_stamped` event id (never a later
`MAX(id)` lookup). Ticket and stream resource revisions derive from canonical
event ids; a stale write never falls back to a legacy mutation. Rollback leaves
the original legacy tables and rows intact and points routes back to the
unchanged legacy owner; no migration-neutral production attachment mutates the
legacy file or creates a shadow authority.

The public exceptional-close adapter accepts only `{id, expectedRevision,
reason}`. The dashboard composition injects its verified server-owned human
context; the generic control-plane/MCP composition has no close capability and
rejects `skip_reason` before forwarding a request. The authorization and close
effects share one revision-bound transaction, so the authorization event cannot
be replayed at an old revision.

## Runtime references

Tracker inputs may carry an externally supplied reference containing only
validated opaque `prj_`, `ses_`, and `gen_` ids. It is validated at the service
boundary and never persisted as tracker authority; the tracker never derives
endpoint health, readiness, aliases, paths, names, PIDs, or native identity.

## Evidence

`npm run test:tracker-core` is the one J4 real-boundary journey. It creates a
representative legacy SQLite tracker through the shipped dashboard opener,
closes that owner, proves no mutation before the approved migration, then opens
the same file through independent persistence and dashboard owners. The
dashboard facade is attached to the typed compatibility delegates, so both
facades observe the same live rows while canonical event-backed revisions
advance and stale writes fail. The journey covers display-id
allocation under independent child processes, optimistic revision conflict,
durable phase artifacts, anchored comment/reply, links, streams, opaque runtime
references, transactional existing-event/outbox accounting, and temporary-home
cleanup. `tracker-core-compatibility` is the thin registered J4 scenario adapter
over the same test.
