import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import WebSocket from "ws";

import {
	createBrowserControlPlaneClient,
	createBrowserWorkSynchronizer,
	createFetchApiClient,
} from "../../packages/api-client/dist/index.js";
import { invokeMcpTool } from "../../packages/mcp-adapter/dist/index.js";
import {
	BrowserWorkWebSocketFrameSchema,
} from "@golem/contracts";
import { createSessionService } from "@golem/runtime";
import { createTemporaryHome } from "@golem/testkit";
import { createBrowserPrincipalResolver } from "../../apps/control-plane/dist/auth.js";
import { createBrowserWorkServices } from "../../apps/control-plane/dist/browser-work-services.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import { startControlPlane } from "../../apps/control-plane/dist/server.js";
import {
	composeControlPlaneCommandGateway,
	composeControlPlaneEndpointEligibility,
	composeControlPlaneManagementServices,
	composeControlPlaneTicketDispatchService,
	composeControlPlaneTrackerCoreServices,
	composeControlPlaneTrackerServices,
} from "../../apps/control-plane/dist/tracker.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const projectId = "prj_00000000-0000-4000-8000-000000000082";
const foreignProjectId = "prj_00000000-0000-4000-8000-000000000083";
const sessionId = "ses_00000000-0000-4000-8000-000000000082";
const generationId = "gen_00000000-0000-4000-8000-000000000082";
const reassignedSessionId = "ses_00000000-0000-4000-8000-000000000084";
const reassignedGenerationId = "gen_00000000-0000-4000-8000-000000000084";
const token = "golem-gol82-ticket-dispatch-token-000000";
const mcpToken = "golem-gol82-ticket-dispatch-mcp-token-0000";
const browserSession = "gol82_browser_session";
const browserCsrf = "gol82_browser_csrf_012345678901234567890";
const foreignSession = "gol82_foreign_browser_session";
const foreignCsrf = "gol82_foreign_browser_csrf_012345678901234";

function clock() {
	let value = "2026-07-23T16:00:00.000Z";
	return {
		now: () => value,
		after: (milliseconds) => new Date(Date.parse(value) + milliseconds).toISOString(),
		advance: (milliseconds) => {
			value = new Date(Date.parse(value) + milliseconds).toISOString();
			return value;
		},
	};
}

function runtimeSignal(sequence, activeSessionId = sessionId, activeGenerationId = generationId) {
	return {
		schema_version: "golem.runtime-signal/v1",
		event_id: `evt_00000000-0000-4000-8000-${String(8200 + sequence).padStart(12, "0")}`,
		event_kind: "session.started",
		producer: "gol82-journey",
		producer_instance_id: "prod_00000000-0000-4000-8000-000000000082",
		producer_sequence: sequence,
		harness: "codex",
		correlation_id: "cor_00000000-0000-4000-8000-000000000082",
		deduplication_key: `gol82-session-${sequence}`,
		clocks: {
			source_observed_at: "2026-07-23T16:00:00.000Z",
			received_at: "2026-07-23T16:00:00.000Z",
			materialized_at: "2026-07-23T16:00:00.000Z",
		},
		provenance: { source: "journey", confidence: "verified", evidence_id: "gol82" },
		clear_fields: [],
		payload: {
			kind: "session.started",
			generation: {
				project_id: projectId,
				session_id: activeSessionId,
				generation_id: activeGenerationId,
			},
			metadata: { role: "builder" },
		},
	};
}

function browserHeaders(origin, session = browserSession, csrf = browserCsrf) {
	return {
		origin,
		cookie: `golem_control_plane_session=${session}`,
		"x-golem-csrf": csrf,
		"content-type": "application/json",
	};
}

function browserCookieJar() {
	let cookie;
	return {
		getCookie: () => cookie,
		setCookie: (setCookie) => {
			const pair = setCookie.split(";", 1)[0];
			assert.ok(pair?.startsWith("golem_control_plane_session="));
			cookie = pair;
		},
	};
}

function bearerHeaders() {
	return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function json(origin, route, options = {}) {
	const response = await fetch(`${origin}${route}`, options);
	return { status: response.status, body: await response.json() };
}

function nextFrame(socket) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("browser delivery frame timed out")), 4_000);
		const onMessage = (raw) => {
			clearTimeout(timer);
			socket.off("error", onError);
			resolve(String(raw));
		};
		const onError = (error) => {
			clearTimeout(timer);
			socket.off("message", onMessage);
			reject(error);
		};
		socket.once("message", onMessage);
		socket.once("error", onError);
	});
}

function noFrame(socket, milliseconds = 175) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.off("message", onMessage);
			resolve();
		}, milliseconds);
		const onMessage = (raw) => {
			clearTimeout(timer);
			reject(new Error(`off-scope delivery timing leaked: ${String(raw)}`));
		};
		socket.once("message", onMessage);
	});
}

function assertSafeDispatchProjection(value, message) {
	const serialized = JSON.stringify(value);
	for (const forbidden of [
		'"recipient_id"',
		'"session_id"',
		'"generation_id"',
		'"endpoint"',
		'"fence"',
		'"claim_owner"',
		'"claim_token"',
		'"acknowledgement_id"',
		'"envelope_id"',
		'"payload"',
		'"result"',
		'"note"',
		'"workspace"',
		sessionId,
		generationId,
		"GOL89_HOSTILE_PAYLOAD",
	])
		assert.equal(
			serialized.includes(forbidden),
			false,
			`${message}: ${forbidden} stays outside the browser projection`,
		);
}

function projectedDispatch(projection, commandId) {
	return projection?.items?.find(
		(item) =>
			item.operation_kind === "dispatch" && item.opaque_id === commandId,
	);
}

function queueCounts(home) {
	const database = new Database(home.trackerDb, { readonly: true, fileMustExist: true });
	try {
		const envelopes = database
			.prepare("SELECT COUNT(*) AS count FROM tracker_envelopes")
			.get().count;
		const queue = database
			.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_queue'")
			.get().count
			? database.prepare("SELECT COUNT(*) AS count FROM dispatch_queue").get().count
			: 0;
		return { envelopes: Number(envelopes), dispatchQueue: Number(queue) };
	} finally {
		database.close();
	}
}

function envelopePayload(home, ticketId) {
	const database = new Database(home.trackerDb, { readonly: true, fileMustExist: true });
	try {
		const row = database
			.prepare(
				"SELECT payload_json FROM tracker_envelopes WHERE kind = 'ticket_dispatch' ORDER BY created_at DESC, id DESC",
			)
			.all()
			.map((candidate) => JSON.parse(candidate.payload_json))
			.find((payload) => payload.ticket_id === ticketId);
		return row;
	} finally {
		database.close();
	}
}

function envelopeRecipient(home, ticketId, idempotencyKey) {
	const database = new Database(home.trackerDb, { readonly: true, fileMustExist: true });
	try {
		const row = database
			.prepare(
				"SELECT recipient_id, payload_json FROM tracker_envelopes WHERE kind = 'ticket_dispatch' AND idempotency_key = ? ORDER BY created_at DESC, id DESC",
			)
			.all(idempotencyKey)
			.find((candidate) => JSON.parse(candidate.payload_json).ticket_id === ticketId);
		return row?.recipient_id;
	} finally {
		database.close();
	}
}

function deleteEnvelope(home, idempotencyKey) {
	const database = new Database(home.trackerDb, { fileMustExist: true });
	try {
		return database
			.prepare(
				"DELETE FROM tracker_envelopes WHERE project_id = ? AND idempotency_key = ?",
			)
			.run(projectId, idempotencyKey).changes;
	} finally {
		database.close();
	}
}

function insertMalformedDispatchReceipt(home, ticketId, committedAt) {
	const database = new Database(home.trackerDb, { fileMustExist: true });
	const commandId = "cmd_gol89_malformed_projection";
	try {
		database
			.prepare(
				`INSERT INTO command_receipts(
					command_id, project_id, idempotency_key, command_kind, actor_id,
					resource_type, resource_id, correlation_id, fingerprint,
					outcome_status, result_json, committed_at
				) VALUES (?, ?, ?, 'dispatch', 'fixture', 'ticket', ?, 'fixture',
					'fixture', 'completed', ?, ?)`,
			)
			.run(
				commandId,
				projectId,
				"gol89:malformed-projection",
				ticketId,
				JSON.stringify({
					kind: "dispatch",
					disposition: "ineligible",
					operation_id: commandId,
					recipient_id: sessionId,
				}),
				committedAt,
			);
		return commandId;
	} finally {
		database.close();
	}
}

function seed(writer, fixtureClock) {
	writer.runtimeProjectStorage().observe({
		projectId,
		name: "GOL-82 dispatch journey",
		location: {
			locationId: "loc_00000000-0000-4000-8000-000000000082",
			canonicalPath: "/tmp/gol82-dispatch",
			relation: "main",
			source: "register",
			evidence: { journey: true },
			observedAt: fixtureClock.now(),
		},
		source: "register",
		eventId: "evt_00000000-0000-4000-8000-000000000082",
		deduplicationKey: "gol82-project",
		payload: { kind: "project.observed" },
		provenance: { source: "journey", confidence: "verified" },
		occurredAt: fixtureClock.now(),
	});
	assert.equal(
		createSessionService({
			projects: writer.runtimeProjectStorage(),
			sessions: writer.runtimeSessionStorage(),
		}).apply(runtimeSignal(1)).disposition,
		"accepted",
	);
	assert.equal(
		createSessionService({
			projects: writer.runtimeProjectStorage(),
			sessions: writer.runtimeSessionStorage(),
		}).apply(
			runtimeSignal(2, reassignedSessionId, reassignedGenerationId),
		).disposition,
		"accepted",
	);
	const endpoints = writer.runtimeEndpointStorage();
	const claim = endpoints.claim({
		generationId,
		routeKind: "delivery",
		ownerInstanceId: "gol82-delivery-owner",
		deliveryMode: "native_channel",
		readiness: "ready",
		controlState: "enabled",
		leaseMs: 60_000,
	});
	assert(claim.endpointId && claim.ownerFence, "fixture owns a canonical fenced endpoint");
	const identity = {
		endpointId: claim.endpointId,
		generationId,
		ownerInstanceId: "gol82-delivery-owner",
		ownerFence: claim.ownerFence,
	};
	assert.equal(endpoints.reportHealth({ ...identity, state: "healthy" }).disposition, "accepted");
	assert.equal(endpoints.probe({ ...identity, consumerReady: true }).disposition, "accepted");
	assert.equal(endpoints.reportReadiness({ ...identity, deliveryMode: "native_channel", readiness: "ready" }).disposition, "accepted");
	assert.equal(endpoints.reportDelivery({ ...identity, status: "delivered", readiness: "ready" }).disposition, "accepted");
	assert.equal(
		endpoints.reportCapability({
			...identity,
			capability: {
				capability: "delivery",
				adapterId: "gol82-journey",
				adapterVersion: "1.0.0",
				qualification: "supported",
				deliveryMode: "native_channel",
				readiness: "ready",
				evidenceKind: "observed",
				observedAt: fixtureClock.now(),
			},
			evidence: { consumed: true },
		}).disposition,
		"accepted",
	);
	const reassignedClaim = endpoints.claim({
		generationId: reassignedGenerationId,
		routeKind: "delivery",
		ownerInstanceId: "gol82-reassigned-owner",
		deliveryMode: "native_channel",
		readiness: "ready",
		controlState: "enabled",
		leaseMs: 60_000,
	});
	assert(
		reassignedClaim.endpointId && reassignedClaim.ownerFence,
		"fixture owns a second canonical endpoint for reassignment",
	);
	const reassignedIdentity = {
		endpointId: reassignedClaim.endpointId,
		generationId: reassignedGenerationId,
		ownerInstanceId: "gol82-reassigned-owner",
		ownerFence: reassignedClaim.ownerFence,
	};
	assert.equal(
		endpoints.reportHealth({ ...reassignedIdentity, state: "healthy" }).disposition,
		"accepted",
	);
	assert.equal(
		endpoints.probe({ ...reassignedIdentity, consumerReady: true }).disposition,
		"accepted",
	);
	assert.equal(
		endpoints.reportReadiness({
			...reassignedIdentity,
			deliveryMode: "native_channel",
			readiness: "ready",
		}).disposition,
		"accepted",
	);
	assert.equal(
		endpoints.reportDelivery({
			...reassignedIdentity,
			status: "delivered",
			readiness: "ready",
		}).disposition,
		"accepted",
	);
	assert.equal(
		endpoints.reportCapability({
			...reassignedIdentity,
			capability: {
				capability: "delivery",
				adapterId: "gol82-journey",
				adapterVersion: "1.0.0",
				qualification: "supported",
				deliveryMode: "native_channel",
				readiness: "ready",
				evidenceKind: "observed",
				observedAt: fixtureClock.now(),
			},
			evidence: { consumed: true },
		}).disposition,
		"accepted",
	);
	const principals = writer.browserPrincipalStorage();
	for (const [id, actorId, project] of [
		["gol82_browser", "act_gol82_browser", projectId],
		["gol82_foreign", "act_gol82_foreign", foreignProjectId],
	])
		principals.provision({
			id,
			actorId,
			role: "operator",
			defaultProjectId: project,
			scopeProjectIds: [project],
		});
	principals.bindCredential({
		bindingId: "gol82_browser",
		adapter: "bearer",
		credential: token,
	});
	principals.bindCredential({
		bindingId: "gol82_browser",
		adapter: "mcp",
		credential: mcpToken,
	});
	const expiresAt = fixtureClock.after(60_000);
	assert.equal(principals.createBrowserSession({ bindingId: "gol82_browser", session: browserSession, csrf: browserCsrf, expiresAt, now: fixtureClock.now() }), true);
	assert.equal(principals.createBrowserSession({ bindingId: "gol82_foreign", session: foreignSession, csrf: foreignCsrf, expiresAt, now: fixtureClock.now() }), true);
}

function compose(writer, fixtureClock, home) {
	const appClock = { now: () => fixtureClock.now(), after: (milliseconds) => fixtureClock.after(milliseconds) };
	const core = composeControlPlaneTrackerCoreServices({ writer, clock: appClock });
	const eligibility = composeControlPlaneEndpointEligibility({ endpoints: writer.runtimeEndpointStorage(), clock: appClock });
	const services = composeControlPlaneTrackerServices({ writer, clock: appClock, eligibility });
	const management = composeControlPlaneManagementServices({ writer, clock: appClock, assetRoot: path.join(home.root, "assets"), tickets: core.tickets });
	const gateway = composeControlPlaneCommandGateway({ writer, clock: appClock, core });
	const ticketDispatch = composeControlPlaneTicketDispatchService({ writer, core, services, eligibility });
	return {
		core,
		services,
		management,
		gateway,
		ticketDispatch,
		browserWork: createBrowserWorkServices({
			core,
			management,
			ticketDispatch,
			projectRevision: (id) => writer.committedPublicationStorage().projectRevision(id),
		}),
	};
}

async function start(home, writer, fixtureClock) {
	const staticDirectory = path.join(home.root, "static");
	fs.mkdirSync(staticDirectory, { recursive: true });
	fs.writeFileSync(path.join(staticDirectory, "index.html"), "<!doctype html><title>GOL-82</title>");
	const composed = compose(writer, fixtureClock, home);
	const principalResolver = createBrowserPrincipalResolver({
		storage: writer.browserPrincipalStorage(),
		localOperatorBindingId: "gol82_browser",
		clock: { now: () => Date.parse(fixtureClock.now()) },
	});
	const service = await startControlPlane({
		token,
		stateDirectory: path.join(home.root, "control-plane"),
		staticDirectory,
		trackerCore: composed.core,
		trackerServices: composed.services,
		management: composed.management,
		commandGateway: composed.gateway,
		ticketDispatch: composed.ticketDispatch,
		browserWork: composed.browserWork,
		committedPublications: writer.committedPublicationStorage(),
		principalResolver,
		projection: { read: () => ({}), revision: (_stream, id) => id ? writer.committedPublicationStorage().projectRevision(id) : 0 },
	});
	return { service, ...composed };
}

function ticket(core, title, assignee = sessionId) {
	return core.tickets.create({
		projectId,
		kind: "work-item",
		title,
		assignee,
		actor: "act_gol82_browser",
	});
}

export async function exerciseBrowserTrackerDeliveryParity() {
	const home = createTemporaryHome("golem-gol82-browser-delivery-");
	const fixtureClock = clock();
	let writer;
	let control;
	let socket;
	let foreignSocket;
	try {
		writer = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb, lockPath: path.join(home.root, "owner.lock") }, { ownerId: "gol82-browser", clock: fixtureClock });
		seed(writer, fixtureClock);
		control = await start(home, writer, fixtureClock);
		const origin = control.service.origin;
		const jar = browserCookieJar();
		const browserClient = createBrowserControlPlaneClient(origin, {
			cookieJar: jar,
		});
		await browserClient.bootstrap();
		const browserTicket = ticket(control.core, "browser canonical dispatch");
		const bearerTicket = ticket(control.core, "bearer canonical dispatch");
		const mcpTicket = ticket(control.core, "mcp canonical dispatch");
		const browserBody = { kind: "dispatch", opaque_id: browserTicket.id, expected_revision: browserTicket.revision, idempotency_key: "gol82:browser" };
		const browser = await browserClient.browserWorkCommand(browserBody);
		assert.deepEqual(browser.result.disposition, "queued");
		assert.equal(browser.result.operation_id, browser.command_id);
		const pendingCommunication =
			await browserClient.browserWorkProjection("communication.operations");
		assert.deepEqual(
			projectedDispatch(pendingCommunication, browser.command_id),
			{
				opaque_id: browser.command_id,
				operation_kind: "dispatch",
				subject_opaque_id: browserTicket.id,
				disposition: "queued",
				capability: "delivery",
				settlement: "pending",
				created_at: fixtureClock.now(),
			},
			"canonical receipt plus envelope materializes pending dispatch truth",
		);
		assertSafeDispatchProjection(
			pendingCommunication,
			"pending browser dispatch",
		);
		const bearerBody = { expected_revision: bearerTicket.revision, idempotency_key: "gol82:bearer" };
		const bearer = await json(origin, `/api/v1/tracker/tickets/${bearerTicket.id}/dispatch`, { method: "POST", headers: bearerHeaders(), body: JSON.stringify(bearerBody) });
		assert.equal(bearer.status, 201);
		assert.equal(bearer.body.result.disposition, "queued");
		const mcp = await invokeMcpTool(
			createFetchApiClient(origin, { bearerToken: mcpToken, caller: { projectId, sessionId } }),
			"ticket_dispatch",
			{
				id: mcpTicket.id,
				session_id: sessionId,
				expected_revision: mcpTicket.revision,
				idempotency_key: "gol82:mcp",
				note: "GOL89_HOSTILE_PAYLOAD",
				workspace: "GOL89_HOSTILE_PAYLOAD",
			},
		);
		assert.equal(mcp.isError, undefined);
		assert.equal(JSON.parse(mcp.content[0].text).result.disposition, "queued");
		assert.deepEqual(queueCounts(home), { envelopes: 3, dispatchQueue: 0 }, "browser, bearer, and MCP each queue only canonical envelopes");
		const transportParityProjection =
			await browserClient.browserWorkProjection("communication.operations");
		for (const [outcome, subject] of [
			[browser, browserTicket.id],
			[bearer.body, bearerTicket.id],
			[JSON.parse(mcp.content[0].text), mcpTicket.id],
		]) {
			assert.deepEqual(
				projectedDispatch(transportParityProjection, outcome.command_id),
				{
					opaque_id: outcome.command_id,
					operation_kind: "dispatch",
					subject_opaque_id: subject,
					disposition: "queued",
					capability: "delivery",
					settlement: "pending",
					created_at: fixtureClock.now(),
				},
				"browser, bearer, and MCP receipts converge on one safe read model",
			);
		}
		assertSafeDispatchProjection(
			transportParityProjection,
			"transport-parity projection",
		);

		const runtimeReferenceTicket = control.core.tickets.create({
			projectId,
			kind: "work-item",
			title: "runtime reference cannot steer delivery",
			assignee: sessionId,
			runtimeReference: {
				projectId,
				sessionId: reassignedSessionId,
				generationId: reassignedGenerationId,
			},
			actor: "act_gol82_browser",
		});
		const runtimeReferenceDispatch = await json(
			origin,
			"/api/v1/browser/work/commands",
			{
				method: "POST",
				headers: browserHeaders(origin),
				body: JSON.stringify({
					kind: "dispatch",
					opaque_id: runtimeReferenceTicket.id,
					expected_revision: runtimeReferenceTicket.revision,
					idempotency_key: "gol82:runtime-reference",
				}),
			},
		);
		assert.equal(runtimeReferenceDispatch.status, 200);
		assert.equal(
			envelopeRecipient(
				home,
				runtimeReferenceTicket.id,
				"gol82:runtime-reference",
			),
			sessionId,
			"runtimeReference cannot override the current assignee",
		);

		const reassignedTicket = ticket(
			control.core,
			"current assignee wins over historical dispatch",
		);
		const firstAssignment = await json(
			origin,
			`/api/v1/tracker/tickets/${reassignedTicket.id}/dispatch`,
			{
				method: "POST",
				headers: bearerHeaders(),
				body: JSON.stringify({
					expected_revision: reassignedTicket.revision,
					idempotency_key: "gol82:historical-assignee",
				}),
			},
		);
		assert.equal(firstAssignment.status, 201);
		const reassigned = control.core.tickets.update({
			id: reassignedTicket.id,
			expectedRevision: control.core.tickets.get(reassignedTicket.id)?.ticket.revision,
			patch: { assignee: reassignedSessionId },
			actor: "act_gol82_browser",
		});
		const currentAssignment = await json(
			origin,
			`/api/v1/tracker/tickets/${reassignedTicket.id}/dispatch`,
			{
				method: "POST",
				headers: bearerHeaders(),
				body: JSON.stringify({
					expected_revision: reassigned.revision,
					idempotency_key: "gol82:current-assignee",
				}),
			},
		);
		assert.equal(currentAssignment.status, 201);
		assert.equal(
			envelopeRecipient(
				home,
				reassignedTicket.id,
				"gol82:current-assignee",
			),
			reassignedSessionId,
			"the current assignee supersedes historical dispatchedTo for the next delivery",
		);
		assert.deepEqual(queueCounts(home), { envelopes: 6, dispatchQueue: 0 });

		const prunedTicket = ticket(
			control.core,
			"queueable receipt whose envelope is no longer present",
		);
		const prunedDispatch = await json(
			origin,
			"/api/v1/browser/work/commands",
			{
				method: "POST",
				headers: browserHeaders(origin),
				body: JSON.stringify({
					kind: "dispatch",
					opaque_id: prunedTicket.id,
					expected_revision: prunedTicket.revision,
					idempotency_key: "gol82:pruned-envelope",
				}),
			},
		);
		assert.equal(prunedDispatch.body.result.disposition, "queued");
		assert.deepEqual(queueCounts(home), { envelopes: 7, dispatchQueue: 0 });
		assert.equal(deleteEnvelope(home, "gol82:pruned-envelope"), 1);
		const missingEnvelopeProjection =
			await browserClient.browserWorkProjection("communication.operations");
		assert.equal(
			projectedDispatch(
				missingEnvelopeProjection,
				prunedDispatch.body.command_id,
			),
			undefined,
			"queueable receipt with a missing/pruned envelope fails closed",
		);
		assert.deepEqual(queueCounts(home), { envelopes: 6, dispatchQueue: 0 });

		const ineligibleTicket = control.core.tickets.create({
			projectId,
			kind: "work-item",
			title: "durable ineligible dispatch projection",
			assignee: "human",
			actor: "act_gol82_browser",
		});
		const ineligible = await json(
			origin,
			"/api/v1/browser/work/commands",
			{
				method: "POST",
				headers: browserHeaders(origin),
				body: JSON.stringify({
					kind: "dispatch",
					opaque_id: ineligibleTicket.id,
					expected_revision: ineligibleTicket.revision,
					idempotency_key: "gol82:ineligible-projection",
				}),
			},
		);
		assert.equal(ineligible.status, 200);
		assert.equal(ineligible.body.result.disposition, "ineligible");
		const ineligibleProjection =
			await browserClient.browserWorkProjection("communication.operations");
		assert.deepEqual(
			projectedDispatch(ineligibleProjection, ineligible.body.command_id),
			{
				opaque_id: ineligible.body.command_id,
				operation_kind: "dispatch",
				subject_opaque_id: ineligibleTicket.id,
				disposition: "ineligible",
				created_at: fixtureClock.now(),
			},
			"ineligible durable outcome has no fabricated envelope settlement",
		);
		assert.deepEqual(queueCounts(home), { envelopes: 6, dispatchQueue: 0 });
		assertSafeDispatchProjection(ineligibleProjection, "ineligible projection");
		const malformedCommandId = insertMalformedDispatchReceipt(
			home,
			ineligibleTicket.id,
			fixtureClock.now(),
		);
		const malformedProjection =
			await browserClient.browserWorkProjection("communication.operations");
		assert.equal(
			projectedDispatch(malformedProjection, malformedCommandId),
			undefined,
			"receipt result with a non-allowlisted field fails closed",
		);
		assertSafeDispatchProjection(malformedProjection, "malformed receipt projection");

		const foreignTicket = control.core.tickets.create({ projectId: foreignProjectId, kind: "work-item", title: "foreign", assignee: sessionId, actor: "act_gol82_foreign" });
		const foreign = await json(origin, "/api/v1/browser/work/commands", { method: "POST", headers: browserHeaders(origin), body: JSON.stringify({ kind: "dispatch", opaque_id: foreignTicket.id, expected_revision: foreignTicket.revision, idempotency_key: "gol82:foreign" }) });
		assert.equal(foreign.status, 404, "cross-scope browser target is non-disclosing");
		assert.equal(JSON.stringify(foreign.body).includes(foreignTicket.id), false);
		const foreignProjection = await json(
			origin,
			"/api/v1/projections/communication.operations",
			{
				headers: {
					origin,
					cookie: `golem_control_plane_session=${foreignSession}`,
				},
			},
		);
		assert.equal(foreignProjection.status, 200);
		assert.equal(
			foreignProjection.body.items.some(
				(item) => item.operation_kind === "dispatch",
			),
			false,
			"foreign browser sees no project dispatch operation",
		);
		const beforeForgery = queueCounts(home);
		for (const key of ["session_id", "generation_id", "endpoint", "fence", "readiness", "acknowledgement_id", "settlement"]) {
			const forged = await json(origin, "/api/v1/browser/work/commands", { method: "POST", headers: browserHeaders(origin), body: JSON.stringify({ ...browserBody, idempotency_key: `gol82:forged:${key}`, [key]: "forged" }) });
			assert.equal(forged.status, key === "session_id" || key === "fence" ? 403 : 400, `${key} rejects before mutation`);
		}
		assert.deepEqual(queueCounts(home), beforeForgery);

		socket = new WebSocket(`${origin.replace("http", "ws")}/api/v1/ws?stream=communication.operations`, { headers: { origin, cookie: `golem_control_plane_session=${browserSession}` } });
		foreignSocket = new WebSocket(`${origin.replace("http", "ws")}/api/v1/ws?stream=communication.operations`, { headers: { origin, cookie: `golem_control_plane_session=${foreignSession}` } });
		const settlementSnapshots = [];
		const settlementSync = createBrowserWorkSynchronizer({
			key: { kind: "stream", stream: "communication.operations" },
			refetch: () =>
				browserClient.browserWorkProjection("communication.operations"),
			onSnapshot: (snapshot, source) =>
				settlementSnapshots.push({ snapshot, source }),
		});
		const initialSettlementRaw = await nextFrame(socket);
		const initialSettlement = BrowserWorkWebSocketFrameSchema.parse(
			JSON.parse(initialSettlementRaw),
		);
		assert.equal(initialSettlement.payload.kind, "snapshot");
		assertSafeDispatchProjection(
			initialSettlement.payload.payload,
			"communication WebSocket snapshot",
		);
		await settlementSync.consume(initialSettlementRaw);
		BrowserWorkWebSocketFrameSchema.parse(JSON.parse(await nextFrame(foreignSocket)));
		const claims = await json(origin, "/api/v1/delivery/claims", { method: "POST", headers: bearerHeaders(), body: JSON.stringify({ limit: 10 }) });
		const claim = claims.body.items.find((item) => item.payload.ticket_id === browserTicket.id);
		assert.ok(claim, "browser dispatch has a real claimable canonical envelope");
		const prepared = await json(origin, `/api/v1/delivery/claims/${encodeURIComponent(claim.claimToken)}/prepare`, { method: "POST", headers: bearerHeaders(), body: "{}" });
		assert.equal(prepared.status, 200);
		const beforeAck = writer.committedPublicationStorage().projectRevision(projectId);
		const deltaFrame = nextFrame(socket);
		const acknowledged = await json(origin, `/api/v1/delivery/claims/${encodeURIComponent(claim.claimToken)}/ack`, { method: "POST", headers: bearerHeaders(), body: JSON.stringify({ acknowledgement_id: "ack_gol82_browser", payload: {} }) });
		assert.equal(acknowledged.status, 200, "settlement remains the later canonical callback");
		assert.equal(writer.committedPublicationStorage().projectRevision(projectId), beforeAck + 1);
		const settledProjection =
			await browserClient.browserWorkProjection("communication.operations");
		assert.equal(
			projectedDispatch(settledProjection, browser.command_id)?.settlement,
			"settled",
			"authoritative HTTP truth reflects canonical acknowledgement",
		);
		assertSafeDispatchProjection(settledProjection, "settled HTTP projection");
		const duplicateAcknowledgement = await json(
			origin,
			`/api/v1/delivery/claims/${encodeURIComponent(claim.claimToken)}/ack`,
			{
				method: "POST",
				headers: bearerHeaders(),
				body: JSON.stringify({ acknowledgement_id: "ack_gol82_browser", payload: {} }),
			},
		);
		assert.equal(duplicateAcknowledgement.status, 200, "duplicate acknowledgement is a canonical replay");
		assert.equal(
			writer.committedPublicationStorage().projectRevision(projectId),
			beforeAck + 1,
			"duplicate settlement publishes +0",
		);
		assert.deepEqual(
			await browserClient.browserWorkProjection("communication.operations"),
			settledProjection,
			"duplicate acknowledgement leaves projection unchanged",
		);
		const deltaRaw = await deltaFrame;
		const delta = BrowserWorkWebSocketFrameSchema.parse(JSON.parse(deltaRaw));
		assert.equal(delta.payload.kind, "delta");
		assertSafeDispatchProjection(delta.payload.delta, "settlement invalidation");
		await settlementSync.consume(deltaRaw);
		assert.equal(
			settlementSnapshots.at(-1)?.source,
			"http",
			"canonical acknowledgement invalidation forces authoritative HTTP refetch",
		);
		assert.equal(
			settlementSnapshots.at(-1)?.snapshot.resource_revision,
			writer.committedPublicationStorage().projectRevision(projectId),
		);
		assert.equal(
			projectedDispatch(
				settlementSnapshots.at(-1)?.snapshot,
				browser.command_id,
			)?.settlement,
			"settled",
			"invalidation refetch returns the same canonical settled operation",
		);
		await noFrame(foreignSocket);

		await control.service.close();
		control = undefined;
		await writer.close();
		writer = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb, lockPath: path.join(home.root, "owner.lock") }, { ownerId: "gol82-browser-restart", clock: fixtureClock });
		const restarted = await start(home, writer, fixtureClock);
		control = restarted;
		const replay = await json(restarted.service.origin, "/api/v1/browser/work/commands", { method: "POST", headers: browserHeaders(restarted.service.origin), body: JSON.stringify(browserBody) });
		assert.deepEqual(replay.body, browser, "restart duplicate replays the original durable browser outcome");
		assert.deepEqual(queueCounts(home), { envelopes: 6, dispatchQueue: 0 });
		const restartProjection = await json(
			restarted.service.origin,
			"/api/v1/projections/communication.operations",
			{
				headers: {
					origin: restarted.service.origin,
					cookie: `golem_control_plane_session=${browserSession}`,
				},
			},
		);
		assert.equal(restartProjection.status, 200);
		assert.deepEqual(
			restartProjection.body,
			settledProjection,
			"restart rematerializes the identical canonical dispatch projection",
		);
		assertSafeDispatchProjection(
			restartProjection.body,
			"restart projection",
		);
		return "real managed SQLite browser cookie/CSRF, bearer HTTP, MCP, safe pending-to-settled HTTP refetch, foreign isolation, duplicate ACK +0, and restart projection converge on canonical receipts/envelopes without legacy dispatch_queue";
	} finally {
		if (socket) {
			socket.on("error", () => {});
			socket.terminate();
		}
		if (foreignSocket) {
			foreignSocket.on("error", () => {});
			foreignSocket.terminate();
		}
		if (control) await control.service.close();
		if (writer) await writer.close();
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false, "GOL-82 browser parity leaves no shared state");
	}
}

export async function exerciseTicketDispatchHttpMcpParity() {
	const home = createTemporaryHome("golem-gol82-http-mcp-");
	const fixtureClock = clock();
	let writer;
	let control;
	try {
		writer = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb, lockPath: path.join(home.root, "owner.lock") }, { ownerId: "gol82-http-mcp", clock: fixtureClock });
		seed(writer, fixtureClock);
		control = await start(home, writer, fixtureClock);
		let origin = control.service.origin;
		const pullTicket = ticket(control.core, "pull-only ticket");
		const endpoint = writer.runtimeEndpointStorage().list(generationId)[0];
		assert(endpoint, "fixture endpoint exists");
		assert.equal(writer.runtimeEndpointStorage().reportReadiness({ endpointId: endpoint.endpointId, generationId, ownerInstanceId: "gol82-delivery-owner", ownerFence: endpoint.ownerFence, deliveryMode: "pull", readiness: "pull_only" }).disposition, "accepted");
		assert.equal(
			writer.runtimeEndpointStorage().reportCapability({
				endpointId: endpoint.endpointId,
				generationId,
				ownerInstanceId: "gol82-delivery-owner",
				ownerFence: endpoint.ownerFence,
				capability: {
					capability: "delivery",
					adapterId: "gol82-journey",
					adapterVersion: "1.0.0",
					qualification: "supported",
					deliveryMode: "pull",
					readiness: "pull_only",
					evidenceKind: "observed",
					observedAt: fixtureClock.now(),
				},
				evidence: { consumed: true },
			}).disposition,
			"accepted",
		);
		const pull = await json(origin, `/api/v1/tracker/tickets/${pullTicket.id}/dispatch`, { method: "POST", headers: bearerHeaders(), body: JSON.stringify({ expected_revision: pullTicket.revision, idempotency_key: "gol82:pull" }) });
		assert.equal(pull.status, 201);
		assert.equal(pull.body.result.disposition, "pull_only");
		assert.deepEqual(queueCounts(home), { envelopes: 1, dispatchQueue: 0 });
		const noAssignee = control.core.tickets.create({ projectId, kind: "work-item", title: "legacy assignment", actor: "act_gol82_browser" });
		const legacyMcp = await invokeMcpTool(createFetchApiClient(origin, { bearerToken: mcpToken, caller: { projectId, sessionId } }), "ticket_dispatch", { id: noAssignee.id, session_id: sessionId, expected_revision: noAssignee.revision, idempotency_key: "gol82:legacy-hint", note: "trusted legacy delivery", workspace: "gol82", when_idle: true });
		assert.equal(legacyMcp.isError, undefined);
		assert.equal(
			JSON.parse(legacyMcp.content[0].text).result.disposition,
			"pull_only",
			"legacy hint fills only an absent current assignee",
		);
		assert.equal(control.core.tickets.get(noAssignee.id)?.ticket.assignee, sessionId);
		assert.equal(control.core.tickets.get(noAssignee.id)?.ticket.dispatchedTo, sessionId);
		assert.deepEqual(
			envelopePayload(home, noAssignee.id),
			{
				ticket_id: noAssignee.id,
				note: "trusted legacy delivery",
				workspace: "gol82",
				when_idle: true,
			},
			"trusted MCP-only legacy content is retained in the canonical envelope",
		);
		const invalidHintTicket = ticket(control.core, "invalid trusted MCP hint");
		const beforeInvalidHint = queueCounts(home);
		const invalidHint = await invokeMcpTool(
			createFetchApiClient(origin, {
				bearerToken: mcpToken,
				caller: { projectId, sessionId },
			}),
			"ticket_dispatch",
			{
				id: invalidHintTicket.id,
				session_id: "ses_00000000-0000-4000-8000-000000000089",
				expected_revision: invalidHintTicket.revision,
				idempotency_key: "gol82:invalid-mcp-hint",
			},
		);
		assert.equal(invalidHint.isError, undefined);
		assert.equal(
			JSON.parse(invalidHint.content[0].text).result.disposition,
			"ineligible",
			"an unresolved trusted hint fails closed instead of falling back to the ticket assignee",
		);
		assert.deepEqual(queueCounts(home), beforeInvalidHint);

		const ineligible = control.core.tickets.create({ projectId, kind: "work-item", title: "human assignee", assignee: "human", actor: "act_gol82_browser" });
		const beforeIneligible = queueCounts(home);
		const rejectedPublicTarget = await json(
			origin,
			`/api/v1/tracker/tickets/${pullTicket.id}/dispatch`,
			{
				method: "POST",
				headers: bearerHeaders(),
				body: JSON.stringify({
					expected_revision: control.core.tickets.get(pullTicket.id)?.ticket.revision,
					idempotency_key: "gol82:bearer-target",
					session_id: sessionId,
				}),
			},
		);
		assert.equal(rejectedPublicTarget.status, 403, "public bearer cannot select a delivery recipient");
		assert.deepEqual(queueCounts(home), beforeIneligible);
		const refused = await json(origin, `/api/v1/tracker/tickets/${ineligible.id}/dispatch`, { method: "POST", headers: bearerHeaders(), body: JSON.stringify({ expected_revision: ineligible.revision, idempotency_key: "gol82:ineligible" }) });
		assert.equal(refused.status, 201);
		assert.equal(refused.body.result.disposition, "ineligible");
		assert.deepEqual(queueCounts(home), beforeIneligible);

		const terminal = control.core.tickets.create({
			projectId,
			kind: "question",
			title: "terminal dispatch refusal",
			assignee: sessionId,
			actor: "act_gol82_browser",
		});
		control.core.comments.add({
			ticketId: terminal.id,
			author: "act_gol82_browser",
			body: "terminal answer",
		});
		const answered = control.core.tickets.transition({
			id: terminal.id,
			expectedRevision: control.core.tickets.get(terminal.id)?.ticket.revision,
			phase: "answered",
			actor: "act_gol82_browser",
		});
		const closed = control.core.tickets.transition({
			id: terminal.id,
			expectedRevision: answered.revision,
			phase: "closed",
			actor: "act_gol82_browser",
		});
		const terminalRefusal = await json(
			origin,
			`/api/v1/tracker/tickets/${terminal.id}/dispatch`,
			{
				method: "POST",
				headers: bearerHeaders(),
				body: JSON.stringify({
					expected_revision: closed.revision,
					idempotency_key: "gol82:terminal",
				}),
			},
		);
		assert.equal(terminalRefusal.status, 201);
		assert.equal(terminalRefusal.body.result.disposition, "ineligible", "terminal tickets refuse before recipient resolution or enqueue");
		assert.deepEqual(queueCounts(home), beforeIneligible);

		const staleInput = {
			expected_revision: pullTicket.revision,
			idempotency_key: "gol82:stale",
		};
		const stale = await json(origin, `/api/v1/tracker/tickets/${pullTicket.id}/dispatch`, { method: "POST", headers: bearerHeaders(), body: JSON.stringify(staleInput) });
		assert.equal(stale.status, 201);
		assert.equal(stale.body.result.disposition, "stale");
		assert.deepEqual(queueCounts(home), beforeIneligible);
		await control.service.close();
		control = undefined;
		await writer.close();
		writer = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb, lockPath: path.join(home.root, "owner.lock") }, { ownerId: "gol82-http-mcp-restart", clock: fixtureClock });
		control = await start(home, writer, fixtureClock);
		origin = control.service.origin;
		const staleReplay = await json(origin, `/api/v1/tracker/tickets/${pullTicket.id}/dispatch`, { method: "POST", headers: bearerHeaders(), body: JSON.stringify(staleInput) });
		assert.deepEqual(staleReplay.body, stale.body, "stale is a durable GOL-79 outcome, not route-local synthesis");
		const staleConflict = await json(
			origin,
			`/api/v1/tracker/tickets/${pullTicket.id}/dispatch`,
			{
				method: "POST",
				headers: bearerHeaders(),
				body: JSON.stringify({
					expected_revision: pullTicket.revision + 1,
					idempotency_key: staleInput.idempotency_key,
				}),
			},
		);
		assert.equal(staleConflict.status, 409, "changed stale replay fingerprint conflicts without dispatching");
		assert.equal(staleConflict.body.code, "command.idempotency_mismatch");
		assert.deepEqual(queueCounts(home), beforeIneligible);

		const claims = await json(origin, "/api/v1/delivery/claims", { method: "POST", headers: bearerHeaders(), body: JSON.stringify({ limit: 10 }) });
		const pullClaim = claims.body.items.find((item) => item.payload.ticket_id === pullTicket.id);
		assert.ok(pullClaim);
		const prepared = await json(origin, `/api/v1/delivery/claims/${encodeURIComponent(pullClaim.claimToken)}/prepare`, { method: "POST", headers: bearerHeaders(), body: "{}" });
		assert.equal(prepared.status, 200, "pull-only classification remains a canonical queue, not synthetic success");
		const beforeFailure = writer.committedPublicationStorage().projectRevision(projectId);
		const failed = await json(origin, `/api/v1/delivery/claims/${encodeURIComponent(pullClaim.claimToken)}/fail`, { method: "POST", headers: bearerHeaders(), body: JSON.stringify({ error: "delivery failed" }) });
		assert.equal(failed.status, 200);
		assert.equal(writer.committedPublicationStorage().projectRevision(projectId), beforeFailure + 1, "later failure callback alone publishes its committed delta");
		const nextTurnTicket = ticket(control.core, "next-turn ticket");
		assert.equal(
			writer.runtimeEndpointStorage().reportReadiness({
				endpointId: endpoint.endpointId,
				generationId,
				ownerInstanceId: "gol82-delivery-owner",
				ownerFence: endpoint.ownerFence,
				deliveryMode: "next_turn",
				readiness: "next_turn",
			}).disposition,
			"accepted",
		);
		assert.equal(
			writer.runtimeEndpointStorage().reportCapability({
				endpointId: endpoint.endpointId,
				generationId,
				ownerInstanceId: "gol82-delivery-owner",
				ownerFence: endpoint.ownerFence,
				capability: {
					capability: "delivery",
					adapterId: "gol82-journey",
					adapterVersion: "1.0.0",
					qualification: "supported",
					deliveryMode: "next_turn",
					readiness: "next_turn",
					evidenceKind: "observed",
					observedAt: fixtureClock.now(),
				},
				evidence: { consumed: true },
			}).disposition,
			"accepted",
		);
		const nextTurn = await json(
			origin,
			`/api/v1/tracker/tickets/${nextTurnTicket.id}/dispatch`,
			{
				method: "POST",
				headers: bearerHeaders(),
				body: JSON.stringify({
					expected_revision: nextTurnTicket.revision,
					idempotency_key: "gol82:next-turn",
				}),
			},
		);
		assert.equal(nextTurn.status, 201);
		assert.equal(nextTurn.body.result.disposition, "next_turn");
		assert.deepEqual(queueCounts(home), { envelopes: 3, dispatchQueue: 0 });
		const staleClaims = await json(
			origin,
			"/api/v1/delivery/claims",
			{
				method: "POST",
				headers: bearerHeaders(),
				body: JSON.stringify({ limit: 10 }),
			},
		);
		const staleClaim = staleClaims.body.items.find(
			(item) => item.payload.ticket_id === nextTurnTicket.id,
		);
		assert.ok(staleClaim, "a queued next-turn dispatch is still a canonical claimable envelope");
		const takeover = writer.runtimeEndpointStorage().claim({
			generationId,
			routeKind: "delivery",
			ownerInstanceId: "gol82-replacement-owner",
			deliveryMode: "next_turn",
			readiness: "next_turn",
			controlState: "enabled",
			leaseMs: 60_000,
		});
		assert(takeover.endpointId && takeover.ownerFence, "canonical endpoint takeover allocates a new fence");
		const stalePrepare = await json(
			origin,
			`/api/v1/delivery/claims/${encodeURIComponent(staleClaim.claimToken)}/prepare`,
			{ method: "POST", headers: bearerHeaders(), body: "{}" },
		);
		assert.equal(stalePrepare.status, 409, "a replacement fence cannot prepare the old claim");
		assert.equal(stalePrepare.body.result.kind, "stale");
		return "real managed SQLite bearer and MCP adapters share canonical ticket dispatch classification, trusted legacy content, target-free bearer refusal, terminal/stale no-envelope behavior, fence-stale prepare refusal, and later failure publication";
	} finally {
		if (control) await control.service.close();
		if (writer) await writer.close();
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false, "GOL-82 HTTP/MCP parity leaves no shared state");
	}
}
