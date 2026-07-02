// TKT-0519: scratch-ticket helper for smokes. ALL smoke fixtures MUST go
// through this — they land in the quarantined `smoketests-000000` project
// (deliberately unregistered — never appears in the projects sidebar) so they
// never pollute a real project's board or its per-project ticket numbering.
// Archive them in a finally block; never create scratch tickets in a real project.
export const SMOKE_PROJECT = 'smoketests-000000';
const API = 'http://dashboard.golem.localhost:7420';

// Create a scratch ticket in the smoke project. `fields` overrides defaults
// (kind, body, assignee, parent_id, etc.); the title is SMOKE-prefixed.
export async function createScratchTicket(fields = {}) {
  const res = await fetch(`${API}/api/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_id: SMOKE_PROJECT,
      created_by: 'smoke',
      kind: 'work-item',
      ...fields,
      title: `SMOKE-${fields.title ?? 'scratch'}`,
    }),
  });
  if (!res.ok) throw new Error(`createScratchTicket: ${res.status} ${await res.text()}`);
  return res.json();
}

// Archive a scratch ticket (best-effort — a no-op on an already-archived ticket).
export async function archiveTicket(id) {
  await fetch(`${API}/api/tickets/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'archived', actor: 'smoke' }),
  }).catch(() => {});
}