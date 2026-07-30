# Persona and subagent authoring

A subagent is not a bigger skill. Its body **is** a system prompt, it runs in a fresh context, and
it is selected by the same kind of description matching that routes skills — so everything in
[description-craft.md](description-craft.md) applies here, with the stakes raised. A subagent that
never gets delegated to is invisible in exactly the same way.

## The defining constraint: fresh context

A spawned agent receives its own system prompt, its task, the applicable project-instruction
hierarchy, basic environment information, and any skills its configuration injects. It does **not**
receive the parent conversation or the parent's loaded skills.

A persona body that assumes *"you already know what we were discussing"* is broken by
construction. Write it for someone who just walked in.

## The description is a delegation router

Write it as **when to delegate here**, not **what this agent is**. Vague descriptions produce
essentially random invocation. If proactive delegation is wanted, say so explicitly — phrasings
like "use proactively" or "use immediately after X" work.

Know the limitation: even with a matching description, the main session frequently just handles
the task itself. The reliable path to a specific agent is explicit naming. Design for that — make
the description easy for a *human* to select on too, and do not build an architecture that assumes
automatic delegation fires every time.

## The six-part contract

1. **Mission and non-goals.** What it exists to do, and explicitly what it must not do.
2. **Inputs it may trust**, and how to inspect for missing context instead of assuming.
3. **Allowed tools and permitted side effects.**
4. **An ordered method, including when to stop.**
5. **Evidence standard and output schema** — exactly what to return, in what shape.
6. **Escalation path** for ambiguity, missing credentials, or anything unsafe.

Three things make this work in practice: a **trigger procedure** ("When invoked: 1… 2… 3…"), a
**checklist rather than prose**, and an explicit **output contract**. The output contract is the
part most often omitted and most often regretted — without it you get a differently-shaped report
every run and the orchestrator cannot parse results reliably.

## Tool scoping is a safety mechanism

Restricting tools is the single most effective way to make a subagent focused and safe. Default to
the smallest set that lets the work happen.

The canonical case: **a reviewer that cannot write files cannot "fix" a problem by quietly
rewriting it — it has to report it.** The restriction does not merely prevent damage; it forces
the behaviour you actually wanted. This is persona enforcement that actually enforces, as opposed
to asking the persona politely in prose.

Tool restriction is capability control, not a substitute for permission review.

## Model selection by role

Smaller and faster for search, file discovery, and routine summarisation. Mid-tier for analysis
and most implementation. The largest only for genuinely hard reasoning.

The counter-intuitive part worth remembering: **larger models given long mandatory reading tend to
lose focus, and faster models often produce better results on tightly scoped tasks.** Bigger is not
automatically better for a bounded job.

## Independence is structural, not declared

If an agent spawned to review work inherits the full context in which that work was produced, it
is not fresh eyes — it is the same eyes in a second process, and confirmation bias follows. A
documented case had a context-inheriting reviewer miss a security bug that a fresh-context
reviewer caught.

**Reviews and audits get fresh context. Design-continuity work gets inherited context.** Choose
deliberately rather than by default.

The related rule for orchestrators: an agent must never review its own output, regardless of what
role it is currently wearing. Independence is a property of the actor, not of the label.

## Over-delegation

Spawning a subagent has real overhead — each is a full session with its own startup and context
window. Spawning one to answer something the main session could have answered directly is pure
waste, and current models have a documented tendency to over-delegate.

Coordinated multi-agent *teams* are more expensive again, by roughly an order of magnitude over a
single session. Use them only when workers genuinely benefit from each other's findings **during**
execution. Sequential work, same-file edits, and mostly-independent tasks are faster and cheaper
without them.

## Persona drift

Agents demonstrably violate their own explicitly-loaded behavioural rules mid-session — reading
them at startup, citing them correctly when challenged, then not following them. More memory
files, more rules, and repeated verbal correction do not reliably fix it.

The design conclusion is the same as for enforcement generally: **if a behaviour genuinely must
hold, do not rely on the persona to hold it.** Put it in a gate, a hook, a tool restriction, or a
check that runs. Tool scoping is the strongest lever available here.
