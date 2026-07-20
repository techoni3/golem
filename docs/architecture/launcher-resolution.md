# Launcher resolution

`@golem/launcher` owns configuration interpretation and launch planning, not
process creation. Its public boundary takes JSONC text through an injected
read/write port or pure values, then returns an immutable, redacted
`LaunchPlan` or one stable, actionable failure.

## Configuration contract

- Versioned user and project configuration has one strict managed `launch`
  section. Unknown keys outside that section and their surrounding JSONC
  comments remain user-owned and are preserved by a write plan.
- A missing version is read only through the v0 adapter. A write requires an
  explicit `save_launcher_config` intent and a redacted plan. Its injected port
  performs backup → temporary write → atomic commit; interruption rolls back
  from backup and removes the temporary target. A temporary is cleanup-eligible
  before its write await, and rollback/cleanup port failures remain subordinate
  to one redacted public error. Raw text is never exposed by a write plan,
  while comments and unknown user-owned regions remain intact whenever rollback
  remains possible.
- Project configuration may select presets but may not supply a binary
  override. Arguments are argv data, never a shell string, and secret-bearing
  values are rejected before a plan is produced.
- The OpenCode helper writes only a named managed JSONC path, preserving
  unrelated provider, credential, and comment regions. Daily resolution never
  calls it.

## Resolution and qualification

Resolution applies an invoked global/scoped preset, project default, user
default, then built-in default. A model-only explicit value may refine that
preset, but an explicit harness, mode, backend, or delivery change fails closed
with `launcher.override.preset_incompatible`: executable, env-key, and argv
dependencies must never come from an incompatible preset. The resulting plan
keeps harness mode, backend, delivery mode, env-key references, argv intent,
and capability qualification separate. It also returns two immutable facts:
`launch` is the pre-spawn contribution decision, while `delivery` records mode,
qualification, and normalized readiness. A launchable plan may therefore carry
`delivery.readiness` of `not_ready`; delivery evidence never becomes a second
spawn gate. A public model selector must be non-blank and free of
credential/control-looking values before wildcard capability matching.
Capability evidence is keyed by
harness/mode/backend/model pattern/delivery/control features; it includes
source, version, and observation time.
Resolve, list, and doctor all project the same launch and delivery truth.
Registration can never authorize launch at any claimed qualification.
Missing/malformed
observed evidence time or an unrecognized evidence source/policy fails closed;
observed facts age out by policy, while
the built-in compatibility snapshot is deliberately version-qualified and does
not self-expire on a 30-day wall clock. Experimental real evidence is surfaced
as a warning. Claude/Ollama local and cloud plans are launchable but remain
pull-only/not-ready until addressed consumption is proven; they never advertise
push or dispatch. Direct Codex is pull-only/not-ready, managed Codex is
OpenAI/GPT-only, and OpenCode exposes independent GPT, Ollama local, and Ollama
cloud launch contributions without claiming delivery qualification.

Built-ins intentionally use provider/model patterns rather than a current
cloud-model catalogue. Missing binary, credential, invalid configuration, and
unsupported managed combinations remain launch failures before spawn; unknown
delivery is a warning/remediation fact rather than permission to dispatch.

## Evidence seam

One J7 replay, shared by `test:launcher-resolution` and
`launcher-resolution-matrix`, covers the full precedence/conflict matrix and
declaration permutations, non-TTY/unknown values, secret redaction, JSONC
preservation, atomic-write rollback, stale/invalid/version-qualified and
registration-only evidence, unified resolve/list/doctor truth, and distinct
direct/managed/push/pull/next-turn/app-server/readiness/control facts. The
temporary-home `launcher-launchability-delivery-split` journey then exercises
credential and launch-contribution failures, Claude/Ollama, OpenCode, direct
Codex, the immutable `launchPlanBridge`, and resolve/list/doctor parity. The
temporary-home `compact-launch-dry-run-matrix` child invokes the built public
resolver/bridge with an empty credential inventory and verifies stable JSON,
path/credential non-leakage, and sentinel preservation. Neither journey starts
a harness or changes a real home.

## Module layout

`config.ts` owns JSONC and the atomic text port; `presets.ts` owns validated
precedence and duplicate-name policy; `capabilities.ts` owns evidence truth;
`resolve.ts` composes immutable plans and the narrow `launchPlanBridge`;
`explain.ts` owns redacted failures and canonical serialization; `types.ts` is
the shared pure contract; and `index.ts` is a thin public boundary. CLI/API
consumers may use the bridge for the two facts without acquiring spawn or
delivery-transport ownership.
