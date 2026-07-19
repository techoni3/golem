# Legacy parity manifest — v5

`parity-manifest.json` freezes the current, corrected GOL-13 user-visible baseline for the typed-control-plane migration. It is a rollback comparator through GOL-20 C4, not a second runtime authority.

## Scope

- Fifteen confirmed capabilities each have one owner, target owner, user outcome, J1–J8 journey, catastrophic regression, compatibility status, and cutover gate.
- Removed v3 paths and compatibility-only registries are called out separately; they are never silently promoted into replacement parity.
- `test/fixtures/parity/v5/legacy-projections.json` is representative and sanitized. It contains no copied home, tracker, render, credential, or live-database data.

## Normalization and comparison

`test/parity/normalization.mjs` is the only normalization contract for this baseline. It redacts credentials and maps timestamps, PIDs, ports, absolute paths, and UUID randomness to stable placeholders. It sorts object keys and declared unordered collections only. It deliberately preserves identifier equality, lifecycle, delivery mode, readiness, and semantic sequence/queue order.

Future vertical slices compare their legacy and replacement projections through `compareParityProjection`; a readiness change such as `pull_only` to `ready` remains a mismatch.

## Baseline command

```bash
npm run test:legacy-baseline
npm run test:legacy-baseline -- --list
```

The runner creates a temporary `GOLEM_HOME`, validates manifest/fixture stability, then invokes the existing real-boundary journeys selected for this freeze:

| Scenario | Journey | Existing seam | Regression protected |
| --- | --- | --- | --- |
| render and discovery | J1 | `test/sync-enforcement.test.mjs` | generated render or temporary-home discovery drift |
| session facts | J2 | `test/session-facts.test.mjs` | resumed identity, lease expiry, malformed registry safety |
| cross-harness delivery | J4 | `test/cross-harness-matrix.test.mjs` | dashboard/SQLite/MCP readiness and delivery ownership |

The command never updates fixtures. A source/platform boundary that cannot run is a failing, named adoption gate; it is never converted into a skip or pass. In particular, a sandbox that rejects loopback listeners makes the J4 process boundary fail with `EPERM`, while preserving the runner's other evidence.

## Fixture updates and rollback

Any fixture or manifest update requires a new manifest version plus an explicit compatibility reason in both the commit and tracker evidence. Rollback uses the previous committed manifest/fixture pair; no user state is restored, overwritten, or copied by this baseline.
