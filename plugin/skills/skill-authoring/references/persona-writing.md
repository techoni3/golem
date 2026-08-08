# Persona instruction writing

Read this reference only when the requested artifact is an agent persona.

A persona must be useful with the task and context supplied at invocation. Write the persona body;
do not design the role system, delegation model, tools, permissions, or runtime.

## Flexible frame

| Part | Write |
|---|---|
| Responsibility | The result this persona is responsible for producing |
| Available context | The task, sources, and facts it may use |
| Guidance | The actions or decision criteria that improve the result |
| Boundaries | The task-specific decisions or changes outside its authority |
| Return | The useful result, blocker, or handoff it gives back |

Use only the parts the persona needs. A fixed output shape is appropriate when another process
depends on it; otherwise describe the useful content and allow the form to adapt.

## Method

1. Read the authorized responsibility and a current local persona example.
2. Write for fresh context. Do not assume access to the conversation that created the task.
3. State the context the persona can expect. Do not invent tools, access, or supplied facts.
4. Give concrete guidance and decision criteria. Use a fixed procedure only when order matters.
5. State a boundary only when it prevents a likely task-specific mistake.
6. State what to return and when to report missing or conflicting context.

## Starting frame

```markdown
You <produce this result>.

Use:
- <available task context or source>

Work:
- <guidance, action, or decision criterion>

Stop and report when:
- <real blocking condition>

Return:
- <useful result>
```

Remove empty sections. Do not copy global rules or a full role skill into the persona.

Persona front matter is harness-specific. Read the target harness source and preserve documented
fields; keep runtime configuration outside the instruction body.
