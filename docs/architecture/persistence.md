# Single-owner SQLite persistence

`packages/persistence` is the only Wave 4 composition port for writable
`runtime.db` and `tracker.db`. It acquires a mode-0600 runtime lock before
opening either database, configures foreign keys, WAL, a 2500ms busy timeout,
and `synchronous=FULL`, then exposes explicit transactions and status.

The databases are separate connections and are never attached or committed as
one transaction. A runtime mutation writes its raw deduplicated event,
canonical rows, and `runtime_outbox` row together. Tracker/management work is
subsequently driven from that durable outbox; no API may claim cross-file
atomicity.

Runtime migration `runtime/001-initial` creates the event, identity,
generation, alias, endpoint/fence/capability, command/envelope/ack, cursor,
outbox, diagnostics, and audit tables. Migration definitions are immutable SQL
with source checksums recorded in `golem_migrations`. Before an apply the owner
checks for a newer schema or checksum drift, plans deterministic pending work,
creates a verified `VACUUM INTO` backup, applies inside one transaction, and
records `migration_audit`. `integrity_check` and `foreign_key_check` must pass.

The existing tracker file is inspected without mutation when it has legacy
tables. An explicit `tracker/001-baseline` application adds only Golem
migration/audit metadata and preserves tracker table rows. Fresh tracker files
receive the same baseline automatically. A close checkpoints bounded WAL work,
closes both connections, and removes its lock. The selected J3 journey proves
the owner race, pre/post-commit failpoints, outbox-only cross-store bridge,
checksum/schema/failing-migration refusal, tracker count preservation, backup,
restart, integrity, and temporary-home cleanup.
