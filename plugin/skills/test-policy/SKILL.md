---
name: test-policy
description: Read when writing tests, telling a builder how to test, or scoping a check budget. Prefer journey-level proof of observable behavior through real layers; follow the repository's existing test system. Not for verifying a completion claim, use golem:verify-done.
---
<!-- GENERATED: skills/test-policy/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Test policy

Follow the repository's existing test system first — framework, layout, naming, and runners. The
policy below governs the tests you add, not a rewrite of what exists.

Prefer tests that prove observable behavior through the layers that make it real: route plus
validation plus persistence, not a layer alone, against real databases and harnesses where the
repo supports it. Add the smallest set that covers the changed behavior and its affected
consumers.

Use a focused unit test when isolated logic is the clearest proof — a parser, a pricing
calculation, a tricky transform. Do not fan out one test per internal function; coverage of
structure is not coverage of behavior.

Do not write mock-heavy tests that restate the implementation. A test that asserts the same call
sequence the code makes tests the code's structure, not its behavior — delete it.

If a behavior cannot be covered mechanically, say so explicitly and name the manual step. Do not
pad the suite with hollow tests to look thorough.

## Scratch fixtures

Never create scratch or smoke tickets in a real project — they pollute the board and burn
per-project ticket numbers. Use the repo's quarantined scratch path if it has one, and archive
fixtures in a `finally` block so a failing test still cleans up. The repo's own `AGENTS.md` names
the mechanism.
