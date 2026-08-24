---
name: transcript-workflow-review
description: Discover approved AI-transcript sources across Claude Code, Codex, Pi, and other harnesses, then review them for evidence-backed workflow improvements. Use for retrospectives, including cross-project or cross-harness discovery and comparison, or for instruction and tool-design analysis on an already-selected corpus. Never assess personality, health, intelligence, or general performance.
---
<!-- GENERATED: skills/transcript-workflow-review/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Transcript workflow review

Find useful changes to the interaction system around the human. Select the corpus when the human did
not supply one, then report what the transcripts support, what remains uncertain, and which changes
need human approval.

## Scope

- Use only transcripts and locations the human supplied or authorized. A store listed below is a
  candidate until approved; do not silently crawl a readable path.
- Establish the review question, source roots, time or session range, exclusions, and desired output.
  Default the window to the last three days unless the human sets another. Ask only for missing
  information that materially changes the review.
- State what you included and excluded.
- Keep the review about workflows, instructions, tools, and constraints. Do not assess personality,
  motives, health, intelligence, or general performance.

## Discover and inventory sources

Inventory before close-reading:

1. Confirm the review window, timezone, approved source roots, projects, harnesses, exclusions, and
   output.
2. Count streams with `rg --files` or `find`. Group them by source, project, harness, date, and
   main/sub-agent status with `jq` or a small streaming query. Do not load a large corpus wholesale
   into context.
3. Treat these as candidate sources that still require approval:

| Harness | Store | Notes |
|---|---|---|
| Claude Code | `~/.claude/projects/<munged-cwd>/*.jsonl` | one file per session; sub-agent transcripts sit alongside their parent |
| Codex | `~/.codex/sessions/**/*.jsonl` | rollout files |
| Pi | `~/.pi/agent/sessions/--<cwd-with-dashes>--/<timestamp>_<session-id>.jsonl` | directory name encodes the project cwd; the header repeats it |
| Other | any store the human names | treat the schema as unknown until inspected |

Keep memory Markdown, file-history snapshots, and standalone tool-result directories out unless
separately authorized.

## Normalize each harness

Normalize only enough to compare sources.

**Claude Code** — read top-level `user` and `assistant` records; text, `tool_use`, `tool_result`,
and thinking blocks. Sub-agent sessions live in sidechain files linked by parent `tool_use` id.

**Codex** — read `session_meta`, `event_msg` user and agent messages, and `response_item` messages
or reasoning. Use `session_meta.payload.cwd` as the project hint.

**Pi** — first-class source:
- Files sit at `~/.pi/agent/sessions/--<cwd-with-dashes>--/<timestamp>_<session-id>.jsonl`; the
  directory name encodes the working directory, and the first line is a session header carrying
  `cwd` and the session id.
- Each following line is a tree entry with `id` and `parentId`. A `message` entry carries role
  `user`, `assistant`, `toolResult`, `bashExecution`, or `custom`.
- Assistant messages contain text, thinking, and `toolCall` blocks; `toolResult` entries carry
  `toolName`, content, and `isError`.
- Sessions are trees, not linear logs. Walk `parentId` from the current leaf for the active path;
  abandoned branches are evidence of rework or dead ends, not noise. `compaction` and
  `branch_summary` entries mark summarized history.

For unknown formats, label them unknown and inspect their schema before interpreting content. Keep
stable local session aliases in working notes; use dates and paraphrases in the report.

## Review method

1. Identify substantive sessions that address the review question.
2. Record observable events: the request, supplied context, corrections, tool behavior, outcome,
   and unresolved work.
3. Compare sessions, projects, and harnesses. Look for repeated patterns, useful counterexamples,
   and other explanations.
4. Classify the likely source of each finding.
5. Promote a finding only when it is recurring, high impact, or a clear serious incident. Mark weak
   evidence and uncertainty plainly.

| Classification | Use when |
|---|---|
| Preference | The human consistently asks for or corrects toward a specific interaction style. |
| Agent or instruction failure | The agent ignores, misreads, invents, over-scopes, or acts without authority. |
| Tool failure | A tool, hook, integration, or harness prevents the intended action. |
| External constraint | A service, credential, environment, or policy causes the limitation. |
| Mixed or unknown | Evidence supports several causes or cannot distinguish them. |

A correction from the human is strong evidence that something went wrong. It is not automatically a
stable preference. Classify the cause before proposing a permanent rule.

## Retrospective lenses

When the review is a broad retrospective rather than one specific question, look specifically for:

- repeated requests to explain simply, add context, answer the actual question, shorten a recap,
  preserve a constraint, or stop using unexplained internal labels;
- repeated tool or command retries, permission-question loops, review cycles, phase or role
  re-entry, handoff ping-pong, duplicate work, and repeated undo or re-scope;
- explicit frustration, corrections, abandoned directions, manual cleanup, rollback, and work that
  diverged from the expected direction; do not infer emotion from terse language alone;
- context loss, premature action, excessive narration, weak verification, delegation mismatch,
  reviewer loops, and poor recovery;
- golem/MCP failures, wrong project or cwd, permissions, truncation, stale tickets, unavailable
  channels, manual JSON or shell bypasses, and harness limits that prompting cannot fix.

Separate preference, agent failure, tooling failure, and external constraint, and look for
counterexamples before promoting a pattern.

## Report

Adapt the report to the question and corpus. For each important finding, give:

- the observable pattern
- session identifiers or dates and a concise paraphrase of the evidence
- the classification and relevant alternative explanation
- confidence or uncertainty in plain language
- the practical consequence
- the smallest useful change, if the evidence supports one

Include working patterns, unpromoted observations, or open questions only when they help the human
decide. Prefer a small set of promoted findings over long lists; do not pad to reach a fixed count.
Use short quotations only when the exact wording matters. After presenting the report, ask once
which candidates to adopt, test, or discard.

## Boundaries

- Work read-only. Never upload, publish, or retain raw transcript content outside the authorized
  location. Redact secrets, credentials, private paths, and sensitive personal or health
  information.
- Do not put long quotations or raw tool output in the report.
- Consider instruction failure, agent failure, tool limits, and missing constraints before calling
  a problem a prompting issue.
- Do not invent time saved, productivity measures, costs, or causal claims.
- Propose durable changes as candidates. Do not edit instructions, skills, hooks, configuration,
  memory, tracker state, or project files until the human explicitly approves that change.
- Before an approved durable edit, check for an existing owner, duplicate rule, or conflict. Put
  the change in the narrowest source that fits its scope. For adopted changes, record scope,
  evidence, review date, and retirement condition.
