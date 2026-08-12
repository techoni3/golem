---
name: context-audit
description: Run only when the human explicitly invokes it — never as part of any workflow. Audit what a cold-start session actually carries — discovered skills, discovered MCP tools, and compact summaries of loaded and conditionally-referenced instructions.
---

# Context audit

An on-demand introspection of this session's cold-start state — its personality, knowledge, and
leaning. Report what IS in context, not what should be.

## Report, in this order

1. **Skills discovered** — every skill name visible to this session (plugin, project, or user
   scope), one line each: name + what its description promises to route.
2. **MCP tools discovered** — every tool available (loaded or deferred), grouped by server.
3. **Cold-start instructions — 10 bullets.** Summarize everything already loaded before the
   first user message: global rules, project instructions, memory, hook-injected context. Each
   bullet captures one behaviour-shaping leaning, not a section heading.
4. **Conditional instructions — 10 bullets.** Summarize what the loaded instructions reference
   for later loading — skills per role or situation, pointed-at docs, escalation paths. Each
   bullet: the trigger, then what gets loaded.

## Rules

- Ground every line in what is actually present in this session's context or tool registry. Do
  not read files to "complete" the picture — absence is itself a finding.
- Exactly 10 bullets in sections 3 and 4; the cap forces prioritisation toward the most
  behaviour-shaping items.
- Plain report in chat. Create nothing, change nothing, load nothing.
