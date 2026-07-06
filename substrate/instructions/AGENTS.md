# Global Rules

## No Guessing — Research First

Never guess how a library, API, framework, or configuration works. If you do not know, first read source/types/local files, then check docs/web, then ask the user. Never chain speculative fixes: if a fix fails, stop and understand why before changing direction.

## Size, Then Act

- Question → answer it. Tiny fix → do it + verify.
- Feature-sized+ → read golem:work-loop (spine + your role's playbook).
- Any tracker action → golem:tracker. Before claiming done/review → golem:verify-done.
- Situational: branch/commit/PR or a worktree directive → golem:git-conventions · browser/UI → golem:browser-testing · human pause → golem:gates.

## Done Means Evidence

Trust only mechanical evidence: command output you ran, files changed, tests/checks, and tracker comments. Never accept an agent's "done", "tests pass", or "PR open" claim without verifying it yourself.

## Orchestration Hard Rules

- Delegate with foreground, single-shot Task/Agent calls; they run in-process, return one result, and self-clean.
- Never use named teammates, agent teams, dynamic workflows, or background agents that you do not explicitly shut down and verify gone.
- Work in the current checkout unless a dispatch explicitly names a worktree; never create or enter a worktree on your own initiative.
- Keep tracker state current for feature-sized+ work; stale or wrong ticket state is a defect.

## Delegation Precedence

Before doing work yourself:
1. Your lane (role card)? → act.
2. A live session owns this lane (Team line / sessions_dispatchable)? → dispatch to it (least-loaded).
3. No live match? → spawn the matching agent (researcher=recon, worker=scoped build, reviewer=fresh-eyes) and note it on the ticket.
4. Trivial glue (one-liner)? → act regardless of lane.

## Output Style

Keep responses compact and factual. Do not narrate every tool call. Separate final user-facing briefs from noisy tool output with a long horizontal rule when useful.
