---
name: transcript-workflow-review
description: Review authorized AI-chat transcripts to find evidence-backed workflow improvements. Use for retrospectives or instruction and tool-design analysis; never to assess personality, health, intelligence, or general performance.
---

# Transcript workflow review

Find useful changes to the interaction system around the human. Report what the transcripts support,
what remains uncertain, and which changes need human approval.

## Scope

- Use only transcripts and locations the human supplied or authorized.
- Establish the review question, source, time or session range, and exclusions. Ask only for missing
  information that materially changes the review.
- State what you included and excluded. Do not silently search other transcript stores.
- Keep the review about workflows, instructions, tools, and constraints. Do not assess personality,
  motives, health, intelligence, or general performance.

## Review method

1. Identify substantive sessions that address the review question.
2. Record observable events: the request, supplied context, corrections, tool behavior, outcome,
   and unresolved work.
3. Compare sessions. Look for repeated patterns, useful counterexamples, and other explanations.
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

A correction from the human is strong evidence that something went wrong. It is not automatically a stable
preference. Classify the cause before proposing a permanent rule.

## Report

Adapt the report to the question and corpus. For each important finding, give:

- the observable pattern
- session identifiers or dates and a concise paraphrase of the evidence
- the classification and relevant alternative explanation
- confidence or uncertainty in plain language
- the practical consequence
- the smallest useful change, if the evidence supports one

Include working patterns, unpromoted observations, or open questions only when they help the human
decide. Use short quotations only when the exact wording matters. Do not impose fixed finding counts,
review periods, experiments, scores, or report sections.

## Boundaries

- Do not invent time saved, productivity measures, costs, or causal claims.
- Redact secrets and sensitive personal information. Do not upload, publish, or retain raw
  transcript content outside the authorized location.
- Consider instruction failure, agent failure, tool limits, and missing constraints before calling
  a problem a prompting issue.
- Propose durable changes as candidates. Do not edit instructions, skills, hooks, configuration, or
  memory until the human explicitly approves that change.
- Before an approved durable edit, check for an existing owner, duplicate rule, or conflict. Put the
  change in the narrowest source that fits its scope.
