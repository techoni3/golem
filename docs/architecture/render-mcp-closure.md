# Reproducible render and MCP closure

`@golem/compiler` turns the legacy cc, cc-marketplace, Codex, OpenCode, and Pi
plans into a sorted, versioned `golem.render-manifest/v1`. Its lock records
content hashes, file modes, source provenance, and managed-region markers. A
checkout path is diagnostic metadata, not hash input, so relocation cannot drift
the compiled bytes.
Compilation writes to a sibling stage, refuses a changed tracked target, and
swaps only after the stage is complete; an injected staged failure restores the
prior target.

`@golem/mcp-adapter` is deliberately narrow. It validates public MCP inputs,
then delegates through an injected `@golem/api-client` boundary. The bundled
`dist/golem-mcp.mjs` contains the MCP SDK and schema runtime while leaving only
Node built-ins external. It does not own tracker/domain/reconciliation or a DB.

`test/render-mcp-closure.mjs` is the single J1 render journey. It compiles all
five target manifests twice, checks equal hashes, proves tamper refusal and
staged rollback, then copies only the artifact into a temporary render and
exercises initialize/list/read/invalid-write/shutdown against a real HTTP seam.
Loopback `EPERM` is recorded as `UNMET`, never converted into a pass.

The legacy `mcp/channel` install and postinstall remain until this copied-artifact
journey passes in an authorized loopback environment and the complete public
tool/API compatibility audit is accepted. `plugin/` and live renders remain
generated outputs; neither is hand edited by this compiler.
