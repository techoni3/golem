import assert from "node:assert/strict";
import test from "node:test";

import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import { createSessionService } from "@golem/runtime";
import { createTemporaryHome } from "@golem/testkit";

const uuid = (prefix, n) => `${prefix}_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = uuid("prj", 1);
const sessionId = uuid("ses", 2);
const generationOne = uuid("gen", 3);
const generationTwo = uuid("gen", 4);

function clock() {
	let value = 0;
	return { now: () => `2026-01-01T00:00:${String(value++).padStart(2, "0")}.000Z`, after: (ms) => `2026-01-01T00:00:${String(value + Math.ceil(ms / 1000)).padStart(2, "0")}.000Z` };
}

function signal(kind, eventNumber, sourceSeconds, generationId = generationOne, extra = {}) {
	const source = `2026-01-01T00:00:${String(sourceSeconds).padStart(2, "0")}.000Z`;
	return {
		schema_version: "golem.runtime-signal/v1",
		event_id: uuid("evt", eventNumber),
		event_kind: kind,
		producer: "fixture",
		producer_instance_id: uuid("prod", 10),
		producer_sequence: eventNumber,
		harness: eventNumber % 2 ? "claude" : "codex",
		correlation_id: uuid("evt", 99),
		deduplication_key: `fixture-${eventNumber}`,
		clocks: { source_observed_at: source, received_at: "2026-01-01T00:01:00.000Z", materialized_at: "2026-01-01T00:01:01.000Z" },
		provenance: { source: "adapter", confidence: "verified", evidence_id: `fixture-${eventNumber}` },
		clear_fields: [],
		payload: { kind, generation: { project_id: projectId, session_id: sessionId, generation_id: generationId }, ...extra },
	};
}

function seedProject(owner) {
	owner.runtimeProjectStorage().observe({
		projectId,
		name: "fixture",
		location: { locationId: uuid("loc", 5), canonicalPath: "/tmp/fixture", relation: "main", source: "register", evidence: { fixture: true }, observedAt: "2026-01-01T00:00:00.000Z" },
		source: "register",
		eventId: uuid("evt", 6),
		deduplicationKey: "project-fixture",
		payload: { kind: "project.observed" },
		provenance: { source: "api", confidence: "verified" },
		occurredAt: "2026-01-01T00:00:00.000Z",
	});
}

test("GOL-41 cross-harness lifecycle keeps actor activity separate from observation", async () => {
	const home = createTemporaryHome("golem-gol41-lifecycle-");
	const owner = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb }, { clock: clock(), ownerId: "gol41-lifecycle" });
	try {
		seedProject(owner);
		const service = createSessionService({ projects: owner.runtimeProjectStorage(), sessions: owner.runtimeSessionStorage() });
		assert.equal(service.apply(signal("session.started", 11, 1, generationOne, { metadata: { name: "alpha", model: "sonnet", role: "worker" } })).disposition, "accepted");
		assert.equal(service.apply(signal("session.activity", 12, 2)).disposition, "accepted");
		assert.equal(service.apply(signal("session.ended", 13, 3, generationOne, { disposition: "ended" })).disposition, "accepted");
		assert.equal(service.apply(signal("session.activity", 14, 4)).disposition, "accepted", "late actor activity may be observed without resurrecting terminal state");
		assert.equal(service.apply(signal("session.resumed", 15, 5, generationTwo, { resumed_from_generation_id: generationOne })).disposition, "accepted");
		const observed = service.observe({ projectId, sessionId, generationId: generationTwo, observedAt: "2026-01-01T00:02:00.000Z" });
		assert.equal(observed.disposition, "accepted");
		const staleObservation = service.observe({ projectId, sessionId, generationId: generationTwo, observedAt: "2026-01-01T00:01:59.000Z" });
		assert.equal(staleObservation.disposition, "ignored");
		assert.equal(staleObservation.revision, observed.revision);
		assert.equal(service.observe({ projectId, sessionId, generationId: uuid("gen", 99), observedAt: "2026-01-01T00:03:00.000Z" }).disposition, "rejected");
		const view = service.get(projectId, sessionId);
		assert(view);
		assert.deepEqual(view.metadata, { model: "sonnet", name: "alpha", role: "worker" });
		assert.equal(view.generations.length, 2);
		assert.equal(view.generations[0].state, "ended");
		assert.equal(view.generations[1].parentGenerationId, generationOne);
		assert.equal(view.activityAt, "2026-01-01T00:00:04.000Z");
		assert.equal(view.observedAt, "2026-01-01T00:02:00.000Z");
		assert.notEqual(view.activityAt, view.observedAt);
		const alias = { projectId, harness: "claude", aliasKind: "native_conversation", producerId: uuid("prod", 10), alias: "native-1", sessionId, generationId: generationTwo, source: "adapter", provenance: { event: "alias" } };
		assert.equal(owner.runtimeSessionStorage().attachAlias(alias).disposition, "accepted");
		assert.equal(owner.runtimeSessionStorage().findAlias(alias)?.sessionId, sessionId);
		assert.equal(owner.runtimeOutboxHealth().pending, 8, "accepted lifecycle, observation, and alias changes each emit one durable explanation");
	} finally {
		await owner.close();
		home.cleanup();
	}
});

test("GOL-41 reorder/restart/replay converges and aliases remain scoped", async () => {
	const run = async (order) => {
		const home = createTemporaryHome("golem-gol41-replay-");
		const owner = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb }, { clock: clock(), ownerId: `gol41-${order.join("-")}` });
		try {
			seedProject(owner);
			const service = createSessionService({ projects: owner.runtimeProjectStorage(), sessions: owner.runtimeSessionStorage() });
			for (const event of order) service.apply(event);
			const before = service.get(projectId, sessionId);
			await owner.close();
			const reopened = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb }, { clock: clock(), ownerId: `gol41-reopen-${order.join("-")}` });
			const after = createSessionService({ projects: reopened.runtimeProjectStorage(), sessions: reopened.runtimeSessionStorage() }).get(projectId, sessionId);
			await reopened.close();
			return { before, after, home };
		} catch (error) {
			await owner.close();
			home.cleanup();
			throw error;
		}
	};
	const events = [signal("session.started", 21, 1), signal("session.activity", 22, 3), signal("session.ended", 23, 2, generationOne, { disposition: "ended" })];
	const first = await run(events);
	const second = await run([events[2], events[0], events[1]]);
	assert.deepEqual(first.before, second.before, "source-time ordering is independent of receipt order");
	assert.deepEqual(first.after, first.before, "reopen preserves the same canonical projection");
	assert.equal(first.home.root !== second.home.root, true);
	first.home.cleanup();
	second.home.cleanup();

	const terminalOutcome = async (order) => {
		const home = createTemporaryHome("golem-gol41-terminal-");
		const owner = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb }, { clock: clock(), ownerId: `gol41-terminal-${order.join("-")}` });
		try {
			seedProject(owner);
			const service = createSessionService({ projects: owner.runtimeProjectStorage(), sessions: owner.runtimeSessionStorage() });
			const started = signal("session.started", 41, 1);
			const ended = signal("session.ended", 42, 2, generationOne, { disposition: "ended" });
			const errored = signal("session.ended", 43, 3, generationOne, { disposition: "errored" });
			for (const event of [started, ...order.map((index) => index === 0 ? ended : errored)]) service.apply(event);
			return service.get(projectId, sessionId);
		} finally {
			await owner.close();
			home.cleanup();
		}
	};
	const terminalFirst = await terminalOutcome([0, 1]);
	const terminalSecond = await terminalOutcome([1, 0]);
	assert.deepEqual(terminalFirst, terminalSecond, "terminal same-stage provenance must converge across receipt order");
	assert.equal(terminalFirst?.generations[0].state, "errored");

	const activityOutcome = async (order) => {
		const home = createTemporaryHome("golem-gol41-activity-");
		const owner = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb }, { clock: clock(), ownerId: `gol41-activity-${order.join("-")}` });
		try {
			seedProject(owner);
			const service = createSessionService({ projects: owner.runtimeProjectStorage(), sessions: owner.runtimeSessionStorage() });
			const events = [signal("session.started", 51, 1), signal("session.activity", 52, 5), signal("session.ended", 53, 6, generationOne, { disposition: "ended" }), signal("session.activity", 54, 2)];
			for (const index of order) service.apply(events[index]);
			return service.get(projectId, sessionId);
		} finally {
			await owner.close();
			home.cleanup();
		}
	};
	const activityFirst = await activityOutcome([0, 1, 2, 3]);
	const activitySecond = await activityOutcome([0, 3, 1, 2]);
	assert.deepEqual(activityFirst, activitySecond, "actor activity must use a monotonic source clock after terminal");
	assert.equal(activityFirst?.activityAt, "2026-01-01T00:00:05.000Z");

	const home = createTemporaryHome("golem-gol41-alias-scope-");
	const owner = openControlPlanePersistence({ runtimePath: home.runtimeDb, trackerPath: home.trackerDb }, { clock: clock(), ownerId: "gol41-alias" });
	try {
		seedProject(owner);
		const service = createSessionService({ projects: owner.runtimeProjectStorage(), sessions: owner.runtimeSessionStorage() });
		const resume = signal("session.resumed", 31, 2, generationTwo, { resumed_from_generation_id: generationOne });
		assert.equal(service.apply(resume).code, "runtime.session.generation_parent_pending");
		const started = service.apply(signal("session.started", 32, 1, generationOne));
		assert.equal(started.disposition, "accepted");
		const resumed = service.get(projectId, sessionId);
		assert(resumed);
		assert.equal(resumed.generations.filter((generation) => !["ended", "errored", "superseded"].includes(generation.state)).length, 1, "reverse resume must leave one live generation");
		assert.equal(resumed.generations.length, 2);
		const replayedOutbox = owner.claimRuntimeOutbox("gol41-replay-order", 20);
		const replayRevisions = replayedOutbox.filter((entry) => entry.destination === "tracker").map((entry) => entry.payload.revision).filter((value) => typeof value === "number");
		assert.deepEqual(replayRevisions, [1, 2], "pending replay effects follow transaction revision order");
		for (const entry of replayedOutbox) owner.ackRuntimeOutbox(entry.id, entry.claimToken);
		const alias = { projectId, harness: "claude", aliasKind: "native_run", alias: "missing", sessionId, source: "adapter", provenance: {} };
		assert.equal(owner.runtimeSessionStorage().attachAlias(alias).disposition, "accepted");
		const different = signal("session.started", 33, 3, uuid("gen", 7));
		different.payload.generation.session_id = uuid("ses", 8);
		const conflict = service.apply(different, alias);
		assert.equal(conflict.disposition, "review");
	} finally {
		await owner.close();
		home.cleanup();
	}
});
