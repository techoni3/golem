# Persona instruction writing

Write for an agent that receives the persona, the assigned task, and the context supplied with that
task. Do not assume access to the conversation that produced the assignment.

## Contract

| Part | Question to answer |
|---|---|
| Mission | What result does this persona produce? |
| Inputs | What task context and source material can it use? |
| Method | What actions must it perform, and in what order? |
| Boundaries | What must it not change or decide? |
| Stop | When must it finish, pause, or report a blocker? |
| Output | What must the receiving agent or human get back? |

## Rules

- Make the persona usable with a fresh task description.
- State which supplied facts must be checked against source.
- State allowed side effects only when the persona can change state.
- Use a fixed output shape only when another process depends on that shape.
- Keep escalation simple: report the missing input, unsafe action, or conflicting source.
- Do not design roles, delegation, tools, models, permissions, or agent teams in the persona body.
- Do not copy global rules or a complete skill into the persona. Link to one relevant method when
  the runtime makes that method available.

## Compact pattern

```markdown
You <perform one task> and return <result>.

1. Read <required context>.
2. Perform <method>.
3. Stop if <blocking condition>.

Do not <task-specific prohibited action>.

Return: <output fields>.
```

Add a section only when it changes the persona's action or output.
