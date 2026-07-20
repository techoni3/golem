# Domain kernel

`@golem/domain` is the deterministic policy boundary between validated
`RuntimeSignalV1` facts and later persistence/control-plane materializers. It
accepts only prior `DomainState`, one signal, and an explicit
`ReducerClock.materializedAt`; it returns the next immutable state plus a
structured `DomainEffect`. Its exported `domainBoundary` is the typed runtime
and tracker seam. It does not read a clock, filesystem, process, network,
database, or harness.

## Policy owned here

- Projects retain one stable project ID while each main/worktree/legacy
  location remains a separate location record.
- A logical session owns deterministically ordered generations. Lifecycle is a
  commutative semantic join: `starting → operational → ending → terminal`
  stage/rank wins before source time, operational states may interleave, and
  same-stage facts use stable provenance. `ended`, `errored`, and
  `superseded` therefore converge deterministically without resurrection.
  A resume starts a new generation; its later fact supersedes an older terminal
  classification without resurrecting the old generation. Duplicate generation
  creation is also provenance-selected, returns review, and cannot choose an
  owner or metadata based on receipt order.
- Event IDs and producer watermarks provide duplicate/sequence protection.
  Metadata, lifecycle/activity, project-location, capability, and endpoint
  facts carry provenance ordered by source time then a stable event/producer
  tie break. Revision/fence remains the stronger endpoint authority.
  Receipt/materialization time never wins, so delayed producers cannot roll
  back a value, recreate a cleared field, or overwrite a newer fact.
- Native aliases are scoped by project, harness, kind, optional producer, and
  value. A conflicting session produces `domain.alias.ambiguous` for review,
  never an automatic merge; the retained candidate is a stable session-ID tie
  only so replay order cannot choose the apparent owner.
- Endpoint revisions and owner fences protect endpoint heartbeat/release. They
  do not update the actor's activity clock.
- Capability qualification, delivery mode, and readiness stay separate;
  pull and next-turn delivery are explicitly qualified rather than inferred as
  a generic online state.
- Live, history, and diagnostics are distinct projections. Every exclusion or
  decision carries a stable `domain.*` explanation code.

## Evidence seam

`test/domain/replay.mjs` is one compact J2 replay table shared by
`npm run test:domain` and the root journey scenario `domain-replay`. It covers
all four harness origins, project locations, alias ambiguity, lifecycle ranks,
and byte-equivalent final state/projections for cross-producer metadata/clears,
project locations, lifecycle activity, terminal/idle joins, terminal conflicts,
duplicate-generation creation, capabilities, same-sequence ties,
terminal/resume/supersede, and endpoint revision/fence/heartbeat/release facts.
It also covers separated clocks and history/live membership.
The package's import boundary is enforced by `npm run check:boundaries`.

## Module layout

`index.ts` exports the public `domainBoundary` only. `types.ts` owns immutable
facts; `identity.ts`, `lifecycle.ts`, and `ordering.ts` own the three core
policies; `capabilities.ts` and `readiness.ts` own boundary qualification;
`projections.ts` and `explain.ts` produce read models and stable explanations;
and `reducer.ts` composes them without I/O.
