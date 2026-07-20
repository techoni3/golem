# Reproducible render and MCP closure

`@golem/compiler` turns the legacy cc, cc-marketplace, Codex, OpenCode, and Pi
plans into a sorted, versioned `golem.render-manifest/v1`. Its lock records
content hashes, file modes, source provenance, and managed-region markers. A
checkout path is diagnostic metadata, not hash input, so relocation cannot drift
the compiled bytes.
Compilation writes to a sibling stage, refuses changed, malformed-lock, and
unmanaged targets unless the owner explicitly passes `--force`, and swaps only
after the stage is complete. Force keeps unowned sibling bytes while replacing
managed files into a valid lock. The durable swap marker recovers an interrupted
prior target; managed hashes cover canonical framed marker bytes.

`@golem/mcp-adapter` is deliberately narrow. It validates the retained public
tool inputs, then delegates through an injected `@golem/api-client` boundary
with trusted caller context. The bundled `dist/golem-mcp.mjs` contains the MCP
SDK and schema runtime while leaving only Node built-ins external. It does not
own tracker/domain/reconciliation or a DB.

`test/render-mcp-closure.mjs` is the single J1 render journey. It compiles all
five target manifests twice, checks equal hashes, lock refusal/force recovery,
and staged rollback. From the packed install it starts the current rendered
legacy channel and verifies its temporary registration and health route. It
then copies only the artifact into a separate temporary render and exercises
initialize/list/read/invalid-write/real-write/shutdown against a real HTTP
seam. Loopback `EPERM` is recorded as `UNMET`, never converted into a pass.

The legacy `mcp/channel` entrypoint, nested lock, postinstall, and rendered
dependency closure remain the current install path. The artifact is generated
and independently verified beside it, but it is not selected by `.mcp.json`.
GOL-29 excludes the later lifecycle-adapter transport that must prove channel
registration, delivery, and uncorrelated reply parity before cutover. `plugin/`
and live renders remain generated outputs; neither is hand edited.
