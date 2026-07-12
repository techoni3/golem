# Codex support matrix

Validated against the official OpenAI Codex Hooks, Build plugins, MCP, and
AGENTS.md documentation on 2026-07-13 and native `codex-cli 0.144.1`.

| Capability | Support |
|---|---|
| Skills / AGENTS.md | Native |
| Plugin manifest / marketplace | Native |
| STDIO MCP | Native |
| Session, prompt, tool pre/post, compaction, subagent-stop, stop facts | Native documented hooks |
| Hook trust | User must review non-managed hooks with `/hooks` |
| Dispatch delivery | Tier B: pull or next real turn only |
| Live push into an ordinary CLI turn | **Not supported / never reported delivered** |
| App Server | Deferred compatibility spike |

The adapter relies only on documented hook inputs. In particular it does not
parse `transcript_path`, whose format OpenAI explicitly says is unstable. The
supported events are `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStop`, and `Stop`.
