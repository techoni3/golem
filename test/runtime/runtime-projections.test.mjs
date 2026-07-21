import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import { BoundedReplayWindow, startControlPlane } from "../../apps/control-plane/dist/index.js";
import { createRuntimeProjectionService, createSessionService } from "@golem/runtime";
import { createTemporaryHome } from "@golem/testkit";

const token = "golem-runtime-projection-test-token-000000000000";
const projectId = "prj_00000000-0000-4000-8000-000000000046";
const sessionId = "ses_00000000-0000-4000-8000-000000000046";
const liveGenerationId = "gen_00000000-0000-4000-8000-000000000046";
const endedGenerationId = "gen_00000000-0000-4000-8000-000000000047";

function clock() {
	return {
		now: () => "2026-07-21T00:00:10.000Z",
		after: (milliseconds) => new Date(Date.parse("2026-07-21T00:00:10.000Z") + milliseconds).toISOString(),
	};
}

function signal(eventId, sequence, eventKind, generationId, payload = {}) {
	return {
		schema_version: "golem.runtime-signal/v1",
		event_id: eventId,
		event_kind: eventKind,
		producer: "projection-fixture",
		producer_instance_id: "prod_00000000-0000-4000-8000-000000000046",
		producer_sequence: sequence,
		harness: "claude",
		correlation_id: "corr_00000000-0000-4000-8000-000000000046",
		deduplication_key: `projection-${sequence}`,
		clocks: {
			source_observed_at: `2026-07-21T00:00:${String(sequence).padStart(2, "0")}.000Z`,
			received_at: "2026-07-21T00:00:10.000Z",
			materialized_at: "2026-07-21T00:00:10.000Z",
		},
		provenance: { source: "api", confidence: "verified", evidence_id: eventId },
		clear_fields: [],
		payload: { kind: eventKind, generation: { project_id: projectId, session_id: sessionId, generation_id: generationId }, ...payload },
	};
}

function seed(owner) {
	owner.runtimeProjectStorage().observe({
		projectId,
		name: "projection-fixture",
		location: {
			locationId: "loc_00000000-0000-4000-8000-000000000046",
			canonicalPath: "/tmp/golem-runtime-projection",
			relation: "main",
			source: "register",
			evidence: { fixture: true },
			observedAt: "2026-07-21T00:00:01.000Z",
		},
		source: "register",
		eventId: "evt_00000000-0000-4000-8000-000000000040",
		deduplicationKey: "projection-project",
		payload: { kind: "project.observed" },
		provenance: { source: "api", confidence: "verified" },
		occurredAt: "2026-07-21T00:00:01.000Z",
	});
	const sessions = createSessionService({ projects: owner.runtimeProjectStorage(), sessions: owner.runtimeSessionStorage() });
	assert.equal(sessions.apply(signal("evt_00000000-0000-4000-8000-000000000041", 1, "session.started", endedGenerationId, { metadata: { model: "haiku", role: "reviewer" } })).disposition, "accepted");
	assert.equal(sessions.apply(signal("evt_00000000-0000-4000-8000-000000000042", 2, "session.ended", endedGenerationId, { disposition: "ended" })).disposition, "accepted");
	assert.equal(sessions.apply(signal("evt_00000000-0000-4000-8000-000000000043", 3, "session.resumed", liveGenerationId, { resumed_from_generation_id: endedGenerationId, metadata: { model: "sonnet", role: "worker" } })).disposition, "accepted");
	const endpoint = owner.runtimeEndpointStorage().claim({
		generationId: liveGenerationId,
		routeKind: "delivery",
		ownerInstanceId: "projection-owner",
		deliveryMode: "pull",
		readiness: "pull_only",
		leaseMs: 30_000,
	});
	assert.equal(endpoint.disposition, "accepted", `${endpoint.code} ${JSON.stringify(owner.runtimeSessionStorage().get(projectId, sessionId))}`);
	return sessions;
}

function projectionAdapter(projection) {
	return {
		read: (stream) =>
			stream === "runtime.live" || stream === "runtime.history" || stream === "runtime.diagnostics"
				? projection.read(stream)
				: {},
		revision: (stream) =>
			stream === "runtime.live" || stream === "runtime.history" || stream === "runtime.diagnostics"
				? projection.revision(stream)
				: 0,
	};
}

async function serviceFor(home, owner, replay = new BoundedReplayWindow(4)) {
	const projection = createRuntimeProjectionService({ storage: owner.runtimeProjectionStorage(), clock: clock() });
	const staticDirectory = path.join(home.root, "static");
	fs.mkdirSync(staticDirectory, { recursive: true });
	fs.writeFileSync(path.join(staticDirectory, "index.html"), "<!doctype html><title>runtime projections</title>");
	const service = await startControlPlane({
		token,
		stateDirectory: path.join(home.root, "control-plane"),
		staticDirectory,
		projection: projectionAdapter(projection),
		runtimeProjection: projection,
		replay,
	});
	return { service, projection, replay };
}

async function jsonGet(origin, route) {
	const response = await fetch(`${origin}${route}`, { headers: { authorization: `Bearer ${token}` } });
	return { status: response.status, body: await response.json() };
}

test("GOL-46 live/history/diagnostics are canonical, explainable, and restart-stable", async () => {
	const home = createTemporaryHome("golem-gol46-projections-");
	let owner;
	let control;
	try {
		owner = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb }, { ownerId: "gol46-projection-owner", clock: clock() });
		seed(owner);
		owner.materializeRuntimeEvent({
			eventId: "evt_00000000-0000-4000-8000-000000000051",
			deduplicationKey: "diagnostic-accepted",
			eventKind: "runtime.accepted",
			payload: { safe: true },
			provenance: { source: "api" },
			occurredAt: "2026-07-21T00:00:04.000Z",
			producer: { id: "projection-diagnostics", sequence: 10 },
			disposition: "accepted",
			explanation: { code: "runtime.accepted", details: {} },
		});
		owner.materializeRuntimeEvent({
			eventId: "evt_00000000-0000-4000-8000-000000000052",
			deduplicationKey: "diagnostic-stale",
			eventKind: "runtime.stale",
			payload: { token: "token=do-not-leak" },
			provenance: { source: "api" },
			occurredAt: "2026-07-21T00:00:03.000Z",
			producer: { id: "projection-diagnostics", sequence: 1 },
			disposition: "accepted",
			explanation: {
				code: "runtime.stale",
				details: {
					token: "token=do-not-leak",
					password: "secret-value",
					event_id: "evt_00000000-0000-4000-8000-000000000052",
					fence_id: "fence_00000000-0000-4000-8000-000000000052",
					schema_version: "golem.runtime-signal/v1",
					revision: 52,
					nested: {
						env: { HOME: "HOME=/private/tmp/gol46-sensitive" },
						prompt: "gol46-private-prompt",
						unrelated_path: "/Users/laveesingh/private/unrelated.txt",
					},
				},
			},
		});
		owner.materializeRuntimeEvent({
			eventId: "evt_00000000-0000-4000-8000-000000000053",
			deduplicationKey: "diagnostic-illegal",
			eventKind: "runtime.illegal",
			payload: { authorization: "Bearer do-not-leak" },
			provenance: { source: "api" },
			occurredAt: "2026-07-21T00:00:05.000Z",
			producer: { id: "projection-diagnostics", sequence: 11 },
			disposition: "illegal",
			explanation: { code: "runtime.illegal", details: { api_key: "api-key-value" } },
		});
		const before = owner.runtimeProjectionStorage().revision();
		control = await serviceFor(home, owner);
		const live = await jsonGet(control.service.origin, "/api/v1/runtime/live");
		assert.equal(live.status, 200);
		assert.equal(live.body.stream, "runtime.live");
		assert.equal(live.body.items.length, 1);
		assert.equal(live.body.items[0].generation_id, liveGenerationId);
		assert.equal(live.body.items[0].observation.read_only, true);
		assert.equal(live.body.items[0].endpoints[0].readiness, "pull_only");
		const history = await jsonGet(control.service.origin, "/api/v1/runtime/history?limit=1");
		assert.equal(history.status, 200);
		assert.equal(history.body.items.length, 1);
		assert.equal(history.body.next_cursor, 1);
		const diagnostics = await jsonGet(control.service.origin, "/api/v1/runtime/diagnostics");
		assert.equal(diagnostics.status, 200);
		const diagnosticsText = JSON.stringify(diagnostics.body);
		assert.match(diagnosticsText, /runtime\.stale/u);
		assert.match(diagnosticsText, /evt_00000000-0000-4000-8000-000000000052/u);
		assert.match(diagnosticsText, /fence_00000000-0000-4000-8000-000000000052/u);
		assert.match(diagnosticsText, /golem\.runtime-signal\/v1/u);
		assert.match(diagnosticsText, /52/u);
		assert.doesNotMatch(diagnosticsText, /do-not-leak|secret-value|api-key-value|Bearer |gol46-sensitive|gol46-private-prompt|unrelated\.txt|HOME=\/private\/tmp/u);
		assert.equal(owner.runtimeProjectionStorage().revision(), before, "read projections do not mutate revision");
		await control.service.close();
		control = undefined;
		await owner.close();
		owner = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb }, { ownerId: "gol46-projection-reopen", clock: clock() });
		control = await serviceFor(home, owner);
		const reopened = await jsonGet(control.service.origin, "/api/v1/runtime/history?project_id=" + projectId);
		assert.equal(reopened.status, 200);
		assert.equal(reopened.body.items[0].generation_id, endedGenerationId);
		assert.equal(reopened.body.drift.status, "not_configured");
	} finally {
		if (control) await control.service.close();
		if (owner) await owner.close();
		home.cleanup();
	}
});

function nextFrame(socket) {
	return new Promise((resolve, reject) => {
		const onMessage = (raw) => {
			cleanup();
			resolve(JSON.parse(String(raw)));
		};
		const onError = (error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			socket.off("message", onMessage);
			socket.off("error", onError);
		};
		socket.on("message", onMessage);
		socket.on("error", onError);
	});
}

test("GOL-46 authenticated WS snapshot/delta converges and restart requests resync", async () => {
	const home = createTemporaryHome("golem-gol46-ws-");
	let owner;
	let first;
	let second;
	let socket;
	try {
		owner = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb }, { ownerId: "gol46-ws-owner", clock: clock() });
		seed(owner);
		const replay = new BoundedReplayWindow(2);
		first = await serviceFor(home, owner, replay);
		socket = new WebSocket(first.service.origin.replace("http", "ws") + "/api/v1/ws?stream=runtime.live", { headers: { authorization: `Bearer ${token}`, host: "127.0.0.1" } });
		const snapshot = await nextFrame(socket);
		assert.equal(snapshot.payload.kind, "snapshot");
		assert.equal(snapshot.resource_revision, first.projection.revision("runtime.live"));
		replay.publish("runtime.live", first.projection.revision("runtime.live"), { kind: "runtime.delta", generation_id: liveGenerationId });
		const delta = await nextFrame(socket);
		assert.equal(delta.payload.kind, "delta");
		assert.equal(delta.payload.delta.generation_id, liveGenerationId);
		const priorInstance = first.service.instanceId;
		const priorCursor = delta.sequence;
		socket.close();
		await first.service.close();
		first = undefined;
		second = await serviceFor(home, owner, replay);
		const resumed = new WebSocket(second.service.origin.replace("http", "ws") + `/api/v1/ws?stream=runtime.live&instance_id=${priorInstance}&cursor=${priorCursor}`, { headers: { authorization: `Bearer ${token}`, host: "127.0.0.1" } });
		const resync = await nextFrame(resumed);
		assert.equal(resync.payload.kind, "resync_required");
		assert.equal(resync.payload.reason, "instance_changed");
		resumed.close();
	} finally {
		socket?.close();
		if (first) await first.service.close();
		if (second) await second.service.close();
		if (owner) await owner.close();
		home.cleanup();
	}
});
