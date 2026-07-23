# Durable delivery, bus, and subscriptions

`packages/tracker` owns the typed service policy for durable delivery envelopes,
bus events, named subscriptions, and passive slots. It has no SQLite dependency
and never reads a harness registry or `dashboard/server` JSON state. The service
receives two narrow ports: `TrackerStoragePort` for already-owned durable facts,
and `DeliveryEligibilityPort` for canonical endpoint eligibility.

Control-plane composition is the only path that combines the ports. The
persistence owner retains both raw SQLite handles and returns a typed
`trackerStorage()` capability; it does not return a database, Kysely instance,
or constructor. Eligibility is a complete canonical snapshot containing
recipient, generation, endpoint, owner fence, mode, readiness, and capability
evidence. An envelope snapshots that fact when it is created and rechecks it
immediately before transport. A changed endpoint, generation, fence, readiness,
or delivery qualification moves the active claim back to retrying, so stale
transport is never attempted.

GOL-82 adds `TicketDispatchService` as the narrow policy bridge for browser,
bearer, and MCP ticket dispatch. It reads the project-scoped current ticket
assignee, resolves that one logical session to its active generation, asks the
canonical eligibility port to classify the endpoint, and creates exactly one
`tracker_envelopes` row through `DurableDeliveryService` for `ready`,
`pull_only`, or `next_turn`. `dispatchedTo` is historical output and a runtime
reference is validation-only; neither selects delivery. A legacy session hint
can fill an otherwise absent assignee only after the same fail-closed scoped
resolution. The persistence-owned `deliveryEligibility()` seam retains every
generation, highest-fence, lease, health/control, consumer/delivery, and
supported-capability check while exposing those three queue classifications;
routes never reconstruct a partial readiness rule. Terminal, missing,
ambiguous, and ineligible requests leave no envelope. A ticket-CAS miss records
the typed `stale` result in the durable GOL-79 receipt before it can replay; it
also leaves no envelope. The enclosing receipt/CAS transaction rolls a later
enqueue failure and its committed GOL-80 invalidation back. Acceptance is not
settlement, which remains the later claim/prepare/ack/reply/fail/recovery path.

The public bearer adapter is target-free. The dedicated MCP adapter path may
use `GOLEM_CONTROL_PLANE_MCP_CREDENTIAL`, or the retained
`GOLEM_CONTROL_PLANE_BEARER` compatibility credential when the former is
absent; its server-side durable `mcp` adapter binding, not the environment
variable spelling, establishes MCP provenance. It may provide only a scoped
legacy session alias plus `note`, `workspace`, and `when_idle`; the service
carries those approved hints in the canonical envelope while current endpoint
classification remains server-owned. Browser callers never receive that
compatibility surface.

`tracker/002-durable-delivery-bus` adds namespaced tables alongside an existing
legacy tracker schema. `tracker/003-live-tracker-core` creates the canonical
typed core rows on a fresh managed database; it does not alter delivery
ownership. Envelopes have stable IDs and idempotency keys with a
payload fingerprint; exact duplicates return their original fact while a
conflicting ID or idempotency key is rejected. A claim is a SQL
compare-and-swap with an owner, opaque token, and lease. Only the matching token
can settle it. Expired leases replay, bounded attempts dead-letter, deadlines
expire, acknowledgements are idempotent, replies retain immutable root/parent
routes, and every material transition writes an audit fact.

Bus events use immutable IDs, deduplication keys, and monotonically assigned
SQLite sequences. Named subscriptions retain an explicit cursor; offline and
suspended subscriptions do not produce an unsolicited delivery turn. Cursor
commit is compare-and-swap. Passive slots are separately coalesced per
recipient/ticket/category and can only be emitted after an explicit lease claim;
release makes the exact batch replayable and commit removes only its leased
entries. Pruning preserves unconsumed manual subscription interest and records
the counts in `tracker_delivery_audit`.

The single J4 real-process journey in `test/tracker/delivery-bus.test.mjs`
proves the boundary end-to-end using a temporary `GOLEM_HOME` and real SQLite.
It covers duplicate/conflicting envelopes and events, CAS claims, endpoint fence
recheck, ack/reply, retry/deadline/dead-letter, named cursor replay, passive
claim/release/commit, manual-interest prune/audit, and a child process that
claims then exits without closing its owner so restart replay is observed.
