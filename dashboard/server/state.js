// Owns in-memory dashboard state for ALL projects.
// - Maintains one journal store per project.
// - Loads tickets per project (re-read on tracker/ change).
// - Exposes snapshot() for REST + WS-init.
// - Watches files via chokidar; on change, refreshes minimal state and emits
//   delta events that the WS layer broadcasts.
//
// Event taxonomy emitted to listeners:
//   { type: 'project-update', project }
//   { type: 'agents-update',  projectId, agents }      // full agent list for that project
//   { type: 'agent-detail',   projectId, agent }       // a single agent's full record (journal+hooks)
//   { type: 'tickets-update', projectId, tickets }
//   { type: 'projects-list',  projects }               // when discovery rescans
//
// Coarse-grained agents-update + tickets-update are simpler than per-event
// diffs and are still cheap given the data sizes we expect.

import { EventEmitter } from 'node:events';
import path from 'node:path';
import chokidar from 'chokidar';
import { CONFIG } from './config.js';
import { discoverProjects } from './projects.js';
import { createJournalStore } from './journal.js';
import { readTickets, ticketProgress } from './tracker.js';
import { orchestratorSnapshot, readDeadSessionIds } from './orchestrator.js';

export function createState() {
  const ee = new EventEmitter();
  ee.setMaxListeners(64);

  /** @type {Map<string, ReturnType<typeof createJournalStore>>} */
  const stores = new Map();
  /** @type {Map<string, any[]>} */
  const tickets = new Map();
  /** @type {any[]} */
  let projects = [];
  /** @type {Map<string, any>} */
  const projectsById = new Map();

  let watcher = null;
  let rediscoverTimer = null;
  let orchestratorTimer = null;
  /** Last computed orchestrator snapshot (so REST can return without async). */
  let orchestratorState = { ceo: null, sessions: [], workspaces: [], headlineMemo: null, gates: [], gateCounts: { awaiting: 0, approved: 0, denied: 0, cancelled: 0, total: 0 } };
  /** Session_ids the registry has marked dead — used to demote ghost CEO agents. */
  let deadSessionIds = new Set();
  // Coalesce file events (chokidar fires "change" for every fs.write tick).
  const refreshTimers = new Map();

  function projectSummary(p) {
    const store = stores.get(p.id);
    const ts = tickets.get(p.id) ?? [];
    const agents = store ? store.snapshotAgents({ deadSessionIds }) : [];
    const live = agents.filter((a) => a.status === 'active' || a.status === 'running').length;
    return {
      id: p.id,
      kind: p.kind,
      name: p.name,
      glyph: p.glyph,
      color: p.color,
      description: p.description,
      progress: ticketProgress(ts),
      total_agents: agents.length,
      live_agents: live,
      total_tickets: ts.length,
      has_journal: !!p.hasJournal,
    };
  }

  function snapshot() {
    return {
      projects: projects.filter((p) => (p.kind === 'project' || p.kind === 'root' || p.kind === 'external')).map(projectSummary),
      workspaces: projects.map(projectSummary),
      orchestrator: orchestratorState,
      agents: [].concat(...[...stores.values()].map((s) => s.snapshotAgents({ deadSessionIds }))),
      tickets: [].concat(...tickets.values()),
    };
  }

  function projectAgents(projectId) {
    const s = stores.get(projectId);
    return s ? s.snapshotAgents({ deadSessionIds }) : [];
  }

  function agentDetail(projectId, agentId) {
    const s = stores.get(projectId);
    return s ? s.snapshotAgentDetail(agentId) : null;
  }

  function projectTickets(projectId) {
    return tickets.get(projectId) ?? [];
  }

  function project(id) {
    return projectsById.get(id) ?? null;
  }

  async function refreshTickets(projectId) {
    const p = projectsById.get(projectId);
    if (!p) return;
    const ts = await readTickets(p);
    tickets.set(projectId, ts);
    ee.emit('event', { type: 'tickets-update', projectId, tickets: ts });
    ee.emit('event', { type: 'project-update', project: projectSummary(p) });
  }

  async function refreshJournal(projectId) {
    const s = stores.get(projectId);
    const p = projectsById.get(projectId);
    if (!s || !p) return;
    await s.refresh();
    ee.emit('event', {
      type: 'agents-update',
      projectId,
      agents: s.snapshotAgents(),
    });
    ee.emit('event', { type: 'project-update', project: projectSummary(p) });
  }

  function debouncedRefresh(key, fn, delay = 80) {
    const existing = refreshTimers.get(key);
    if (existing) clearTimeout(existing);
    refreshTimers.set(
      key,
      setTimeout(() => {
        refreshTimers.delete(key);
        fn().catch((err) => console.error(`[refresh:${key}]`, err));
      }, delay),
    );
  }

  function watchedPaths() {
    const paths = [];
    for (const p of projects) {
      if ((p.kind === 'project' || p.kind === 'root' || p.kind === 'external')) {
        paths.push(p.hookFile);
        paths.push(p.summaryFile);
        paths.push(p.trackerDir);
      }
      paths.push(p.gatesDir);
    }
    return paths;
  }

  async function refreshOrchestrator() {
    try {
      const [snap, dead] = await Promise.all([
        orchestratorSnapshot(projects),
        readDeadSessionIds(),
      ]);
      orchestratorState = snap;
      // Detect transitions so we can poke agent panels that newly have ghosts.
      const newlyDead = new Set();
      for (const sid of dead) if (!deadSessionIds.has(sid)) newlyDead.add(sid);
      deadSessionIds = dead;
      ee.emit('event', { type: 'orchestrator-update', orchestrator: orchestratorState });
      if (newlyDead.size > 0) {
        for (const p of projects) {
          if (p.kind !== 'project' && p.kind !== 'root' && p.kind !== 'external') continue;
          ee.emit('event', {
            type: 'agents-update',
            projectId: p.id,
            agents: projectAgents(p.id),
          });
        }
      }
    } catch (err) {
      console.error('[orchestrator]', err);
    }
  }

  async function rediscover() {
    const next = await discoverProjects();
    const nextIds = new Set(next.map((p) => p.id));
    const prevIds = new Set(projects.map((p) => p.id));

    // Remove projects that disappeared.
    for (const id of prevIds) {
      if (!nextIds.has(id)) {
        stores.delete(id);
        tickets.delete(id);
        projectsById.delete(id);
      }
    }
    // Add new workspaces. Only kind='project' gets a journal store + tickets.
    for (const p of next) {
      if (!prevIds.has(p.id)) {
        if ((p.kind === 'project' || p.kind === 'root' || p.kind === 'external')) {
          const s = createJournalStore(p);
          await s.bootstrap();
          stores.set(p.id, s);
          const ts = await readTickets(p);
          tickets.set(p.id, ts);
        } else {
          tickets.set(p.id, []);
        }
      }
      projectsById.set(p.id, p);
    }
    projects = next;

    // Re-attach the watcher so newly-added/removed files are observed.
    if (watcher) {
      await watcher.close();
      watcher = null;
    }
    watcher = chokidar.watch(watchedPaths(), {
      persistent: true,
      ignoreInitial: true,
      depth: 4,
      // Tracker dirs see lots of file moves; smooth them out.
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 40 },
    });

    watcher
      .on('add', onTrackerOrJournalChange)
      .on('change', onTrackerOrJournalChange)
      .on('unlink', onTrackerOrJournalChange)
      .on('addDir', onTrackerOrJournalChange)
      .on('unlinkDir', onTrackerOrJournalChange)
      .on('error', (err) => console.error('[watcher]', err));

    ee.emit('event', { type: 'projects-list', projects: projects.map(projectSummary) });
  }

  function onTrackerOrJournalChange(filePath) {
    // Determine which workspace this path belongs to and which subsystem.
    for (const p of projects) {
      if ((p.kind === 'project' || p.kind === 'root' || p.kind === 'external')) {
        if (filePath === p.hookFile || filePath === p.summaryFile) {
          debouncedRefresh(`journal:${p.id}`, () => refreshJournal(p.id));
          return;
        }
        if (filePath.startsWith(p.trackerDir + path.sep) || filePath === p.trackerDir) {
          debouncedRefresh(`tracker:${p.id}`, () => refreshTickets(p.id));
          return;
        }
      }
      if (filePath === p.gatesDir || filePath.startsWith(p.gatesDir + path.sep)) {
        debouncedRefresh('orchestrator', refreshOrchestrator, 200);
        return;
      }
    }
  }

  async function init() {
    await rediscover();
    await refreshOrchestrator();
    // Polling rediscovery every 30s catches new projects added under
    // GOLEM_PROJECTS_ROOT after the dashboard starts.
    rediscoverTimer = setInterval(() => {
      rediscover().catch((err) => console.error('[rediscover]', err));
    }, 30_000);

    // Periodic refresh tick: status transitions from "active" → "done" are
    // time-driven (no explicit event), so we re-emit at low frequency.
    setInterval(() => {
      for (const p of projects) {
        if (p.kind !== 'project') continue;
        ee.emit('event', {
          type: 'agents-update',
          projectId: p.id,
          agents: projectAgents(p.id),
        });
      }
    }, 5_000);

    // Orchestrator tick: CEO session liveness + memo discovery is poll-based
    // (we don't watch ~/.claude/projects/ — sessions append constantly).
    orchestratorTimer = setInterval(() => {
      refreshOrchestrator();
    }, 3_000);
  }

  async function close() {
    if (watcher) await watcher.close();
    if (rediscoverTimer) clearInterval(rediscoverTimer);
    if (orchestratorTimer) clearInterval(orchestratorTimer);
    for (const t of refreshTimers.values()) clearTimeout(t);
    refreshTimers.clear();
  }

  return {
    init,
    close,
    on: (...args) => ee.on(...args),
    off: (...args) => ee.off(...args),
    snapshot,
    projects: () => projects.filter((p) => (p.kind === 'project' || p.kind === 'root' || p.kind === 'external')).map(projectSummary),
    workspaces: () => projects.map(projectSummary),
    project,
    projectAgents,
    agentDetail,
    projectTickets,
    orchestrator: () => orchestratorState,
    refreshOrchestrator,
  };
}
