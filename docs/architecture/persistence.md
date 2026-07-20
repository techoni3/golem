# Single-owner SQLite persistence

`packages/persistence` owns the contract for writable `runtime.db` and
`tracker.db`, but its public index exposes only contracts and migration facts.
The private `@golem/persistence/control-plane` constructor is mechanically
permitted only to the internal `@golem/control-plane` composition module; the
control-plane public entry does not re-export it and other workspaces cannot
import the app layer. The owner constructor, raw SQLite/Kysely handles, schema
table maps, and repositories are private modules.
The owner acquires a nonce-bearing guard directory before opening either
database; the adjacent mode-0600 file is diagnostics only and is never removed
by an owner that did not create its matching nonce. This permits stale dead-PID
recovery without deleting a replacement owner record. The owner configures a
managed store with foreign keys, WAL, a 2500ms busy timeout, and
`synchronous=FULL`, then exposes explicit transactions and status through that
narrow capability. An unmanaged legacy tracker is inspection-only until its
explicit baseline apply, so even its journal mode is not rewritten on open.

The databases are separate connections and are never attached or committed as
one transaction. A runtime mutation writes its raw deduplicated event,
canonical rows, and `runtime_outbox` row together. Tracker/management work is
subsequently driven from that durable outbox; no API may claim cross-file
atomicity.

This unreleased branch deliberately rewrites canonical
`runtime/001-initial`, rather than preserving a rejected checksum. It defines
TEXT project locations with observed paths, aliases and relations; ordinal,
exact GOL-15 lifecycle generations (`starting`, `idle`, `active`, `waiting`,
`ending`, `ended`, `errored`, `superseded`); strongly scoped session aliases;
separate source/received/materialized/activity/terminal clocks plus named
schema-versioned lifecycle and field provenance; and endpoint
revision/state/fence/delivery/readiness/control facts. Composite project keys
keep every location alias/relation endpoint and session/generation alias in its
own project. Endpoint lifecycle is `claiming|healthy|degraded|released|expired|superseded`
and readiness is `ready|held_busy|held_waiting|pull_only|next_turn|unsupported|unhealthy|uninitialized`.
Commands, delivery envelopes, migration runs, and migration decisions also use
closed SQL/TypeScript vocabularies. Terminal generations (`ended`, `errored`,
`superseded`) are history-only and excluded from `live_sessions`. Migration definitions are
immutable SQL with source checksums recorded in `golem_migrations`; malformed
ledgers, unknown ledger IDs, a newer schema, and checksum drift all refuse
before an apply. Apply accepts the exact stable dry-run plan hash only. Before an apply
the owner creates a verified `VACUUM INTO` backup,
applies inside one transaction, and records `migration_audit`.
`integrity_check` and `foreign_key_check` must pass. A dry-run clones to a
temporary SQLite file, applies the same plan there, verifies it, and removes
the clone and its temporary backup without writing the source database.

The existing tracker file is inspected without mutation when it has legacy
tables. An explicit `tracker/001-baseline` application adds only Golem
migration/audit metadata and preserves tracker table rows. Fresh tracker files
receive the same baseline automatically. Persistence receives an injected
clock. Outbox consumers claim a bounded batch with a lease, replay only expired
claims, acknowledge with the active claim token, and record exponential
`next_attempt_at` backoff through a bounded observable permanent failure; this
preserves at-least-once cross-store delivery without claiming one cross-file
transaction. A close checkpoints bounded WAL work, closes both connections,
and releases only its matching guard nonce. The selected J3 journey proves the
writer boundary, final schema constraints, owner race and child crash recovery,
pre/post-commit failpoints, bounded outbox claim/replay/ack/failure, clone
dry-run source immutability, checksum/schema/ledger/failing-migration refusal,
tracker count preservation, backup, restart, integrity, and temporary-home
cleanup.
