# Agentic Coding: The Canonical Reading List (June 2026)

*A skeptical, recency-weighted survey of the methodologies, frameworks, plugins, and philosophies the community is actually using. Compiled 2026-06-12 (research agent, live-API-verified star counts). Ranked by current traction × idea-quality, with explicit "historical" tags on anything that peaked in 2025 and stalled.*

The single most useful framing before the list: **2026 is the year the field stopped worshipping the model and started engineering the harness.** The model is a commodity; the scaffolding around it (context policy, verification gates, memory, orchestration, the loop) is where the engineering moved. Almost every top contender below is one specific answer to *"how do I build a good harness?"*

---

## THE TOP CONTENDERS (ranked)

### 1. Anthropic's engineering corpus + the harness-engineering synthesis — *the canon everyone builds on*

**What it is.** A cluster of Anthropic engineering posts that function as the de-facto official reading list. The load-bearing posts: *Building effective agents* (Dec 2024, the "workflows vs. agents" distinction), *Multi-agent research system* (2025), *Effective context engineering for AI agents* (Sep 29 2025), *Code execution with MCP* (Nov 4 2025, ~99% token cut), *Effective harnesses for long-running agents* (Nov 26 2025, the two-agent/feature-list/init-then-code pattern), and the *Claude Code best practices* doc (Explore→Plan→Code→Commit).

**Core philosophy/mechanism.**
- *Workflows by default, agents only when needed* — ~90% of shipping "AI systems" are deterministic workflows with strategic LLM calls.
- *Context is a finite attention budget* — curate and defend the window via compaction, structured note-taking, just-in-time retrieval, subagent isolation.
- *The ratchet* (the community's distillation): when the agent makes a mistake, engineer a permanent fix (a convention, a hook, a gate) so it can never make that mistake again.

**Traction.** The substrate everyone cites; mainstreamed early 2026 by Birgitta Böckeler (martinfowler.com), Addy Osmani (["Agent Harness Engineering," Apr 19 2026](https://addyosmani.com/blog/agent-harness-engineering/)), and OpenAI's engineering blog.
**Worth stealing.** *The ratchet* — encode every failure as a permanent guardrail. The unifying move behind skills, hooks, CLAUDE.md, and compound engineering.
**Criticism.** Vendor-authored and tuned to Claude's strengths; "harness engineering" risks becoming a consultancy buzzword.
**URLs.** https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents · https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents · https://www.anthropic.com/engineering/building-effective-agents · https://www.anthropic.com/engineering/code-execution-with-mcp · https://code.claude.com/docs/en/best-practices

### 2. superpowers (obra / Jesse Vincent) — *the breakout: methodology-as-skills*

**What it is.** An agentic-skills framework *and* opinionated dev methodology shipped as plain-markdown skills that force the agent through: **Brainstorm → Plan → Implement (strict TDD) → adversarial Review → Finish.** Started as a Claude Code plugin (Oct 9 2025), now multi-harness, accepted into Anthropic's official marketplace Jan 15 2026.

**Core philosophy/mechanism.**
- *Skills as mandatory workflows, not suggestions* — the agent checks for a relevant skill before any task and is coerced into using it.
- *Subagent-driven development* — plans decompose into 2–5-minute tasks, each run by a *fresh-context subagent*, then two-stage adversarial review (spec compliance, then code quality).
- *Self-improvement* — a "writing-skills" skill teaches the agent to author and test its own skills against subagents.

**Traction.** ~225k stars / 20k forks (live API 2026-06-12), v5.1.0 (May 4 2026), one of the fastest-growing OSS repos of 2026. Endorsed early by [Simon Willison](https://simonwillison.net/2025/Oct/10/superpowers/).
**Worth stealing.** *Fresh-context subagent per atomic task + two-stage adversarial self-review* — the most-copied pattern in the ecosystem. Also the brainstorming gate.
**Criticism.** Ceremony doesn't scale *down* — full brainstorm/plan/review fires on two-line fixes; HN skeptics report more mistakes under the added ceremony.
**URLs.** https://github.com/obra/superpowers · https://blog.fsck.com/2025/10/09/superpowers/ · https://blog.fsck.com/2026/03/09/superpowers-5/

### 3. Beads + Gas Town (Steve Yegge) — *external graph memory + the agent factory*

**What it is.** **Beads** (`bd`): a local-first, git-backed *graph issue-tracker as external memory for agents* (`bd ready` surfaces unblocked work). **Gas Town**: the Go orchestrator running 20–30 parallel Claude Code instances (Overseer → Mayor → ephemeral Polecat workers in worktrees, Refinery merge queue, Witness/Deacon/Dogs health daemons).

**Core philosophy/mechanism.**
- *External structured memory beats context-window memory* — solves inter-session amnesia; hash-based IDs give conflict-free concurrent edits; closed tasks compact ("memory decay").
- *Agent-as-bead* — persistent identity, inbox, recoverable work-hooks; resumes after crash.
- *Orchestration over autonomy* — a coordinator decomposes and delegates with liveness supervision built in.

**Traction.** Beads ~24.5k stars, v1.0.4 (May 9 2026), pushed 2026-06-12, 9,200+ commits. Gas Town ~15.9k stars, v1.2.1 (Jun 6 2026). [SE Daily (Feb 12 2026)](https://softwareengineeringdaily.com/2026/02/12/gas-town-beads-and-the-rise-of-agentic-development-with-steve-yegge/) · [Cloud Native Now](https://cloudnativenow.com/features/gas-town-what-kubernetes-for-ai-coding-agents-actually-looks-like/) · [DoltHub](https://www.dolthub.com/blog/2026-01-15-a-day-in-gas-town/).
**Worth stealing.** *Dependency-aware, git-mergeable graph as agent memory* + *agent liveness/health supervision* (most orchestrators spawn agents but never watch for stuck ones).
**Criticism.** 7-role ceremony only pays at 12–30 concurrent agents; beads' substrate is a real operational dependency; Yegge himself says it's not consumer-ready.

### 4. The Ralph Loop / "loop engineering" (Geoffrey Huntley) — *the brute-force philosophy that won*

**What it is.** A technique, now a first-class primitive: run the *same* prompt against a coding agent in an infinite loop (`while :; do cat PROMPT.md | <agent>; done`), feeding its own errors back until the software converges. Used to build "CURSED" (a language with zero training data) over ~3 months.

**Core philosophy/mechanism.**
- *Fresh context window per atomic task* — beat context rot with fresh starts; git/files are the memory layer.
- *Failures as backpressure* — each loop confronts its own mess until convergence; declarative specs over imperative instructions.
- *Cheap models in a tight loop beat one expensive careful pass* — tune the prompt, not the code.

**Traction.** [ghuntley.com/ralph](https://ghuntley.com/ralph/) (Jul 2025) went viral; **Anthropic shipped an official Ralph Wiggum plugin (Dec 2025)**; **OpenAI's Codex CLI added `/goal` (Apr 30 2026) — Ralph as a primitive**. [HumanLayer "A Brief History of Ralph"](https://www.humanlayer.dev/blog/brief-history-of-ralph) · [awesome-ralph](https://github.com/snwfdhmp/awesome-ralph). Peter Steinberger's "design loops that prompt your agents" (Jun 8 2026, 6.5M views) extended it into "loop engineering".
**Worth stealing.** *Git/files as durable memory + same-prompt-on-loop with failures as backpressure*; design assuming this loop exists underneath.
**Criticism.** Burns enormous tokens re-deriving; documented wins are greenfield/porting with strong test backpressure. Even Huntley now says "run once overnight via cron and merge small."

### 5. GitHub Spec Kit + the spec-driven-development movement — *the structured-planning category leader*

**What it is.** GitHub's toolkit operationalizing **Spec-Driven Development**: **Constitution → Specify → Plan → Tasks → Implement**, each phase emitting a markdown artifact feeding the next. Agent-agnostic (30+ agents).

**Core philosophy/mechanism.**
- *Intent is the source of truth; code is the last-mile output.*
- *A "constitution"* of durable project principles constrains every spec and plan.
- *Phase-gated artifacts* give the agent structured context instead of ad-hoc chat.

**Traction.** ~90–112k stars, 10 releases in 10 days in early June 2026 (v0.10.2 Jun 11 2026); ThoughtWorks Radar Vol. 34. Siblings: **OpenSpec** (~44–54k, brownfield-first, *delta specs* = best idea in category), **BMAD-METHOD** (~49k, v6.8.0, simulates a 12-persona agile team), **AWS Kiro** (GA May 7 2026, EARS-notation requirements + agent hooks).
**Worth stealing.** Phase→artifact→handoff with a persistent constitution; OpenSpec's *delta specs* (ADDED/MODIFIED/REMOVED) for brownfield drift; Kiro's EARS testable-requirement grammar.
**Criticism.** Heaviest ceremony of the open options; real backlash — "spec-driven is waterfall in markdown"; specs go stale while agents follow them confidently.
**URLs.** https://github.com/github/spec-kit · https://github.com/Fission-AI/OpenSpec · https://github.com/bmad-code-org/BMAD-METHOD · https://kiro.dev/

### 6. 12-Factor Agents (Dex Horthy / HumanLayer) — *the production-engineering manifesto*

**What it is.** A Heroku-style manifesto: agents that ship are *mostly deterministic software with LLM calls at key decision points* — not autonomous loops. Twelve principles for keeping control of what frameworks hide.

**Core philosophy/mechanism.**
- *Own your prompts, own your context window, own your control flow.*
- *Agent as stateless reducer*; small focused agents beat one mega-agent; "contact a human" is a first-class tool call.
- The naive agent loop is insufficient for production — wrap it in deterministic code.

**Traction.** ~19.8–23k stars; among the most-cited references; the [AI Engineer World's Fair keynote](https://www.youtube.com/watch?v=8kMaTybvDUw) widely reshared. "The model gets dumb in the middle 40–60% of a big context window" (from 100k+ sessions) is a quoted line.
**Worth stealing.** Factors 3/8/10/12 (own context window / own control flow / small focused agents / stateless reducer) — they map directly onto subagent and skill design.
**Criticism.** A patterns *catalog*, not a method; some factors are framework-rejection ideology that softened as Claude Code/Codex became the de-facto framework.
**URLs.** https://github.com/humanlayer/12-factor-agents

### 7. Context Engineering & "Context Rot" (Anthropic + Chroma) — *the load-bearing mental model*

**What it is.** The discipline that displaced prompt engineering: what configuration of tokens is in the window at inference time. Empirical backbone: **"context rot"** — accuracy degrades measurably as input grows, even on trivial tasks.

**Core philosophy/mechanism.**
- *Context is a finite resource with a limited attention budget* — you always get better results using fewer tokens.
- Techniques: compaction, structured note-taking (memory outside the window), just-in-time retrieval, subagents returning short summaries.
- The window is something to *curate and defend*, not *fill*.

**Traction.** Coined by an HN commenter (Jun 2025), formalized by [Chroma's "Context Rot"](https://www.trychroma.com/research/context-rot) (Jul 2025, 18 models), systematized by Drew Breunig and Anthropic's [context-engineering post](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
**Worth stealing.** The *finite attention budget* framing — reframes every design choice as budget allocation. The most load-bearing mental model in the field.
**Criticism.** Risks becoming a thought-terminating cliché; the Chroma result is about recall tasks and gets overgeneralized.

### 8. Agent Skills (SKILL.md) + the official plugin/marketplace ecosystem — *progressive disclosure as a primitive*

**What it is.** Anthropic's open `SKILL.md` format plus **plugins** (skills/subagents/commands/hooks/MCP/LSP bundled) distributed via **marketplaces**. Official directory `anthropics/claude-plugins-official` (~30k stars, ~55 plugins); `anthropics/skills` ~149.6k stars.

**Core philosophy/mechanism.**
- *Progressive disclosure* (3 stages) — only name+description at startup; full SKILL.md on match; scripts on execution.
- *Six-primitive model:* MCP connects / Skills teach / Subagents delegate / Hooks enforce / Commands trigger / Plugins package.
- *Marketplace = git repo + manifest*, curation as an optional trust layer.

**Traction.** Skills launched Oct 16 2025; Willison: ["a bigger deal than MCP"](https://simonwillison.net/2025/Oct/16/claude-skills/); format adopted within weeks by OpenAI, Google, GitHub, Cursor. Subagent collections: [wshobson/agents](https://github.com/wshobson/agents) ~36.6k, [VoltAgent](https://github.com/VoltAgent/awesome-claude-code-subagents) ~21.6k.
**Worth stealing.** *Progressive disclosure* — the single most reusable context-engineering idea. Plus description-driven auto-routing + per-agent tool-scoping.
**Criticism.** The **"context tax"** — every idle skill/plugin/MCP costs tokens every turn (five idle plugins ≈ 55k tokens); Anthropic's own guidance caps a healthy setup at ~8–12 skills. Plugins are an arbitrary-code supply chain.

### 9. Compound Engineering (Kieran Klaassen & Dan Shipper / Every.to) — *the self-improving harness, branded*

**What it is.** Each unit of work makes the next easier — inverting codebase entropy. **Plan → Work → Review → Compound**: the human reviews the output *and the lessons*, then feeds lessons back into CLAUDE.md/skills/hooks.

**Traction.** ["The Definitive Guide"](https://every.to/source-code/compound-engineering-the-definitive-guide) (Feb 9 2026), companion repo ~7k stars, "ship like a team of 15" podcast.
**Worth stealing.** The *explicit Compound step* — the ratchet as a named, mandatory phase rather than an aspiration.
**Criticism.** Underlying primitives are decades-old SWE; novelty is mostly framing; compounding-gains claims anecdotal.

### 10. The parallel-agents / worktree-orchestration tool tier — *the GUI/manager layer (high churn)*

**What it is.** Tools running multiple agents concurrently in isolated git worktrees with visual review/merge: **Conductor.build** (YC, closed-source, v0.64 Jun 9 2026, the Mac GUI leader), **vibe-kanban** (~27k stars — *parent company Bloop AI shut down Apr 10 2026; repo ~7 weeks stale*), **Claude Squad** (~7.8k), **CCPM** (~7–8k, GitHub-Issues-as-spine). Note: **Claude Code shipped native Agent Teams + worktrees**, commoditizing the wrapper tier.

**Worth stealing.** *Diff-first review as the human-oversight primitive*; *the board/tracker exposed as an MCP server*; peer-to-peer teammate messaging where topology genuinely needs it.
**Criticism.** Highest-churn category; building another "spawn N sessions" wrapper is a losing bet. The real bottleneck is *human review*, not agent throughput.

### 11. Memory systems — claude-mem and the "do you even need it" counter-current

**What it is.** **claude-mem** (thedotmack): five lifecycle hooks capture everything, AI-compress into semantic summaries (SQLite+FTS5 + Chroma), inject at session start; 3-layer index→timeline→detail retrieval claiming ~10x token savings.

**Traction.** ~81.9k stars (live), v13.5.6 (Jun 11 2026), 250+ releases in 9 months. *Crucial:* Claude Code shipped built-in automatic memory (v2.1.59, Feb 2026), prompting "do you still need it?" comparisons.
**Worth stealing.** *Capture→compress→inject + filter-before-fetch* — the reusable memory pattern for any harness.
**Criticism.** Weakest real consensus in this list: stars measure FOMO; severe token-burn complaints; native memory + "markdown files + git" narrowed the moat. Expert consensus: **the best memory system is a well-maintained markdown file + git history.**

---

## (a) READ THESE FIRST — the 5-item shortlist

1. **Anthropic — "Effective context engineering for AI agents"** (Sep 29 2025). The field's core mental model. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
2. **Anthropic — "Effective harnesses for long-running agents"** (Nov 26 2025). The closest thing to a blueprint for a custom orchestration layer. https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
3. **HumanLayer — "12-Factor Agents."** Production-engineering invariants for any orchestration layer. https://github.com/humanlayer/12-factor-agents
4. **Geoffrey Huntley — "Ralph Wiggum as a software engineer"** + **"everything is a ralph loop."** https://ghuntley.com/ralph/ · https://ghuntley.com/loop/
5. **obra — superpowers** (repo + [launch essay](https://blog.fsck.com/2025/10/09/superpowers/)). Methodology-as-skills with fresh-context dispatch and adversarial self-review. https://github.com/obra/superpowers

*Honorable mentions:* Yegge's [beads](https://github.com/steveyegge/beads); Willison's [vibe engineering vs. agentic engineering](https://simonwillison.net/2026/May/6/vibe-coding-and-agentic-engineering/).

## (b) CROSS-CUTTING THEMES (last 6 months)

1. **The harness dominates the model.** "A decent model with a great harness beats a great model with a bad harness." Most failures are configuration gaps, not model limits.
2. **Context is a finite attention budget.** Context rot is empirically real; subagent isolation, compaction, just-in-time retrieval, tight CLAUDE.md (~100–200 lines). CLI > MCP because idle MCP taxes the window permanently.
3. **The ratchet / compounding feedback loop.** Encode every failure as a *permanent* guardrail (skill, hook, convention). The single most durable operational idea.
4. **Verification-as-gate, not vibe.** Agents lie about "done." TDD/typecheck must be *enforced* in the loop, not *requested* in the prompt. Strongest new idea: separate the test-writing agent from the implementing agent so tests can't be tuned to the code.
5. **External, structured memory beats in-context markdown TODOs.** Specs, graph trackers, durable CLAUDE.md as the memory layer; fresh-context-per-atomic-task as the default unit of work.

## (c) NOTABLE SHIFTS — what 2025 did that 2026 considers a mistake

| 2025 practice (now a mistake) | 2026 correction |
|---|---|
| "Bigger context = better" / dump the repo in the window | Context rot is real; curate and minimize. |
| Long uninterrupted autonomy ("set and forget overnight") | Coherence from *orchestration, not autonomy*. Checkpoint, fresh context per atomic task; kill-and-restart degraded sessions. |
| Massive multi-agent swarms up front | "The single most expensive mistake is starting multi-agent." Default to one agent, justify the second (~15× tokens). |
| MCP-everything | Idle MCP taxes context permanently; prefer CLIs; code-execution-with-MCP cut ~99% of tool-def tokens. |
| Naive vibe coding straight to prod | Security/maintainability reckoning; *vibe ≠ agentic engineering* (Willison). Enforce, don't prompt. |
| Markdown TODO/plan files as agent memory | "Write-only memory" — replace with queryable dependency-graph trackers or specs. |
| Trusting agent self-reported "done" | Verification harnesses; only the test suite declares victory. |
| Prompt engineering as the core skill | Superseded by context engineering → harness engineering. |
| The GitHub PR/git-review model fits AI work | Review is now the bottleneck, not codegen (Ronacher, Willison). |
| Heavyweight spec frameworks for everything | SDD backlash ("waterfall in markdown"); keep specs *thin, living, delta-based*; skip ceremony for trivial diffs. |

---

## Skeptic's bottom line

The genuinely *new* primitives are few: **fresh-context-per-task loops** (Ralph), **progressive disclosure** (Skills), **dependency-graph memory** (beads), and **the ratchet**. Most of the rest is good old software engineering with new nouns. Treat the *manifestos* (12-factor, Ralph, Yegge) as **taste**, the *empirical* pieces (Chroma context-rot, Anthropic's 90.2%-but-15×-tokens result) as **evidence**. The clearest reversal of the year: the 2025 romance with *long autonomy + giant context* is dead — 2026 consensus is **short atomic tasks, fresh curated context, orchestrated-not-autonomous, gated-not-vibed.**

For golem specifically, the highest-value steals: the **two-agent init-then-code harness** (Anthropic Nov 2025), **graph-memory + agent-as-recoverable-identity** (beads), **fresh-context subagent + adversarial self-review** (superpowers), **verification-as-gate with a separate test-author**, and above all **the ratchet**.

*Caveats: superpowers (~225k) and claude-mem (~82k) star counts are live-API-verified; many blogs quote stale figures. spec-kit varies 90–112k across sources. vibe-kanban and Crystal are organizationally dead despite high stars. claude-flow ("Ruflo," ~59k) self-reported benchmarks are unverified marketing. Reddit-attributed consensus corroborated via secondary syntheses.*
