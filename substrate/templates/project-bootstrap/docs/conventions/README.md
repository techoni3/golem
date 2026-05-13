# Conventions

Project-wide normative rules that don't fit ARCH (which is *what* is built) or CONTEXT (which is *what things mean*). Conventions are about *how we do things in this codebase*.

One concern per file. Examples to seed: `testing.md`, `http.md`, `models.md`, `naming.md`, `errors.md`. Add a file when a category emerges; don't pre-stock empty files.

A convention earns a file when:
- It's been said in review more than once.
- An agent-note has surfaced the same pattern twice.
- An ADR introduced a rule that needs surface-level enforcement.

A convention does NOT live here when:
- It's a per-decision rationale (that's an ADR).
- It's domain vocabulary (that's CONTEXT.md).
- It's an architecture-level invariant (that's ARCH.md).

Mutated by:
- **Documentarian** on sweep when a new convention emerges from agent-notes.
- **Tech Architect** when an ADR introduces one.

Read by:
- Engineer (active rules during implementation).
- Code Reviewer (review against the rules).
- Test Spec Writer (write specs that respect the rules).
