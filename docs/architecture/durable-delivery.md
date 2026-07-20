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

`tracker/002-durable-delivery-bus` adds namespaced tables alongside an existing
legacy tracker schema. Envelopes have stable IDs and idempotency keys with a
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
