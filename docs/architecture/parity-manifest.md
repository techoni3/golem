# Legacy parity manifest — v6

`parity-manifest.json` freezes the current, corrected GOL-13 user-visible baseline for the typed-control-plane migration. It is a rollback comparator through GOL-20 C4, not a second runtime authority.

## Scope

- Fifteen confirmed capabilities each have one owner, target owner, user outcome, J1–J8 journey, catastrophic regression, compatibility status, and cutover gate.
- Removed v3 paths and compatibility-only registries are called out separately; they are never silently promoted into replacement parity.
- `test/fixtures/parity/v6/legacy-projections.json` is representative and sanitized. It contains no copied home, tracker, render, credential, or live-database data. The v5 pair remains in history as the rollback comparator.

## Corrected contract facts

The fifteen capability rows are an inventory, not a substitute for the exact
cutover semantics in `corrected_parity_contracts`:

- `POST /api/comments/:cid/dispatch` preserves comment/parent lookup, the
  spec-only guard, assignee-or-fallback target resolution, durable enqueue
  before delivery, subscription-or-direct delivery/error semantics, and
  duplicate/idempotency coverage.
- `POST /api/tickets/:id/unacked/:deliveryEventId/dismiss` preserves the human
  dashboard actor default, durable settlement, all three invalidations
  (`ticket-updated`, `native-sessions-update`, and
  `communication-health-updated`), and REST/WebSocket/health requery.
- Managed Codex is owned jointly by the supervisor, TUI bridge, and
  `lib/codex-app-server-contract.js`. The installed `codex-cli` 0.144.5
  contract is fail-closed before spawn on its 30-leaf fingerprint
  `8fea722bf38d19e54265e4650f36e9329bac40d334c1c287d12bb6d21c8eac71`.
- OpenCode’s managed path is outside the source checkout: the rendered
  checkout owns `mcp/channel/index.js`, its `NODE_PATH`, and the file URL shim.
  Install, update, and uninstall must leave no stale source path or duplicate
  plugin entry.
- Launcher compatibility includes `golem -h`/`--help` and the scoped help
  aliases. `golemx` remains truthful: `unsupported_custom_base_url` is
  ineligible and never a readiness claim.

## Normalization and comparison

`test/parity/normalization.mjs` is the only normalization contract for this baseline. It redacts credentials and maps timestamps, PIDs, ports, absolute paths, and UUID randomness to stable placeholders. It sorts object keys and declared unordered collections only. It deliberately preserves identifier equality, lifecycle, delivery mode, readiness, and semantic sequence/queue order.

Future vertical slices compare their legacy and replacement projections through `compareParityProjection`; a readiness change such as `pull_only` to `ready` remains a mismatch.

## Baseline command

```bash
npm run test:legacy-baseline
npm run test:legacy-baseline -- --list
```

The runner creates a temporary `GOLEM_HOME`, constructs every child environment
from an explicit safe allow-list (rather than copying `process.env`), validates
manifest/fixture stability, then invokes the real-boundary journeys selected for
this freeze:

| Scenario | Journey | Existing seam | Regression protected |
| --- | --- | --- | --- |
| render and discovery | J1 | `test/sync-enforcement.test.mjs` | generated render or temporary-home discovery drift |
| session facts | J2 | `test/session-facts.test.mjs` | resumed identity, lease expiry, malformed registry safety |
| local control boundary | J4 | `test/parity/local-control-boundary.mjs` | credential-free local dashboard/SQLite/REST/WebSocket/MCP dispatch and ownership |

The J4 source starts only a temporary dashboard and a temporary stdio MCP
channel; it imports no Codex supervisor, starts no managed readiness turn, and
configures no model-provider endpoint or credential. Its children inherit no
provider/configuration variables, including OpenAI, Codex, Anthropic, Azure,
Google/Vertex, or AWS credentials. Startup and timeout failures include bounded,
current child stderr rather than a stale interpolation.

The command never updates fixtures. A source/platform boundary that cannot run
is a failing, named adoption gate; it is never converted into a skip or pass. In
particular, a sandbox that rejects loopback listeners makes the J4 process
boundary fail with `EPERM`, while preserving the runner's other evidence.

## Fixture updates and rollback

Any fixture or manifest update requires a new manifest version plus an explicit compatibility reason in both the commit and tracker evidence. Rollback uses the previous committed manifest/fixture pair; no user state is restored, overwritten, or copied by this baseline. v6’s compatibility reason is the focused GOL-24 repair recorded in the manifest; rollback is the committed v5 pair and prior runner.
