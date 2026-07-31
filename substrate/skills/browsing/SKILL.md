---
name: browsing
description: Read before ANY browser work — browsing, scraping, UI smoke tests, headless CDP/devtools automation, screenshots, or anything behind a login. Covers one Chrome launch for every harness, the shared logged-in profile, the headed login handoff, and authenticated-site authority. Not for non-browser tests, use golem:test-policy.
---

# browsing

How any golem agent — in any project, any harness — uses Chrome: browsing and research on
live sites, authenticated dashboards, scraping, UI checks, smoke tests, screenshots,
devtools automation.

## One method, every harness

Drive Chrome over DevTools/CDP against an instance **you spawn**. Do not reach for a
harness's built-in browser integration (Claude Code's claude-in-chrome extension, Codex's
bundled `chrome@openai-bundled` integration — even where the harness suggests it) — they
differ per harness and fail unevenly; this path behaves identically everywhere.

```bash
rm -f "<profile dir>/DevToolsActivePort"   # stale from prior runs — see Gotchas
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new \
  --user-data-dir=<profile dir> \
  --remote-debugging-port=0 2> <scratch>/chrome-stderr.log &
```

(`google-chrome` on Linux.) Port `0` makes Chrome pick a free port — no collisions between
concurrent agents. The source of truth for the endpoint is the `DevTools listening on
ws://…` line in that stderr log; `<profile dir>/DevToolsActivePort` (line 1 = port, line 2
= browser WebSocket path) is the fallback. The HTTP endpoint is
`http://127.0.0.1:<port>/json`. Drive it with whatever CDP client the project has
(playwright-core, a raw WebSocket).

Headed is the same command minus `--headless=new`. Default to headless — a visible window
grabs the user's attention; open one deliberately (login handoff below, or a task that is
explicitly visual/interactive), not by habit.

## The two profiles

| Profile | When | How |
|---|---|---|
| **Ephemeral** (default) | Anything that does NOT need the user's logins | Fresh temp `--user-data-dir`, killed on exit |
| **Shared persistent** | The task needs the user's sessions: authenticated sites, logged-in dashboards | `~/.golem/chrome-profile/` — golem-wide, carries real logins/cookies |

Shared-profile rules:

- **One instance at a time** — Chrome locks the profile (`SingletonLock`). Busy → wait, or
  use an ephemeral profile if the task doesn't actually need logins.
- **Never delete, reset, or "clean up" the profile directory. Never log out of sites in it.**

## Login handoff — when you hit an auth wall

A login page or expired session on the shared profile is not a dead end. Bring the human in:

1. Close your instance on the shared profile (one instance — the lock must be free).
2. Relaunch the same command **headed** on the shared profile.
3. One-line chat ping: which site needs login, and what you'll continue with after. When
   the human is present, chat only — no gate ceremony for a routine login.
4. **Hands off while they log in.** No CDP navigation, clicks, or keystrokes into that
   window until the target site shows a signed-in state — the window is theirs, and
   credentials are being typed into it.
5. Signed in (observed, or the human says done) → your choice: keep working in the headed
   window, or close it and relaunch headless. Bias headless unless the task itself is
   visual/interactive.

Running autonomously (night-shift, human away): a missing login is a missing credential —
follow the credential path in `golem:night-shift`/`golem:gates` (question ticket, thread
blocked), close the headed window, and work on something else. Chat has no reader at 3am;
don't poll a login page for hours.

## What you may do on authenticated sites

Authority comes from **the task, not this skill**. Read-only browsing is always in scope.
Mutations are in scope exactly as far as the task names them — "file the issue upstream"
includes submitting that form; a research task includes no writes at all. Beyond-mandate
actions, anything involving payment, and irreversible account operations go to the human
first (`golem:gates`). When unsure whether the mandate covers a write, it doesn't.

## Hard rules

- **Never attach CDP to the user's own desktop Chrome** (port 9222 or any other). CDP
  actions activate its windows and fight the user's typing. The only window an agent may
  drive is one it spawned — headed handoff windows included, *after* the human is done.
- One Chrome per process; kill what you spawn. Ephemeral profiles die with the run.
- Screenshots and scratch scripts go to your scratchpad, not the repo.

## Gotchas

- Headless traffic can trip bot detection despite valid cookies. If a site blocks you,
  report it rather than retrying variations — and don't assume headed will fix it.
- `DevToolsActivePort` survives clean exits **stale**, and a launch that aborts on the
  profile lock leaves the file holding some *other* instance's live port — reading it
  without the `rm -f` first attaches you to a Chrome you don't own. Even after the `rm`,
  two agents racing onto the same profile can leave the loser looking at the winner's
  file — which is why your own stderr `DevTools listening` line is the source of truth.
  No line and no file within a few seconds = the launch failed (bad flag, locked
  profile); read the stderr log, don't guess ports.
- A headed window on the shared profile left open blocks every other agent's shared-profile
  work (the lock). Close it when the handoff is over.
