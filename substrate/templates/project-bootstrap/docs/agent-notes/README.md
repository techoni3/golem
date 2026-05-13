# Agent Notes

Short-lived learned notes. Append-only by working agents during a session.

## When to write a note

- Discovered a non-obvious gotcha that would help the next agent.
- A pattern is emerging but isn't yet clear enough for a normative doc.
- An assumption you made should be checked next time before relying on it.

## When NOT to write a note

- It's already in CONTEXT, ARCH, or an ADR (write there instead).
- It's specific to one ticket and won't recur (it goes in the ticket's hand-off log instead).
- It's a TODO for yourself — use the tracker.

## Format

One file per note: `<slug>.md`.

```markdown
# <Topic>

**Last verified**: YYYY-MM-DD
**Verified by**: <agent or human>

<one-paragraph note. What did we learn? Where does it apply?>
```

## Promotion

Documentarian sweeps notes on cadence. When a note recurs across multiple sessions or proves load-bearing, it's promoted into a normative doc (CONTEXT, ARCH, conventions) and the source note is deleted. Source-of-truth has moved.
