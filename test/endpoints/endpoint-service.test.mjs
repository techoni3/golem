import assert from "node:assert/strict";
import test from "node:test";

import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import { createEndpointService, createSessionService } from "@golem/runtime";
import { createTemporaryHome } from "@golem/testkit";

const uuid = (prefix, n) => `${prefix}_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = uuid("prj", 4201);
const sessionId = uuid("ses", 4202);
const generationId = uuid("gen", 4203);

function makeClock() {
	let current = Date.parse("2026-01-01T00:00:00.000Z");
	return {
		now: () => new Date(current).toISOString(),
		after: (milliseconds) => new Date(current + milliseconds).toISOString(),
		advance: (milliseconds) => { current += milliseconds; },
	};
}

function signal(kind, eventNumber, extra = {}) {
	const now = "2026-01-01T00:00:00.000Z";
	return {
		schema_version: "golem.runtime-signal/v1",
		event_id: uuid("evt", eventNumber),
		event_kind: kind,
		producer: "endpoint-fixture",
		producer_instance_id: uuid("prod", 4204),
		producer_sequence: eventNumber,
		harness: "claude",
		correlation_id: uuid("evt", 4299),
		deduplication_key: `endpoint-${eventNumber}`,
		clocks: { source_observed_at: now, received_at: now, materialized_at: now },
		provenance: { source: "adapter", confidence: "verified", evidence_id: `endpoint-${eventNumber}` },
		clear_fields: [],
		payload: { kind, generation: { project_id: projectId, session_id: sessionId, generation_id: generationId }, ...extra },
	};
}

function seed(owner) {
	owner.runtimeProjectStorage().observe({
		projectId,
		name: "endpoint-fixture",
		location: { locationId: uuid("loc", 4205), canonicalPath: "/tmp/golem-gol42", relation: "main", source: "register", evidence: { fixture: true }, observedAt: "2026-01-01T00:00:00.000Z" },
		source: "register",
		eventId: uuid("evt", 4206),
		deduplicationKey: "endpoint-project",
		payload: { kind: "project.observed" },
		provenance: { source: "api", confidence: "verified" },
		occurredAt: "2026-01-01T00:00:00.000Z",
	});
	createSessionService({ projects: owner.runtimeProjectStorage(), sessions: owner.runtimeSessionStorage() }).apply(signal("session.started", 4210));
}

function capability(overrides = {}) {
	return {
		capability: "control.dispatch",
		adapterId: "fixture-adapter",
		adapterVersion: "1.0.0",
		qualification: "supported",
		deliveryMode: "native_channel",
		readiness: "ready",
		evidenceKind: "probe",
		observedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

test("GOL-42 endpoint fence concurrency/crash", async () => {
	const home = createTemporaryHome("golem-gol42-fence-");
	const clock = makeClock();
	const owner = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb }, { clock, ownerId: "gol42-fence-owner" });
	try {
		seed(owner);
		const endpoints = createEndpointService({ storage: owner.runtimeEndpointStorage() });
		const claims = await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() => endpoints.claim({ generationId, routeKind: "control", ownerInstanceId: `owner-${index + 1}`, deliveryMode: "native_channel", leaseMs: 60_000 }))));
		assert.deepEqual(claims.map((claim) => claim.ownerFence), Array.from({ length: 20 }, (_, index) => index + 1));
		assert.equal(endpoints.list(generationId).filter((endpoint) => ["claiming", "healthy", "degraded"].includes(endpoint.state)).length, 1);
		const allEffects = owner.claimRuntimeOutbox("gol42-fence-order", 100);
		const effects = allEffects.filter((effect) => String(effect.payload.kind).startsWith("endpoint."));
		assert.deepEqual(effects.map((effect) => effect.payload.revision), Array.from({ length: 20 }, (_, index) => index + 1), "accepted endpoint effects replay in revision order");
		for (const effect of allEffects) owner.ackRuntimeOutbox(effect.id, effect.claimToken);
		const first = claims[0];
		assert(first.endpointId && first.ownerFence);
		assert.equal(endpoints.heartbeat({ endpointId: first.endpointId, generationId, ownerInstanceId: "owner-1", ownerFence: first.ownerFence, leaseMs: 60_000 }).code, "runtime.endpoint.fence_stale");
		assert.equal(endpoints.release({ endpointId: first.endpointId, generationId, ownerInstanceId: "owner-1", ownerFence: first.ownerFence }).code, "runtime.endpoint.fence_stale");
		assert.equal(endpoints.probe({ endpointId: first.endpointId, generationId, ownerInstanceId: "owner-1", ownerFence: first.ownerFence, consumerReady: true }).code, "runtime.endpoint.fence_stale");
		assert.equal(endpoints.reportDelivery({ endpointId: first.endpointId, generationId, ownerInstanceId: "owner-1", ownerFence: first.ownerFence, status: "delivered" }).code, "runtime.endpoint.fence_stale");
		assert.equal(endpoints.reportCapability({ endpointId: first.endpointId, generationId, ownerInstanceId: "owner-1", ownerFence: first.ownerFence, capability: capability(), evidence: { stale: true } }).code, "runtime.endpoint.fence_stale");
		assert.equal(endpoints.list(generationId).find((endpoint) => endpoint.ownerInstanceId === "owner-20")?.readiness, "uninitialized");
		clock.advance(61_000);
		assert.equal(endpoints.expire().length, 1);
		await owner.close();
		const reopened = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb }, { clock, ownerId: "gol42-fence-reconnect" });
		try {
			const reconnect = createEndpointService({ storage: reopened.runtimeEndpointStorage() }).claim({ generationId, routeKind: "control", ownerInstanceId: "owner-reconnect", deliveryMode: "native_channel", leaseMs: 60_000 });
			assert.equal(reconnect.ownerFence, 21, "reconnect allocates a strictly newer durable fence");
			assert.equal(reopened.runtimeEndpointStorage().list(generationId).filter((endpoint) => ["claiming", "healthy", "degraded"].includes(endpoint.state)).length, 1);
		} finally {
			await reopened.close();
		}
	} finally {
		try { await owner.close(); } catch { /* idempotent cleanup */ }
		home.cleanup();
	}
});

test("GOL-42 readiness/capability matrix", async () => {
	const home = createTemporaryHome("golem-gol42-readiness-");
	const owner = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb }, { clock: makeClock(), ownerId: "gol42-readiness-owner" });
	try {
		seed(owner);
		const endpoints = createEndpointService({ storage: owner.runtimeEndpointStorage() });
		const claim = endpoints.claim({ generationId, routeKind: "delivery", ownerInstanceId: "readiness-owner", deliveryMode: "native_channel", controlState: "enabled", leaseMs: 60_000 });
		assert(claim.endpointId && claim.ownerFence);
		const identity = { endpointId: claim.endpointId, generationId, ownerInstanceId: "readiness-owner", ownerFence: claim.ownerFence };
		assert.equal(endpoints.eligibility({ generationId, routeKind: "delivery", requiredCapability: "control.dispatch" }).code, "runtime.endpoint.health_unready");
		assert.equal(endpoints.reportHealth({ ...identity, state: "healthy" }).disposition, "accepted");
		assert.equal(endpoints.eligibility({ generationId, routeKind: "delivery", requiredCapability: "control.dispatch" }).code, "runtime.endpoint.readiness_unready");
		assert.equal(endpoints.probe({ ...identity, consumerReady: false }).disposition, "accepted");
		assert.equal(endpoints.eligibility({ generationId, routeKind: "delivery", requiredCapability: "control.dispatch" }).code, "runtime.endpoint.readiness_unready");
		assert.equal(endpoints.reportReadiness({ ...identity, deliveryMode: "native_channel", readiness: "ready" }).disposition, "accepted");
		assert.equal(endpoints.reportDelivery({ ...identity, status: "failed" }).disposition, "accepted");
		assert.equal(endpoints.reportDelivery({ ...identity, status: "delivered", readiness: "ready" }).disposition, "accepted");
		assert.equal(endpoints.eligibility({ generationId, routeKind: "delivery", requiredCapability: "control.dispatch" }).code, "runtime.endpoint.capability_unqualified");
		assert.equal(endpoints.reportCapability({ ...identity, capability: capability({ qualification: "unsupported", readiness: "unsupported" }), evidence: { registration: true } }).disposition, "accepted");
		assert.equal(endpoints.eligibility({ generationId, routeKind: "delivery", requiredCapability: "control.dispatch" }).code, "runtime.endpoint.capability_unqualified");
		assert.equal(endpoints.reportCapability({ ...identity, capability: capability({ qualification: "supported", readiness: "pull_only", observedAt: "2026-01-01T00:00:01.000Z" }), evidence: { consumed: false } }).disposition, "accepted");
		assert.equal(endpoints.eligibility({ generationId, routeKind: "delivery", requiredCapability: "control.dispatch" }).code, "runtime.endpoint.capability_unready");
		assert.equal(endpoints.reportCapability({ ...identity, capability: capability({ observedAt: "2026-01-01T00:00:02.000Z" }), evidence: { consumed: true } }).disposition, "accepted");
		const eligible = endpoints.eligibility({ generationId, routeKind: "delivery", requiredCapability: "control.dispatch" });
		assert.equal(eligible.disposition, "eligible");
		assert.equal(eligible.endpoint?.generationId, generationId);
		assert.equal(eligible.endpoint?.ownerFence, claim.ownerFence);
		assert.equal(eligible.capability?.qualification, "supported");
	} finally {
		await owner.close();
		home.cleanup();
	}
});
