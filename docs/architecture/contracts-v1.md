# Contracts v1

`@golem/contracts` is the only source of JSON-representable v1 wire data for
the control plane. It owns Zod 4 validation, inferred TypeScript types, stable
JSON Schema snapshots, and compatibility fixtures. Domain, storage, API,
adapter, launcher, UI, and compatibility tickets import it rather than
redeclaring DTOs.

## Version and identity rules

- Every registry entry has a stable `urn:golem:contracts:<name>:v1` schema id,
  a `golem.<name>/v1` wire discriminator, and semantic version `1.0.0`.
  Semantic versioning is independent from the wire major.
- Canonical project, location, logical-session, generation, event, command,
  endpoint, producer, actor, delivery, operation, and migration ids are opaque
  prefixed UUID strings. Paths, names, PIDs, and native ids remain data, never
  canonical identity.
- Canonical schemas are strict. An unsupported major produces the stable
  `wire.version.unknown_major` issue. The sole additive-field boundary is
  `CompatibilityIngressV1Schema`, used by future explicit legacy import
  adapters; it must never become a canonical signal or config reader.

## Wire invariants

- Runtime signals carry event/dedup keys, producer instance, clocks,
  provenance, explicit clears, and matching event/payload discriminators.
  Commands carry command/idempotency keys, actor, audit metadata, target/fence
  expectations where applicable, and matching command/payload discriminators.
  A typed command outcome (`api-command-outcome/v1`) carries one of
  `accepted`, `completed`, `rejected`, `conflict`, `pending`, or
  `idempotency_mismatch`; the `CommandGateway` persists each terminal outcome
  as a `command-receipt/v1` row so a restart-safe replay returns the original
  without re-running any side effect, and a reused idempotency key with a
  differing payload returns `409 command.idempotency_mismatch`.
- Session-control commands are discriminated: interrupt, halt, and resume have
  no untyped input; rename requires a name; role changes require a normalized
  role value; and metadata mutations carry separate JSON `patch` and explicit
  `clear_fields` sets that cannot overlap or both be empty. Preset upserts use
  the canonical launcher-preset body and its name must match the command key.
- Clock facts distinguish source event, observation, receipt, and materialized
  time. Invalid ordering has stable `wire.clock.*` diagnostics. Alias sessions
  cannot cross project scope.
- Endpoint/capability facts keep route health, delivery mode, readiness, and
  qualification separate. WebSocket frames require instance id, sequence,
  resource revision, and snapshot/opaque-delta/resync variants; resync includes
  `policy_changed` alongside cursor/instance reasons.
- Launcher config and presets are strict and carry only safe arguments and
  environment-key references. Sensitive option names fail in both inline and
  split argv forms with field paths; unknown managed fields fail too. No schema
  uses transforms, `Date`, `Map`, `Set`, functions, bigint, or another non-JSON
  value.

## Generated artifacts

Run from the repository root on Node 24:

```sh
npm run contracts:generate
npm run contracts:check
npm run test:contracts
```

`packages/contracts/generated/json-schema/` is generated ownership. The
generator canonicalizes object-key order, emits every registry schema plus an
index and positive/negative compatibility fixtures, and rejects output drift.
Changing a v1 shape requires a contract ticket, regenerated output, and a
compatibility decision; it is not an opportunistic API change.
