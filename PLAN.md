# Dashboard v4 — fix round 2 (visibility/control defects)

Four defects from live review of the command-center dashboard. All dashboard-side.
Verify in a real browser (Playwright) before checking boxes; never kill live :7420.

- [x] Peek drawer for native sessions: make session cards (home rail + Agents page) clickable → drawer with metadata + recent central-journal activity + milestones for that session_id
- [x] Retire the dead v3 journey-memo subheader; replace with a live v4 signal (latest cross-project milestone, neutral fallback)
- [x] Topbar + sidebar liveness counts read native sessions (live = alive native sessions), not stale v3 journal agents
- [x] Demote 399 historical substrate agents: Agents page shows live by default, done collapsed behind a toggle (capped render)
- [x] Browser verification + commit + push
