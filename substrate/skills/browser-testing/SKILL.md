---
name: browser-testing
description: How agents run Chrome for UI testing and browser automation — the shared persistent profile at ~/.golem/chrome-profile (user logins ride along), headless-only rules, and the one-instance lock. Read before any browser/CDP/devtools work, UI smoke test, or when a task needs an authenticated site.
---

# browser-testing

How any golem agent — in any project — runs Chrome for UI checks, smoke tests,
CDP/devtools automation, or authenticated browsing.

## The two profiles

| Profile | When | How |
|---|---|---|
| **Ephemeral** (default) | Plain UI checks, smoke tests, anything that does NOT need the user's logins | Fresh temp `--user-data-dir`, unique port, killed on exit. In the golem repo, use the `acquireChrome` helper (`dashboard/scripts/_chrome.mjs`) — it does all of this. |
| **Shared persistent** | The task needs the user's sessions: authenticated sites, logged-in dashboards, anything behind an auth wall | `~/.golem/chrome-profile/` — see below |

## Shared persistent profile — `~/.golem/chrome-profile/`

Golem-wide, not tied to any project. It carries the user's real logins/cookies
so agents don't get blocked by auth walls.

Launch your own headless Chrome on it:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new \
  --user-data-dir="$HOME/.golem/chrome-profile" \
  --remote-debugging-port=<unique free port>
```

Rules:

- **One instance at a time.** Chrome locks the profile (`SingletonLock`). If it
  is busy, wait — or fall back to an ephemeral profile if the task doesn't
  actually need logins.
- **Never delete, reset, or "clean up" the profile directory.** Never log out
  of sites inside it.
- **Login refresh is a human action.** The user opens the profile headed (same
  command minus `--headless=new`) and signs in; agents only consume the
  sessions. If a needed login is missing/expired, surface that to the human
  (spec "needs you" comment) — do not attempt to authenticate.
- Headless traffic can still trip aggressive bot detection despite valid
  cookies. If a site blocks you, report it rather than retrying variations.

## Hard rules (any profile)

- **Never connect to the user's desktop Chrome on port 9222.** CDP actions
  against a non-headless Chrome activate its window and steal the user's
  focus. Always spawn your own `--headless=new` instance on a unique port.
- One Chrome per process; kill what you spawn (the `acquireChrome` helper's
  `cleanup()` handles this).
- Screenshots and scratch scripts go to your scratchpad, not the repo.
