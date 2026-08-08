# Front matter

Use this reference for document metadata. It does not define loading or matching behavior.

## Skill

```yaml
---
name: skill-name
description: State what the skill does. Use when the task needs this method or artifact.
---
```

| Field | Rule |
|---|---|
| `name` | Use lowercase letters, digits, and single hyphens. Match the directory name. |
| `description` | State the action or result, then the situation in which it applies. |

Keep the description specific. Name the artifact, task, or environment when it prevents ambiguity.
Add a nearby exclusion only when another instruction set is easy to confuse with this one.

| Weak | Revised |
|---|---|
| `Guidance and best practices for PDFs.` | `Create, edit, or inspect PDF files. Use when the task requires PDF content or layout.` |
| `Helps with reviews.` | `Review a specification or code change and report findings. Use before approval or merge.` |

## Existing optional fields

Preserve supported fields already present in the target. Add or remove an optional field only when
the user request or an authoritative local source requires the change. Do not invent metadata.

## Agent persona

Persona front matter is harness-specific. Read the target harness source and a current local
example. Use only documented fields. Keep runtime configuration outside the instruction body.
