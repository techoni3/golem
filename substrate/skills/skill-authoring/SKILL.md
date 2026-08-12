---
name: skill-authoring
description: Write or revise clear instructions for a skill. Use for a SKILL.md, its description or front matter, or a persona body. Covers scope, structure, plain technical language, and editorial review. Not for runtime, evaluation, or enforcement design.
---

# Skill authoring

Write instructions that help an agent make better decisions and produce a useful result. Treat the
instructions as adaptable guidance unless the human asks for an exact procedure or output contract.

## Scope

| Write | Do not design |
|---|---|
| Skill name, description, front matter, and body | Skill loading, matching, or runtime evaluation |
| Structure, wording, examples, and references | Hooks, CI, tools, scripts, or enforcement |
| Revisions requested by the human | Automatic rules based on failure history |

Instruction writing does not authorize supporting code or configuration.

## Authoring flow

| Step | Action | Done when |
|---:|---|---|
| 1 | **Ground.** Read the request, target file, local conventions, and sources needed for factual claims. | You can separate facts, human decisions, and your assumptions. |
| 2 | **Frame.** State what the agent should do better (purpose), what varies between uses (context), which criteria improve the result (guidance), which likely mistake needs a limit (boundary), and what outcome ends the task (result). | You can say what the instructions change in one sentence. |
| 3 | **Choose forms.** Select the form that fits each piece of material from the table below. | Each section has one clear function. |
| 4 | **Write front matter.** Make the name valid and the description useful for routing. | The description states what the skill does and when it applies. |
| 5 | **Write the core.** Put concrete steps and essential reference in the main file. | An agent can act without guessing or opening optional material. |
| 6 | **Place conditional material.** Link a reference only for a distinct branch or use case. | Every reference has a stated read condition and no core rule is hidden. |
| 7 | **Edit.** Simplify the language, resolve conflicts, and remove no-op content. | Every remaining line changes an action, decision, or interpretation. |

## Choose the form

Prose carries method and judgment; tables carry mappings and comparisons; structure never
substitutes for content. Compressing a method into one-line table cells deletes the judgment the
agent needs — when a decision has real criteria, give them room in prose, even when a table would
look tidier.

| The material | Write it as |
|---|---|
| Judgment that varies with context | Guidance in lean prose: the goal, the useful criteria, and room to adapt |
| A method where order affects the result | Numbered actions in execution order, with the reasoning that makes each step work |
| Behavior that changes in one case | `If <observable condition>, <action>.` |
| Facts the agent must find or compare | A grouped list or mapping table |
| A result that needs a recognizable shape | A minimal template with optional sections |
| One wrong action with a high cost | A guardrail: the positive target plus the necessary limit |
| A non-obvious branch, loop, or relationship | A small diagram — never for a linear sequence |

Use the smallest structure that makes the relationship clear. Structure must make the content
faster to understand; it must not decorate the document.

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

Use task words that a human or agent is likely to use. Keep the description broad enough to cover
the skill and specific enough to distinguish it. Do not summarize the method or list low-level
steps. Add an exclusion only when a nearby skill or task is easy to confuse with this one.

Preserve supported optional fields already present in the target. Change optional metadata only
when the human or an authoritative local source requires it.

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


## Use simplified technical English

Use an ASD-STE100-inspired style; do not claim formal compliance. Use familiar words, active voice,
short sentences, one main instruction per sentence, and one term per concept; define acronyms and
avoid idioms, slogans, metaphors, and decorative jargon.

Prefer a positive instruction that names the target behavior. Use a prohibition only for a real
boundary, and pair it with the action the agent should take. Express an exception as a condition
with an observable trigger. Use a compact established term when it reduces repetition; do not
invent a term that needs more explanation than it saves.

## Example: before and after

Before — every line is a no-op that decides nothing:

```markdown
## Review
- Review the code carefully when needed.
- Follow best practices and be thorough.
- Escalate issues appropriately.
```

After — every line changes an action:

```markdown
## Review
Trace the changed runtime path from entry point to side effect before judging it.
Report a finding only after re-reading the code that proves it.
If the change states a rule, search the tree for other statements of that rule —
contradictions live in the copy nobody remembered.
```

The rewrite works because each line names an observable action and its trigger. "When needed",
"best practices", and "appropriately" left every real decision to the reader.

## Common errors

| Error | Correction |
|---|---|
| Generic advice such as “follow best practices” | State the local choice or useful decision criterion. |
| A rigid protocol for variable work | Give direction and criteria; preserve judgment. |
| A method compressed into one-line table cells | Move it to prose or numbered steps that carry the criteria. |
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
- [ ] The form of each block matches its function; no method is trapped in one-line cells.
- [ ] The language follows the simplified technical English rule above.
- [ ] Factual claims come from sources that were read.
- [ ] No rule is duplicated, contradicted, generic, or unrelated to the request.
- [ ] No supporting artifact was added without the human's authority.

The human decides whether the instructions work well in practice.
