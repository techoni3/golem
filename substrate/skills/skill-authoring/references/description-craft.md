# Description craft — the routing surface

The description is the **only** thing that decides whether a skill loads.

At match time the body does not exist yet. Nothing in it can influence selection. Every word about
*when this should be used* that lives in the body is inert. This one mechanic explains most
non-triggering skills.

## The formula

```
<What it does, concretely, third person, leading with verbs>.
Use when <the situations and the literal words a user would type>.
Do not use for <the nearest neighbours it keeps stealing work from>.
```

In descending order of impact:

1. **Third person.** Not "I help you…", not "You should…".
2. **Both halves — what it does AND when to use it.** This is what the format asks for; a
   description giving only one half routes badly.
3. **The exact words users type, not synonyms.** If people say "audit", the word "audit" must
   appear. The matcher compares your text against their text.
4. **Lead with verbs**, not a noun phrase naming a category.
5. **Name the artifact, tool, format, or environment** when it disambiguates.

## Before and after

> **Before:** `"A collection of utilities and best practices for working with PDF documents."`
>
> **After:** `"Extract form fields, fill forms, redact text, or parse tables from PDF files. Use
> when the user asks to fill, redact, or parse a PDF, or mentions form fields, AcroForms, or PDF
> extraction."`

The first is a shelf label. The second is a routing rule made of words a user would actually type.

## Calibration — shipped first-party descriptions

Verbatim, from skills published by the vendor:

| Skill | Description | Why it works |
|-------|-------------|--------------|
| `skill-creator` | "Create new skills, modify and improve existing skills, and measure skill performance." | Concrete verbs — create/modify/measure — not the bare noun "skills" |
| `mcp-builder` | "Guide for creating high-quality MCP servers that enable LLMs to interact with external services through well-designed tools." | Artifact + purpose + integration boundary |
| `webapp-testing` | "Toolkit for interacting with and testing local web applications using Playwright." | Environment + tool + intent |
| `brand-guidelines` | "Applies Anthropic's official brand colors and typography to any sort of artifact." | The transformation and its subject |
| `slack-gif-creator` | "Knowledge and utilities for creating animated GIFs optimized for Slack." | Output format + target platform |

Note what is absent from all five: no role-priming, no "best practices", no adjectives about
quality.

## Recall first, then precision

Models measurably **under-trigger** skills, and the official skill-creator explicitly recommends
making descriptions *"a little bit pushy"* for that reason. The asymmetry justifies it:

- A **false trigger** costs a few tokens. The agent loads the skill, sees it does not apply, moves
  on.
- A **missed trigger** costs the skill's entire value plus the author's belief that skills work.

So bias toward firing — then run the negative half of the trigger matrix and add anti-triggers
until the false positives stop. "Pushy" is a recall heuristic, not a licence to be indiscriminate.
The standing requirement is still *specific*, and vagueness — not pushiness — is the documented
anti-pattern.

## Anti-triggers

Without explicit boundaries, skills over-activate on loose keyword matches and overlapping skills
fight over the same request. A short block is one of the highest-leverage additions available:

```markdown
## When NOT to use

- For Twitter/X content — use the `x-thread-writer` skill.
- For long-form blog posts — use `blog-post-writer`.
- For internal memos or status updates — plain prompting is fine.
- When the user shares a link without asking for content to be produced.
```

**Name the neighbour.** "Don't use this for X" is weak. "Don't use this for X, use `other-skill`"
suppresses the false positive *and* routes the request correctly. When two skills genuinely
compete, each should name the other.

## Diagnosis: it does not fire

In order — each step rules out the ones below it.

1. **Is it loaded at all?** List the installed skills. Absent → path, directory-name, or
   frontmatter problem, not a description problem. Skip to *silent failures* below.
2. **Listed but marked user-only?** Model invocation is disabled for it. That is often deliberate
   (see below) and often forgotten.
3. **Listed, manually invocable, never auto-fires?** The description is too vague. Rewrite with
   the formula and re-run the matrix.
4. **It used to work and stopped?** Suspect listing-budget pressure from skills added since. Every
   installed description shares one startup budget; on overflow, descriptions get dropped, and the
   least-used skill loses its trigger keywords first — exactly the one you are least likely to
   notice. Prune what is unused, tighten long descriptions, prefer project scope over global.
5. **It fires on everything?** Too broad, no anti-triggers.

**The observable-marker technique** makes step 3 unambiguous. Temporarily add a harmless
instruction to the body — *"Begin the response with `[MODE]`"*. If the marker appears, discovery
and selection worked and the bug is later in the workflow. If it does not, the description is the
problem. Remove the marker afterwards.

## Silent structural failures

These skip discovery entirely and produce no error at all:

| Cause | Fix |
|-------|-----|
| Frontmatter does not parse | Smart quotes pasted from a document, tabs used for indentation, missing closing `---`, or a formatter rewrapping a long single-line description into a folded scalar |
| Directory name ≠ frontmatter `name` | They must match |
| Invalid `name` grammar | 1–64 chars, lowercase alphanumeric + hyphens, no leading, trailing, or consecutive hyphens |
| Created mid-session | Skills are scanned at session start — restart |

## Deliberate non-triggering

Anything with real side effects — deploys, commits, outbound messages, destructive operations —
should not be model-invocable. Make it explicitly user-invoked.

The inverted failure mode is common: an author sets this on a workflow skill, forgets, and then
spends a week debugging why it "never triggers". It is working as configured. Check this before
rewriting the description.
