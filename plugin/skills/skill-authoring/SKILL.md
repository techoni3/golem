---
name: skill-authoring
description: Write or revise clear instructions for a skill or agent persona. Use for a SKILL.md, its description or front matter, or a persona body. Covers scope, structure, plain technical language, and editorial review. Not for runtime, evaluation, or enforcement design.
---
<!-- GENERATED: skills/skill-authoring/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Skill authoring

Write instructions that help an agent make better decisions and produce a useful result. Treat the
instructions as adaptable guidance unless the user asks for an exact procedure or output contract.

## Scope

| Write | Do not design |
|---|---|
| Skill name, description, front matter, and body | Skill loading, matching, or runtime evaluation |
| Agent-persona instruction body | Roles, delegation, models, permissions, or agent topology |
| Structure, wording, examples, and references | Hooks, CI, tools, scripts, or enforcement |
| Revisions requested by the user | Automatic rules based on failure history |

Instruction writing does not authorize supporting code or configuration.

## Authoring flow

| Step | Action | Done when |
|---:|---|---|
| 1 | **Ground.** Read the request, target file, local conventions, and sources needed for factual claims. | You can separate facts, user decisions, and your assumptions. |
| 2 | **Frame.** State the purpose, variable context, useful guidance, boundaries, and expected result. | You can say what the instructions change in one sentence. |
| 3 | **Choose forms.** Select the structures that fit the material. | Each section has a clear function from the form table below. |
| 4 | **Write front matter.** Make the name valid and the description useful for routing. | The description states what the skill does and when it applies. |
| 5 | **Write the core.** Put concrete steps and essential reference in the main file. | An agent can act without guessing or opening optional material. |
| 6 | **Place conditional material.** Link a reference only for a distinct branch or use case. | Every reference has a stated read condition and no core rule is hidden. |
| 7 | **Edit.** Simplify the language, resolve conflicts, and remove no-op content. | Every remaining line changes an action, decision, or interpretation. |

## Frame the guidance

Use this as a thinking frame, not as a required document schema. Fill only the parts that improve
the target instructions.

| Part | Question |
|---|---|
| Purpose | What should the agent be better able to do? |
| Context | What facts, artifacts, or constraints can vary between uses? |
| Guidance | Which actions, choices, or criteria improve the result? |
| Boundaries | Which likely mistake needs a limit? |
| Result | What useful outcome tells the agent to stop or return? |

Most skills guide judgment. Do not turn variable work into fixed inputs, pass/fail gates, or an
exhaustive workflow. Add exact checks only when the user requests deterministic behavior.

## Choose the instruction form

Combine forms when the skill needs them. Do not force the entire skill into one form.

| Need | Form | Write |
|---|---|---|
| Judgment varies with context | Guidance | Goal, useful criteria, and room to adapt |
| Order affects the result | Procedure | Numbered actions in execution order |
| Behavior changes in one case | Condition | `If <observable condition>, <action>.` |
| The agent must find or compare facts | Reference | A grouped list or mapping table |
| A result needs a recognizable shape | Flexible template | A minimal frame with optional sections |
| One wrong action has a high cost | Guardrail | The positive target and the necessary limit |

## Write the front matter

```yaml
---
name: skill-name
description: State what the skill does. Use when the task needs this guidance or artifact.
---
```

| Field | Rule |
|---|---|
| `name` | Use lowercase letters, digits, and single hyphens. Match the directory name. |
| `description` | State the action or result, then the high-level situation in which it applies. |

Use task words that a user or agent is likely to use. Keep the description broad enough to cover
the skill and specific enough to distinguish it. Do not summarize the method or list low-level
steps. Add an exclusion only when a nearby skill or task is easy to confuse with this one.

Preserve supported optional fields already present in the target. Change optional metadata only
when the user or an authoritative local source requires it.

## Organize the content

| Put in the main file | Put in a reference |
|---|---|
| Concrete steps used in normal operation | A step used only for one branch or variant |
| Essential terms, choices, and reference facts | Detail needed only under a stated condition |
| Guidance that applies to every use | Persona- or environment-specific material |
| Universal task boundaries | Large lookup material that only some uses need |

A reference is justified by conditional relevance, not by length alone. Link it directly from the
main file and state when to read it. Keep each rule in one place, and keep its definition, action,
and caveat together.

For agent-persona instructions, read
[references/persona-writing.md](references/persona-writing.md).

## Use structure with purpose

Minimize the human's reading and navigation load. Use the smallest structure that makes the
relationship clear.

| Material | Best default |
|---|---|
| Context or a necessary reason | Lean prose |
| Independent choices, rules, or checks | Bullets |
| Ordered actions | Numbered list or step table |
| Mappings, comparisons, or repeated fields | Table |
| A non-obvious branch, loop, or relationship | Mermaid diagram |
| Exact syntax or a reusable frame | Code block |

Do not use a diagram for a linear sequence or a table for a single comparison. Structure must make
the content faster to understand; it must not decorate the document.

## Use simplified technical English

Use an ASD-STE100-inspired style; do not claim formal compliance. Use familiar words, active voice,
short sentences, one main instruction per sentence, and one term per concept; define acronyms and
avoid idioms, slogans, metaphors, and decorative jargon.

Prefer a positive instruction that names the target behavior. Use a prohibition only for a real
boundary, and pair it with the action the agent should take. Express an exception as a condition
with an observable trigger. Use a compact established term when it reduces repetition; do not
invent a term that needs more explanation than it saves.

## Flexible skill frame

Start with this frame. Remove any heading that does no work, and add a heading only when the
material needs a distinct function.

```markdown
---
name: <skill-name>
description: <what it does>. Use when <high-level situation>.
---

# <Title>

<Purpose and operating stance in one or two sentences.>

## <Method or guidance>

<Core actions, choices, or criteria.>

## <Reference or decisions, when useful>

<Compact facts, mappings, or conditions.>

## <Boundaries, when needed>

<Only the limits that prevent a likely wrong action.>

## <Result, when it needs clarification>

<What to return or when to stop.>
```

## Common errors

| Error | Correction |
|---|---|
| Generic advice such as “follow best practices” | State the local choice or useful decision criterion. |
| A rigid protocol for variable work | Give direction and criteria; preserve judgment. |
| History presented as an active rule | Keep the current instruction; move history out. |
| Core guidance hidden in references | Move it into the main file. |
| Every possible branch in the main file | Move only conditional branches to named references. |
| Long prohibition lists | State the desired behavior and keep only necessary limits. |
| The same rule in several documents | Keep one owner and use a direct pointer elsewhere. |

## Editorial pass

This pass checks the written artifact. It does not evaluate runtime behavior.

- [ ] The front matter is valid and the description gives a useful high-level route.
- [ ] The purpose and expected result are clear without forcing variable work into a protocol.
- [ ] Concrete steps and essential reference are in the main file.
- [ ] Each conditional reference is linked and has a read condition.
- [ ] The format of each block matches its function.
- [ ] The language follows the simplified technical English rule above.
- [ ] Factual claims come from sources that were read.
- [ ] No rule is duplicated, contradicted, generic, or unrelated to the request.
- [ ] No supporting artifact was added without user authority.

The human decides whether the instructions work well in practice.
