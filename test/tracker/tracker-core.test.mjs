import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import fastify from "fastify";

import {
	createBrowserPrincipalResolver,
	composeControlPlaneTrackerCoreServices,
	registerTrackerCoreCompatibilityRoutes,
} from "../../apps/control-plane/dist/index.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import { createTemporaryHome } from "@golem/testkit";
import { openTrackerDb } from "../../dashboard/server/tracker-db.js";
import { attachTrackerCore } from "../../dashboard/server/tracker-core-attachment.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const trackerClientPath = path.join(repositoryRoot, "mcp/channel/tracker-client.js");
const trackerDbModule = pathToFileURL(path.join(repositoryRoot, "dashboard/server/tracker-db.js")).href;
const persistenceModule = pathToFileURL(path.join(repositoryRoot, "apps/control-plane/dist/persistence.js")).href;
const trackerServicesModule = pathToFileURL(path.join(repositoryRoot, "apps/control-plane/dist/tracker.js")).href;

function childCreateTicket(dbPath, index, readyPath, releasePath) {
	const source = `import { openTrackerDb } from ${JSON.stringify(trackerDbModule)};
import { openControlPlanePersistence } from ${JSON.stringify(persistenceModule)};
import { composeControlPlaneTrackerCoreServices } from ${JSON.stringify(trackerServicesModule)};
const fs = await import('node:fs');
let owner;
let db;
try {
  const root = process.argv[5];
  owner = openControlPlanePersistence({ runtimePath: root + '/child-${index}.runtime.db', trackerPath: process.argv[1], lockPath: root + '/child-${index}.owner.lock' }, { ownerId: 'tracker-core-child-${index}' });
  const services = composeControlPlaneTrackerCoreServices({ writer: owner, clock: { now: () => new Date().toISOString() } });
	db = openTrackerDb(process.argv[1]);
  db.attachTrackerCore(services.compatibility);
  fs.appendFileSync(process.argv[3], '${index}\\n');
  let waits = 0;
  while (!fs.existsSync(process.argv[4])) { if (++waits > 500) throw new Error('release barrier timeout'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
  const ticket = db.createTicket({ project_id: 'process-concurrency', kind: 'fix', title: 'process-${index}', created_by: 'session:child-${index}', priority: 'P1' });
  process.stdout.write(JSON.stringify({ id: ticket.id, display_id: ticket.display_id }));
} catch (error) {
  fs.appendFileSync(process.argv[3], 'ERR-${index}:' + String(error) + '\\n');
  process.stderr.write(String(error));
  process.exitCode = 1;
} finally { db?.close(); owner?.close(); }`;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", source, dbPath, String(index), readyPath, releasePath, path.dirname(readyPath)], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", (error) => reject(new Error(`child process error: ${error?.code ?? error}`)));
		child.once("exit", (code, signal) => {
			if (code !== 0 || signal) return reject(new Error(`child failed code=${code} signal=${signal} stderr=${stderr}`));
			try { resolve(JSON.parse(stdout)); } catch (error) { reject(new Error(`child output invalid: ${error}; stderr=${stderr}`)); }
		});
	});
}

function waitForReady(pathname, count) {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 5_000;
		const poll = () => {
			try {
				if (fs.existsSync(pathname)) {
					const lines = fs.readFileSync(pathname, "utf8").trim().split("\n").filter(Boolean);
					const error = lines.find((line) => line.startsWith("ERR-"));
					if (error) return reject(new Error(`child readiness failed: ${error}`));
					if (lines.length >= count) return resolve();
				}
			} catch (error) { return reject(error); }
			if (Date.now() >= deadline) return reject(new Error("child readiness barrier timed out"));
			setTimeout(poll, 10);
		};
		poll();
	});
}

function opaque(prefix) {
	return `${prefix}_${crypto.randomUUID()}`;
}

function fixtureClock(initial = "2026-07-20T00:00:00.000Z") {
	let current = initial;
	return Object.freeze({
		now: () => current,
		after: (milliseconds) =>
			new Date(Date.parse(current) + milliseconds).toISOString(),
		advance: (milliseconds) => {
			current = new Date(Date.parse(current) + milliseconds).toISOString();
			return current;
		},
	});
}

function createRepresentativeLegacyTracker(file) {
	const legacy = openTrackerDb(file);
	try {
		const parent = legacy.createTicket({ project_id: "legacy-project", kind: "spec", title: "legacy record", body: "unchanged before migration", priority: "P0", labels: ["legacy"], created_by: "human:legacy", wave: 2 });
		const child = legacy.createTicket({ project_id: "legacy-project", kind: "question", title: "legacy child", body: "legacy parent relation", priority: "P1", parent_id: parent.id, created_by: "human:legacy", wave: 2 });
		legacy.addComment(parent.id, { author: "human:legacy", body: "legacy comment", section: "legacy" });
		const comment = legacy.getTicket(parent.id).comments[0];
		legacy.addComment(parent.id, { author: "human:legacy", body: "legacy reply", parent_id: comment.id });
		legacy.addLink(parent.id, child.id, "relates");
		legacy.createStream({ project_id: "legacy-project", name: "legacy stream", mode: "parallel", description: "legacy" });
		return Object.freeze({ parent, child });
	} finally {
		legacy.close();
	}
}

function removePreRepairCommentDispatchRelation(file) {
	const database = new Database(file);
	try {
		database.exec(`
DROP INDEX IF EXISTS idx_comment_dispatches_comment;
DROP INDEX IF EXISTS idx_comment_dispatches_pending;
DROP TABLE IF EXISTS comment_dispatches;
`);
	} finally {
		database.close();
	}
}

function legacyCounts(file) {
	const database = new Database(file, { readonly: true });
	try {
		return Object.freeze({
			tickets: database.prepare("SELECT COUNT(*) AS count FROM tickets").get().count,
			comments: database.prepare("SELECT COUNT(*) AS count FROM comments").get().count,
			streams: database.prepare("SELECT COUNT(*) AS count FROM streams").get().count,
			links: database.prepare("SELECT COUNT(*) AS count FROM links").get().count,
			displayIds: database.prepare("SELECT id, display_id FROM tickets ORDER BY id").all(),
			phaseFacts: database.prepare("SELECT id, state, phase FROM tickets ORDER BY id").all(),
			journal: database.pragma("journal_mode", { simple: true }),
		});
	} finally {
		database.close();
	}
}

function sqliteTableNames(file) {
	const database = new Database(file, { readonly: true });
	try {
		return database
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all()
			.map((row) => row.name);
	} finally {
		database.close();
	}
}

function sqliteSchemaObject(file, type, name) {
	const database = new Database(file, { readonly: true });
	try {
		return database
			.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
			.get(type, name)?.sql;
	} finally {
		database.close();
	}
}

test("tracker core compatibility journey", async () => {
	const home = createTemporaryHome("golem-j4-tracker-core-");
	const clock = fixtureClock();
	const initialHome = process.env.GOLEM_HOME;
	const initialXdg = process.env.XDG_CONFIG_HOME;
	const initialPrincipalCredential =
		process.env.GOLEM_CONTROL_PLANE_PRINCIPAL_CREDENTIAL;
	let writer;
	let app;
	let legacy;
	let legacyWriter;
	let productionAttachment;
	let productionTracker;
	try {
		const freshTrackerPath = path.join(home.root, "fresh-managed-tracker.db");
		const freshRuntimePath = path.join(home.root, "fresh-managed-runtime.db");
		const freshOwner = openControlPlanePersistence(
			{
				runtimePath: freshRuntimePath,
				trackerPath: freshTrackerPath,
				lockPath: path.join(home.root, "fresh-owner.lock"),
			},
			{ clock, ownerId: "fresh-managed-journey" },
		);
		try {
			const freshStatus = freshOwner.status();
			assert.equal(freshStatus.tracker.baseline, "managed", "a fresh tracker is managed on first owner open");
			assert.equal(freshStatus.tracker.userVersion, 6, "a fresh tracker reaches the canonical schema version on first owner open");
			const freshTables = sqliteTableNames(freshTrackerPath);
			for (const table of ["golem_migrations", "tickets", "comments", "comment_dispatches", "browser_principal_bindings", "browser_principal_scopes", "browser_principal_credentials", "browser_principal_sessions", "streams", "links", "events"]) {
				assert.equal(freshTables.includes(table), true, `fresh managed tracker contains canonical ${table} table`);
			}
			const freshPlan = freshOwner.plan("tracker");
			assert.deepEqual(freshPlan.pending, [], "a subsequent fresh managed tracker plan has no pending migrations");
		} finally {
			await freshOwner.close();
		}
		productionTracker = openTrackerDb(freshTrackerPath);
		productionAttachment = attachTrackerCore(productionTracker, freshTrackerPath, clock);
		const productionTicket = productionTracker.createTicket({
			project_id: "production-project",
			kind: "work-item",
			title: "production typed attachment",
			created_by: "human:dashboard",
			priority: "P1",
		});
		const productionEventDb = new Database(freshTrackerPath, { readonly: true });
		try {
			const productionEvent = productionEventDb.prepare("SELECT id, event_uuid, actor, actor_kind, actor_label, data FROM events WHERE ticket_id = ? AND type = 'created' ORDER BY id DESC LIMIT 1").get(productionTicket.id);
			assert(productionEvent?.event_uuid, "production facade create delegated through typed event UUID");
			assert.equal(productionEvent.actor, "human:dashboard", "production typed event preserves the facade actor");
			assert.equal(productionEvent.actor_kind, "human", "production typed event derives actor kind");
			assert.equal(productionEvent.actor_label, "dashboard", "production typed event derives actor label");
			const productionDetails = JSON.parse(productionEvent.data);
			assert.equal(productionDetails.event_id, String(productionEvent.id), "production typed event records its canonical event id");
			assert.equal(productionDetails.outbox_id, String(productionEvent.id), "production typed event derives outbox evidence from its event id");
			assert.equal(productionDetails.resource_id, productionTicket.id, "production typed event records the canonical ticket resource");
		} finally {
			productionEventDb.close();
		}
		assert.equal(
			productionAttachment.services.tickets.get(productionTicket.id)?.ticket.title,
			"production typed attachment",
			"production-style tracker-only attachment sees the shipped facade write",
		);
		const freshComment = productionAttachment.services.comments.add({
			ticketId: productionTicket.id,
			author: "human:dashboard",
			body: "fresh managed tracker phase evidence",
		});
		assert.equal(freshComment.ticketId, productionTicket.id, "fresh managed tracker stores canonical phase evidence before transition");
		const freshUpdated = productionAttachment.services.tickets.update({
			id: productionTicket.id,
			expectedRevision: productionAttachment.services.tickets.get(productionTicket.id).ticket.revision,
			patch: { title: "production typed attachment updated" },
			actor: "human:dashboard",
		});
		const freshTransitioned = productionAttachment.services.tickets.transition({
			id: freshUpdated.id,
			expectedRevision: freshUpdated.revision,
			phase: "building",
			actor: "human:dashboard",
		});
		assert.equal(freshTransitioned.phase, "building", "fresh managed tracker create/update/transition reaches canonical phase evidence without a browser fallback");
		await productionAttachment.close();
		productionAttachment = undefined;
		productionTracker.close();
		productionTracker = undefined;
		const fixture = createRepresentativeLegacyTracker(home.trackerDb);
		removePreRepairCommentDispatchRelation(home.trackerDb);
		const before = legacyCounts(home.trackerDb);
		const beforeBytes = fs.readFileSync(home.trackerDb);
		writer = openControlPlanePersistence(
			{
				runtimePath: home.runtimeDb,
				trackerPath: home.trackerDb,
				lockPath: path.join(home.root, "owner.lock"),
			},
			{ clock, ownerId: "tracker-core-journey" },
		);
		assert.equal(writer.status().tracker.baseline, "unmanaged", "a representative legacy tracker opens read-compatible before explicit migration");
		assert.deepEqual(legacyCounts(home.trackerDb), before, "opening does not change legacy ticket/comment/stream counts or display ids");
		assert.equal(fs.readFileSync(home.trackerDb).compare(beforeBytes), 0, "legacy tracker bytes remain unchanged before explicit migration");

		const plan = writer.plan("tracker");
		assert.equal(plan.pending.some((migration) => migration.id === "tracker/005-comment-dispatches"), true, "dry-run identifies the missing canonical comment-dispatch relation");
		assert.equal(plan.dryRun?.applied.includes("tracker/005-comment-dispatches"), true, "dry-run applies comment-dispatches only to its transactional clone");
		assert.equal(fs.readFileSync(home.trackerDb).compare(beforeBytes), 0, "dry-run leaves the representative existing tracker bytes unchanged");
		const applied = writer.apply("tracker", plan.planHash);
		assert(applied.applied.includes("tracker/003-live-tracker-core"), "explicit migration creates the canonical live tracker tables");
		assert(applied.applied.includes("tracker/005-comment-dispatches"), "explicit migration records the canonical comment-dispatch relation");
		assert(applied.applied.includes("tracker/006-browser-principal-policy"), "explicit migration adds durable opaque principal bindings without rewriting legacy tracker rows");
		const afterApply = legacyCounts(home.trackerDb);
		assert.deepEqual(
			{
				tickets: afterApply.tickets,
				comments: afterApply.comments,
				streams: afterApply.streams,
				links: afterApply.links,
				displayIds: afterApply.displayIds,
				phaseFacts: afterApply.phaseFacts,
			},
			{
				tickets: before.tickets,
				comments: before.comments,
				streams: before.streams,
				links: before.links,
				displayIds: before.displayIds,
				phaseFacts: before.phaseFacts,
			},
			"the migration preserves existing ticket/comment/link/phase evidence counts and identifiers without import",
		);
		assert.equal(sqliteTableNames(home.trackerDb).includes("comment_dispatches"), true, "apply creates the required canonical comment-dispatch relation");
		const commentDispatchSchema = sqliteSchemaObject(home.trackerDb, "table", "comment_dispatches");
		assert.match(commentDispatchSchema, /REFERENCES comments\(id\) ON DELETE CASCADE/u, "the canonical relation cascades from its comment evidence");
		assert.match(commentDispatchSchema, /REFERENCES tickets\(id\) ON DELETE CASCADE/u, "the canonical relation fences its ticket identity");
		assert.match(commentDispatchSchema, /status TEXT NOT NULL DEFAULT 'pending'/u, "the canonical relation preserves pending dispatch defaults");
		assert.match(sqliteSchemaObject(home.trackerDb, "index", "idx_comment_dispatches_pending"), /WHERE status IN \('pending', 'delivered'\)/u, "the canonical relation creates its pending dispatch index");
		await writer.close();
		writer = openControlPlanePersistence(
			{
				runtimePath: home.runtimeDb,
				trackerPath: home.trackerDb,
				lockPath: path.join(home.root, "owner.lock"),
			},
			{ clock, ownerId: "tracker-core-migrated-restart" },
		);
		assert.equal(writer.status().tracker.baseline, "managed", "the upgraded tracker restarts through the managed canonical migration owner");
		const reapply = writer.plan("tracker");
		assert.deepEqual(reapply.pending, [], "a restarted managed schema has no pending tracker mutation");
		assert.deepEqual(writer.apply("tracker", reapply.planHash).applied, [], "idempotent reapply records no tracker mutation");
		let services = composeControlPlaneTrackerCoreServices({ writer, clock });
		assert.equal(services.tickets.get(fixture.parent.display_id)?.ticket.id, fixture.parent.id, "typed lookup resolves the existing display id to its canonical id");
		assert.equal(services.tickets.get(fixture.parent.id)?.comments.length, 2, "typed service reads existing legacy comments and replies");
		assert.equal(services.tickets.get(fixture.parent.id)?.comments.find((comment) => comment.body === "legacy comment")?.anchor?.section, "legacy", "typed service reads existing comment anchor columns");
		assert.equal(services.tickets.get(fixture.parent.id)?.links.length, 1, "typed service reads existing link rows");
		assert.equal(services.tickets.get(fixture.child.display_id)?.ticket.parentId, fixture.parent.id, "typed service preserves existing parent-child ids");
		assert.equal(services.streams.list("legacy-project").length, 1, "explicit migration preserves legacy streams");
		legacy = openTrackerDb(home.trackerDb);
		legacy.attachTrackerCore(services.compatibility);
		assert.equal(legacy.getTicket(fixture.parent.id)?.display_id, fixture.parent.display_id, "the existing shipped tracker facade exposes the same canonical row and display alias");
		assert.equal(legacy.getTicket(fixture.parent.id)?.children?.[0]?.display_id, fixture.child.display_id, "the existing shipped tracker facade preserves child payloads");
		const typedVisibleToLegacy = legacy.createTicket({ project_id: "project-core", kind: "work-item", title: "typed immediately visible", created_by: "session:agent", priority: "P1" });
		assert.equal(services.tickets.get(typedVisibleToLegacy.id)?.ticket.title, "typed immediately visible", "the existing shipped facade delegates a typed write synchronously");
		legacyWriter = openTrackerDb(home.trackerDb);
		const legacyVisibleToTyped = legacyWriter.createTicket({ project_id: "project-core", title: "legacy immediately visible", created_by: "human:legacy", priority: "P2" });
		assert.equal(services.tickets.get(legacyVisibleToTyped.id)?.ticket.title, "legacy immediately visible", "typed service observes an existing legacy write synchronously");
		const stale = services.tickets.get(typedVisibleToLegacy.id).ticket;
		legacyWriter.updateTicket(typedVisibleToLegacy.id, { title: "legacy revision owner", actor: "human:legacy" });
		assert.throws(
			() => services.tickets.update({ id: typedVisibleToLegacy.id, expectedRevision: stale.revision, patch: { title: "stale typed overwrite" }, actor: "session:agent" }),
			(error) => error?.code === "tracker.conflict",
			"canonical event revision rejects a stale typed compare-and-set after a legacy write",
		);
		const semanticTicket = legacy.createTicket({
			project_id: "project-core",
			kind: "work-item",
			title: "full legacy update semantics",
			created_by: "human:legacy",
			priority: "P1",
		});
		const semanticBefore = services.tickets.get(semanticTicket.id).ticket;
		assert.throws(
			() => legacy.updateTicket(semanticTicket.id, { state: "in_progress", title: "" }),
			/title must be nonblank/u,
			"combined lifecycle and ordinary validation rejects before any partial phase mutation",
		);
		assert.deepEqual(
			services.tickets.get(semanticTicket.id).ticket,
			semanticBefore,
			"failed combined update leaves the canonical ticket byte-for-byte unchanged",
		);
		const semanticUpdated = legacy.updateTicket(semanticTicket.id, {
			kind: "fix",
			state: "in_progress",
			title: "full legacy update semantics applied",
			actor: "session:legacy",
		});
		assert.equal(semanticUpdated.kind, "fix", "legacy kind updates are typed and atomic");
		assert.equal(semanticUpdated.state, "in_progress", "legacy state updates are typed and atomic");
		assert.equal(semanticUpdated.phase, "building", "legacy state maps to the canonical phase in the same transaction");
		const semanticAssigned = legacy.updateTicket(semanticTicket.id, {
			assignee: "session:next",
			actor: "session:legacy",
		});
		assert.equal(semanticAssigned.assignee, "session:next", "assignment updates remain visible through the typed projection");
		const semanticDb = new Database(home.trackerDb, { readonly: true });
		try {
			const semanticEvents = semanticDb.prepare("SELECT type, data FROM events WHERE ticket_id = ? ORDER BY id ASC").all(semanticTicket.id);
			assert.equal(semanticEvents.filter((event) => event.type === "state_change").length, 1, "state update preserves specialized state_change event semantics");
			assert.equal(semanticEvents.filter((event) => event.type === "assigned").length, 1, "assignment update preserves specialized assigned event semantics");
			const stateData = JSON.parse(semanticEvents.find((event) => event.type === "state_change").data);
			assert.equal(stateData.from, "todo", "state_change records the prior legacy state");
			assert.equal(stateData.to, "in_progress", "state_change records the next legacy state");
		} finally {
			semanticDb.close();
		}
		const skipParent = legacy.createTicket({ project_id: "project-core", kind: "spec", title: "manager skip parent", created_by: "human:legacy", priority: "P1" });
		const skipTicket = legacy.createTicket({ project_id: "project-core", kind: "work-item", title: "manager skip evidence", parent_id: skipParent.id, created_by: "human:legacy", priority: "P1" });
		legacy.updateTicket(skipTicket.id, { state: "in_progress", actor: "session:legacy" });
		legacy.addComment(skipTicket.id, { author: "human:legacy", body: "Closing brief: ready for manager review." });
		legacy.updateTicket(skipTicket.id, { state: "review", actor: "session:legacy" });
		const beforeUnauthorizedSkip = services.tickets.get(skipTicket.id).ticket;
		const beforeUnauthorizedSkipDb = new Database(home.trackerDb, { readonly: true });
		const beforeUnauthorizedSkipEvents = beforeUnauthorizedSkipDb
			.prepare("SELECT id, type, data FROM events WHERE ticket_id = ? ORDER BY id")
			.all(skipTicket.id);
		beforeUnauthorizedSkipDb.close();
		assert.throws(
			() => services.tickets.update({ id: skipTicket.id, expectedRevision: beforeUnauthorizedSkip.revision, patch: { phase: "done" }, reason: "session:attacker says skip", actor: "session:attacker" }),
			(error) => error?.code === "tracker.phase.invalid",
			"caller-supplied skip reason cannot authorize done",
		);
		assert.deepEqual(
			services.tickets.get(skipTicket.id).ticket,
			beforeUnauthorizedSkip,
			"untrusted exceptional-close text leaves the ticket row unchanged",
		);
		const afterUnauthorizedSkipDb = new Database(home.trackerDb, { readonly: true });
		try {
			assert.deepEqual(
				afterUnauthorizedSkipDb.prepare("SELECT id, type, data FROM events WHERE ticket_id = ? ORDER BY id").all(skipTicket.id),
				beforeUnauthorizedSkipEvents,
				"untrusted exceptional-close text leaves canonical events unchanged",
			);
		} finally {
			afterUnauthorizedSkipDb.close();
		}
		const completionEnvelopeDb = new Database(home.trackerDb);
		completionEnvelopeDb.prepare("INSERT INTO message_envelopes (id, ticket_id, recipient_session_id, kind, payload, status, created_at, delivery_attempted_at) VALUES (?, ?, ?, 'ticket_dispatch', '{}', 'delivered', ?, ?)").run(
			opaque("env"),
			skipTicket.id,
			"human:dashboard",
			clock.now(),
			clock.now(),
		);
		completionEnvelopeDb.close();
		const beforeForgedClose = services.tickets.get(skipTicket.id).ticket;
		const beforeForgedEnvelopeDb = new Database(home.trackerDb, { readonly: true });
		const beforeForgedEnvelope = beforeForgedEnvelopeDb
			.prepare("SELECT completed_at, completed_event_id FROM message_envelopes WHERE ticket_id = ?")
			.get(skipTicket.id);
		beforeForgedEnvelopeDb.close();
		const beforeForgedEventsDb = new Database(home.trackerDb, { readonly: true });
		const beforeForgedEvents = beforeForgedEventsDb
			.prepare("SELECT id, type, topic, data FROM events WHERE ticket_id = ? ORDER BY id")
			.all(skipTicket.id);
		beforeForgedEventsDb.close();
		assert.throws(
			() => legacy.exceptionalCloseTicket({
				id: skipTicket.id,
				expectedRevision: beforeForgedClose.revision,
				reason: "attacker supplied close",
				actor: "session:attacker",
				role: "manager",
				authenticated: true,
				actorContext: { actor: "session:attacker", role: "manager", authenticated: true, source: "mcp" },
			}),
			(error) => error?.code === "tracker.phase.invalid",
			"untrusted compatibility close rejects forged actor/context fields",
		);
		assert.deepEqual(
			services.tickets.get(skipTicket.id).ticket,
			beforeForgedClose,
			"forged exceptional-close request leaves the ticket row unchanged",
		);
		const afterForgedEnvelope = new Database(home.trackerDb, { readonly: true });
		try {
			assert.deepEqual(
				afterForgedEnvelope
					.prepare("SELECT completed_at, completed_event_id FROM message_envelopes WHERE ticket_id = ?")
					.get(skipTicket.id),
				beforeForgedEnvelope,
				"forged exceptional-close request leaves envelope settlement unchanged",
			);
		} finally {
			afterForgedEnvelope.close();
		}
		const afterForgedEventsDb = new Database(home.trackerDb, { readonly: true });
		try {
			assert.deepEqual(
				afterForgedEventsDb
					.prepare("SELECT id, type, topic, data FROM events WHERE ticket_id = ? ORDER BY id")
					.all(skipTicket.id),
				beforeForgedEvents,
				"forged exceptional-close request leaves canonical events unchanged",
			);
		} finally {
			afterForgedEventsDb.close();
		}
		productionAttachment = attachTrackerCore(legacy, home.trackerDb, clock);
		const authorizedSkip = legacy.exceptionalCloseTicket({
			id: skipTicket.id,
			expectedRevision: beforeForgedClose.revision,
			reason: "server-composed exceptional close",
		});
		assert.equal(authorizedSkip.phase, "done", "trusted dashboard compatibility authority authorizes exceptional close");
		assert.throws(
			() => legacy.exceptionalCloseTicket({
				id: skipTicket.id,
				expectedRevision: beforeForgedClose.revision,
				reason: "replayed close",
			}),
			(error) => error?.code === "tracker.conflict",
			"exceptional close authorization is one-step and cannot be replayed at an old revision",
		);
		const lifecycleDb = new Database(home.trackerDb, { readonly: true });
		try {
			const lifecycleRow = lifecycleDb.prepare("SELECT state, done_at FROM tickets WHERE id = ?").get(skipTicket.id);
			assert.equal(lifecycleRow.state, "done", "typed lifecycle update persists terminal state");
			assert.equal(typeof lifecycleRow.done_at, "string", "typed lifecycle update stamps done_at");
			const settledEnvelope = lifecycleDb.prepare("SELECT completed_at, completed_event_id FROM message_envelopes WHERE ticket_id = ?").get(skipTicket.id);
			assert.equal(typeof settledEnvelope.completed_at, "string", "terminal typed lifecycle settles the dispatched envelope");
			assert.equal(typeof settledEnvelope.completed_event_id, "number", "dispatch settlement points at the canonical completion event");
			const completion = lifecycleDb.prepare("SELECT id, type FROM events WHERE ticket_id = ? AND topic = ? AND type = 'dispatch_completion_stamped' ORDER BY id DESC LIMIT 1").get(skipTicket.id, `ticket/${authorizedSkip.display_id}`);
			assert.equal(settledEnvelope.completed_event_id, completion.id, "dispatch settlement stores the exact canonical completion event id");
			const authorization = lifecycleDb.prepare("SELECT data FROM events WHERE ticket_id = ? AND type = 'manager_skip_authorized' ORDER BY id DESC LIMIT 1").get(skipTicket.id);
			assert.equal(JSON.parse(authorization.data).target_phase, "done", "trusted close persists revision-bound authorization evidence");
		} finally {
			lifecycleDb.close();
		}
		await productionAttachment.close();
		productionAttachment = undefined;
		await writer.close();
		writer = undefined;
		legacy.close();
		legacy = undefined;
		legacyWriter.close();
		legacyWriter = undefined;
		const readyPath = path.join(home.root, "children.ready");
		const releasePath = path.join(home.root, "children.release");
		const firstChild = childCreateTicket(home.trackerDb, 1, readyPath, releasePath);
		await waitForReady(readyPath, 1);
		const secondChild = childCreateTicket(home.trackerDb, 2, readyPath, releasePath);
		await waitForReady(readyPath, 2);
		fs.writeFileSync(releasePath, "release\n");
		const processCreates = await Promise.all([firstChild, secondChild]);
		const processDisplays = processCreates.map((ticket) => ticket.display_id).sort();
		assert.equal(new Set(processDisplays).size, 2, "independent SQLite child connections allocate unique display ids");
		assert.equal(Number(processDisplays[1].split("-").at(-1)) - Number(processDisplays[0].split("-").at(-1)), 1, "independent SQLite child connections allocate monotonic display ids");
		const processCheck = new Database(home.trackerDb, { readonly: true });
		assert.equal(processCheck.pragma("integrity_check", { simple: true }), "ok", "independent child writes preserve SQLite integrity");
		processCheck.close();
		writer = openControlPlanePersistence(
			{ runtimePath: home.runtimeDb, trackerPath: home.trackerDb, lockPath: path.join(home.root, "owner.lock") },
			{ clock, ownerId: "tracker-core-reopened" },
		);
		services = composeControlPlaneTrackerCoreServices({ writer, clock });
		legacy = openTrackerDb(home.trackerDb);
		legacy.attachTrackerCore(services.compatibility);
		legacyWriter = openTrackerDb(home.trackerDb);
		assert.doesNotThrow(() => services.tickets.get(processCreates[0].id), "typed read remains valid after child connections close");
		assert.doesNotThrow(() => legacy.createTicket({ project_id: "process-concurrency", kind: "fix", title: "post-child probe", created_by: "session:probe", priority: "P1" }), "typed delegate remains writable after child connections close");

		const principalCredential = "tracker-core-bound-principal-000000000000";
		const principals = writer.browserPrincipalStorage();
		principals.provision({
			id: "principal_tracker_core_journey",
			actorId: "session:agent",
			role: "operator",
			defaultProjectId: "project-core",
			scopeProjectIds: ["project-core"],
		});
		principals.bindCredential({
			bindingId: "principal_tracker_core_journey",
			adapter: "bearer",
			credential: principalCredential,
		});
		const principalResolver = createBrowserPrincipalResolver({
			storage: principals,
			clock: { now: () => Date.parse(clock.now()) },
		});
		app = fastify();
		registerTrackerCoreCompatibilityRoutes({
			app,
			tracker: services.compatibility,
			principal: principalResolver,
		});
		const address = await app.listen({ host: "127.0.0.1", port: 0 });
		fs.writeFileSync(path.join(home.root, "dashboard.json"), JSON.stringify({ url: address }));
		process.env.GOLEM_HOME = home.root;
		process.env.XDG_CONFIG_HOME = path.join(home.root, "xdg");
		process.env.GOLEM_CONTROL_PLANE_PRINCIPAL_CREDENTIAL = principalCredential;
		const client = await import(`${pathToFileURL(trackerClientPath).href}?tracker-core=${Date.now()}`);

		const created = await client.createTicket({
			project_id: "project-core",
			kind: "work-item",
			title: "typed core through MCP HTTP client",
			body: "real SQLite + Fastify compatibility boundary",
			assignee: "session:agent",
			created_by: "session:agent",
			rank: 7,
			wave: 5,
		});
		assert.match(created.id, /^TKT-\d+$/u, "concurrent-safe allocator returns the canonical live TKT id");
		assert.match(created.display_id, /^PRO-\d+$/u, "the legacy facade retains the per-project display id");
		assert.equal(created.rank, 7, "legacy facade preserves typed rank");
		assert.equal(created.wave, 5, "legacy facade preserves typed wave");
		assert.equal((await client.getTicket(created.id)).title, "typed core through MCP HTTP client", "MCP tracker client gets the compatibility facade record");
		assert.equal((await client.listTickets({ project: "project-core" })).some((ticket) => ticket.id === created.id), true, "MCP list parity uses the typed compatibility route");
		assert.equal((await client.updateTicket(created.id, { state: "in_progress", actor: "session:agent" })).phase, "building", "legacy state update maps through canonical phase validation");
		const comment = await client.addComment(created.id, { author: "session:agent", body: "anchored core comment", anchor: { section: "acceptance", offset: 3 } });
		const reply = await client.replyComment(created.id, comment.id, { author: "session:agent", body: "nested reply" });
		assert.equal(reply.parent_id, comment.id, "legacy reply shape preserves the typed parent relation");
		assert.equal(services.tickets.get(created.id).comments.find((entry) => entry.id === comment.id)?.anchor?.section, "acceptance", "anchored comments retain their semantic anchor through the facade");
		const ticketRevisionBeforeStream = services.tickets.get(created.id).ticket.revision;
		const stream = await client.createStream({ project_id: "project-core", name: "wave-five", mode: "parallel", description: "typed stream" });
		assert.equal((await client.listStreams("project-core")).some((entry) => entry.id === stream.id), true, "stream routes keep tracker-client legacy payloads");
		assert.equal(services.tickets.get(created.id).ticket.revision, ticketRevisionBeforeStream, "stream creation does not advance an unrelated ticket revision");
		legacy.createStream({ project_id: "empty-project", name: "empty project stream", mode: "parallel", description: "project event" });
		const emptyProjectEvent = new Database(home.trackerDb, { readonly: true });
		try {
			assert.deepEqual(emptyProjectEvent.prepare("SELECT topic, ticket_id FROM events WHERE project_id = ? AND type = 'stream_created' ORDER BY id DESC LIMIT 1").get("empty-project"), { topic: "project/empty-project/events", ticket_id: null }, "empty-project stream mutation emits a project-scoped event without a ticket topic");
		} finally {
			emptyProjectEvent.close();
		}
		legacy.updateComment(created.id, comment.id, { body: "updated through shipped facade", actor: "human:legacy" });
		assert.equal(services.tickets.get(created.id).comments.find((entry) => entry.id === comment.id)?.body, "updated through shipped facade", "shipped facade comment update is immediately typed-visible");
		legacy.updateStream(stream.id, { name: "wave-five-updated", actor: "human:legacy" });
		const updatedStream = services.streams.list("project-core").find((entry) => entry.id === stream.id);
		assert.equal(updatedStream?.name, "wave-five-updated", "shipped facade stream update is immediately typed-visible");
		assert(updatedStream && updatedStream.revision > stream.revision, "stream updates advance the stream-scoped event revision");
		assert.throws(
			() => services.streams.upsert({ id: stream.id, projectId: "project-core", name: "stale stream", expectedRevision: stream.revision, actor: "session:agent" }),
			(error) => error?.code === "tracker.conflict",
			"stale stream writes cannot fall back to the legacy mutation path",
		);
		const typedChild = services.tickets.create({ projectId: "legacy-project", kind: "work-item", title: "typed spec child", parentId: fixture.parent.id, actor: "session:agent" });
		assert.equal(services.tickets.get(typedChild.id)?.ticket.parentId, fixture.parent.id, "typed child uses the canonical parent row");

		const parallel = await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				fetch(`${address}/api/tickets`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${principalCredential}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ kind: "fix", title: `parallel-${index}`, priority: "P1" }),
				}).then((response) => response.json()),
			),
		);
    const parallelNumbers = parallel.map((ticket) => Number(String(ticket.display_id).split("-").at(-1))).sort((left, right) => left - right);
		assert.equal(new Set(parallelNumbers).size, 8, "parallel HTTP creates allocate unique display ids");
		assert.deepEqual(parallelNumbers, Array.from({ length: 8 }, (_, index) => parallelNumbers[0] + index), "parallel display ids are monotonic without gaps from concurrent requests");
		const linkResponse = await fetch(`${address}/api/tickets/${created.id}/links`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${principalCredential}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ target_ticket_id: parallel[0].id, relation: "relates" }),
		});
		assert.equal(linkResponse.status, 200, "parent/link compatibility route persists a typed link");
		assert.equal(services.tickets.get(created.id).links.length, 1, "typed ticket projection includes the legacy-compatible link");
		legacy.removeLink(created.id, parallel[0].id, "relates", { actor: "human:legacy" });
		assert.equal(services.tickets.get(created.id).links.length, 0, "shipped facade link delete is immediately typed-visible");

		const revisionConflict = await fetch(`${address}/api/tickets/${created.id}`, {
			method: "PATCH",
			headers: {
				authorization: `Bearer ${principalCredential}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ title: "stale", expected_revision: 1 }),
		});
		assert.equal(revisionConflict.status, 409, "bad ticket revision returns the stable conflict status");
		const illegalPhase = await fetch(`${address}/api/tickets/${created.id}/transition`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${principalCredential}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ phase: "built" }),
		});
		assert.equal(illegalPhase.status, 400, "phase artifact/legality failures stay at the typed service boundary");
		const artifactBypass = services.tickets.get(created.id).ticket;
		assert.throws(
			() => services.tickets.transition({ id: created.id, expectedRevision: artifactBypass.revision, phase: "built", artifacts: { closingBrief: true }, actor: "session:agent" }),
			(error) => error?.code === "tracker.phase.invalid",
			"caller-supplied truthy phase artifacts cannot bypass durable evidence",
		);
		const phasePaths = [
			{
				kind: "work-item",
				phases: [
					["building", {}],
					["built", { closingBrief: true }],
					["verifying", { managerDispatch: true }],
					["verified", { verificationReport: true }],
					["done", { verifiedOrSkipReason: true }],
				],
			},
			{
				kind: "spec",
				phases: [
					["grounding", {}],
					["grounded", { groundingSummary: true }],
					["designing", {}],
					["designed", { design: true, concerns: true }],
					["planning", { humanFinalise: true }],
					["planned", { children: true, waves: true }],
					["building", { childStarted: true }],
					["done", { childrenTerminal: true }],
				],
			},
			{ kind: "question", phases: [["answered", { answerComment: true }], ["closed", {}]] },
			{ kind: "decision", phases: [["decided", { decisionComment: true }], ["closed", {}]] },
			{ kind: "fix", phases: [["blocked", { reason: true }], ["building", {}]] },
		];
		for (const phasePath of phasePaths) {
			let ticket = services.tickets.create({ projectId: "project-core", kind: phasePath.kind, title: `phase path ${phasePath.kind}`, actor: "session:agent" });
			let child;
			for (const [phase, artifacts] of phasePath.phases) {
				const evidence = phase === "built" ? "closing brief" : phase === "verified" ? "verification report" : phase === "answered" ? "answer" : phase === "decided" ? "decision decided" : phase === "grounded" ? "grounding summary" : phase === "designed" ? "design concerns" : phase === "planning" ? "human finalise" : phase === "blocked" ? "blocked reason" : undefined;
				if (evidence) {
					services.comments.add({ ticketId: ticket.id, author: phase === "planning" ? "human:manager" : "session:agent", body: evidence });
					ticket = services.tickets.get(ticket.id).ticket;
				}
				if (phase === "verifying") {
					legacyWriter.queueDispatch(ticket.id, { session_id: "session:manager", actor: "human:manager" });
					ticket = services.tickets.get(ticket.id).ticket;
					assert.equal(legacy.getTicket(ticket.id)?.has_pending_dispatch, true, "the existing shipped tracker facade preserves pending-dispatch fields");
					assert(legacy.getTicket(ticket.id)?.pending_dispatch, "the existing shipped tracker facade preserves the pending-dispatch payload");
					legacyWriter.setDispatched(ticket.id, { session_id: "session:manager", actor: "human:manager" });
					ticket = services.tickets.get(ticket.id).ticket;
				}
				if (phase === "planned" && phasePath.kind === "spec") {
					child = legacyWriter.createTicket({ project_id: "project-core", kind: "work-item", title: "spec child", parent_id: ticket.id, wave: 1, created_by: "human:manager" });
				}
				if (phase === "building" && child) legacyWriter.updateTicket(child.id, { state: "in_progress", actor: "human:manager" });
				if (phase === "done" && child) legacyWriter.updateTicket(child.id, { state: "done", actor: "human:manager" });
				ticket = services.tickets.transition({ id: ticket.id, expectedRevision: ticket.revision, phase, artifacts, actor: "session:agent" });
			}
		}
		const updated = services.tickets.get(created.id).ticket;
		assert.throws(
			() =>
				services.tickets.update({
					id: created.id,
					expectedRevision: updated.revision,
					patch: { runtimeReference: { projectId: "project-core" } },
					actor: "session:agent",
				}),
			(error) => error?.code === "tracker.runtime_reference.invalid",
			"tracker rejects path/name-like runtime references instead of deciding readiness or aliases",
		);
		const runtimeTicket = services.tickets.create({
			projectId: "project-core",
			kind: "question",
			title: "opaque runtime reference only",
			actor: "session:agent",
			runtimeReference: { projectId: opaque("prj"), sessionId: opaque("ses"), generationId: opaque("gen") },
		});
		assert.equal("runtimeReference" in runtimeTicket, false, "opaque external runtime references are validated but never persisted as tracker authority");
		const audit = writer.trackerCoreStorage().auditCore();
		const database = new Database(home.trackerDb, { readonly: true });
		try {
			const events = database.prepare("SELECT COUNT(*) AS count FROM events WHERE class = 'tracker' AND event_uuid IS NOT NULL").get().count;
			assert.equal(audit.length, events, "every typed mutation uses the existing event/audit authority");
			assert(events > 0, "typed mutations commit canonical tracker events");
			const typedAudit = audit.find((entry) => entry.action === "created" && entry.actor === "session:agent");
			assert(typedAudit, "typed event audit preserves the actor identity");
			assert.equal(typedAudit.id, String(typedAudit.details.event_id), "audit identity is the canonical event id");
			assert.equal(String(typedAudit.details.outbox_id), String(typedAudit.details.event_id), "outbox evidence derives from the canonical event id");
			const typedEvent = database.prepare("SELECT topic, actor_kind, actor_label FROM events WHERE ticket_id = ? AND topic = ? AND type = 'created' ORDER BY id DESC LIMIT 1").get(typedChild.id, `ticket/${typedChild.displayId}`);
			assert.deepEqual(typedEvent, { topic: `ticket/${typedChild.displayId}`, actor_kind: "session", actor_label: "agent" }, "typed events preserve display topic and derived actor label");
			assert.equal(database.prepare("SELECT COUNT(*) AS count FROM events WHERE topic = ? AND ticket_id = ?").get(`spec/${fixture.parent.display_id}/tree`, typedChild.id).count, 1, "spec child mutations mirror onto the existing spec-tree topic");
		} finally {
			database.close();
		}
	} finally {
		if (productionAttachment) await productionAttachment.close();
		if (productionTracker) productionTracker.close();
		if (app) await app.close();
		if (legacyWriter) legacyWriter.close();
		if (legacy) legacy.close();
		if (writer) await writer.close();
		if (initialHome === undefined) delete process.env.GOLEM_HOME;
		else process.env.GOLEM_HOME = initialHome;
		if (initialXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = initialXdg;
		if (initialPrincipalCredential === undefined)
			delete process.env.GOLEM_CONTROL_PLANE_PRINCIPAL_CREDENTIAL;
		else
			process.env.GOLEM_CONTROL_PLANE_PRINCIPAL_CREDENTIAL =
				initialPrincipalCredential;
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false, "tracker core journey cleans its temporary home");
	}
});
