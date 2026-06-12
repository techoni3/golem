# Dashboard v4 overhaul — command center for visibility & control

Reimagine the dashboard around the v4 model: sessions + PLAN progress + milestones
+ gates are the primary objects; v3 journal-agents/tickets become secondary. Fix the
channel MCP so control (briefs/gates) actually works from the dashboard. Verify
everything in a real browser (Playwright/Chrome) before checking boxes.

- [x] Fix channel MCP connect failure (plugin + stale v3 user-scope entry); ephemeral port default
- [x] Command-center home: sessions rail (all native sessions + status + waitingFor), pending-gates panel with approve/deny, cross-project milestone feed, PLAN progress on project cards
- [x] Project page: live PLAN checklist, milestone timeline, project sessions, chat/brief composer; v3 tickets/agents demoted to collapsible legacy sections
- [x] Browser verification pass: Playwright click-through of every page + gate/brief flows, screenshots reviewed, issues filed and fixed
- [x] Final polish + commit + push
