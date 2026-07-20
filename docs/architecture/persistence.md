# Single-owner SQLite persistence

`packages/persistence` is the only Wave 4 composition port for writable
`runtime.db` and `tracker.db`. Its public index exposes contract types and the
single `persistenceCompositionPort`; the owner constructor, raw SQLite/Kysely
handles, schema table maps, and repositories are private modules. The owner
acquires a mode-0600 runtime lock before opening either database, configures a
managed store with foreign keys, WAL, a 2500ms busy timeout, and
`synchronous=FULL`, then exposes explicit transactions and status through that
narrow capability. An unmanaged legacy tracker is inspection-only until its
explicit baseline apply, so even its journal mode is not rewritten on open.

The databases are separate connections and are never attached or committed as
one transaction. A runtime mutation writes its raw deduplicated event,
canonical rows, and `runtime_outbox` row together. Tracker/management work is
subsequently driven from that durable outbox; no API may claim cross-file
atomicity.

Runtime migration `runtime/001-initial` remains immutable. Its follow-up,
`runtime/002-watermarks-metadata-outbox-audit`, adds producer watermarks,
event metadata versions/dispositions, endpoint fences and capability
observations, migration runs/findings/decisions, legacy snapshots, and the
claim metadata used by the runtime outbox. Migration definitions are immutable
SQL with source checksums recorded in `golem_migrations`; malformed ledgers,
unknown ledger IDs, a newer schema, and checksum drift all refuse before an
apply. Apply accepts the exact stable dry-run plan hash only. Before an apply
the owner creates a verified `VACUUM INTO` backup,
applies inside one transaction, and records `migration_audit`.
`integrity_check` and `foreign_key_check` must pass. A dry-run clones to a
temporary SQLite file, applies the same plan there, verifies it, and removes
the clone and its temporary backup without writing the source database.

The existing tracker file is inspected without mutation when it has legacy
tables. An explicit `tracker/001-baseline` application adds only Golem
migration/audit metadata and preserves tracker table rows. Fresh tracker files
receive the same baseline automatically. Outbox consumers must claim a bounded
batch with a lease, replay only expired claims, and acknowledge with the active
claim token; this preserves at-least-once cross-store delivery without claiming
one cross-file transaction. A close checkpoints bounded WAL work, closes both
connections, and removes its lock. The selected J3 journey proves the private
owner boundary, owner race and child crash recovery, pre/post-commit failpoints,
outbox claim/replay/ack, clone dry-run source immutability,
checksum/schema/ledger/failing-migration refusal, tracker count preservation,
backup, restart, integrity, and temporary-home cleanup.
