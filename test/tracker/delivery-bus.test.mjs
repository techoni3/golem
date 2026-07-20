import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { composeControlPlaneTrackerServices } from "../../apps/control-plane/dist/tracker.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import {
	BusEventConflictError,
	EnvelopeConflictError,
	TrackerValidationError,
	trackerValidationLimits,
} from "@golem/tracker";
import { createTemporaryHome } from "@golem/testkit";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const worker = path.join(repositoryRoot, "test/tracker/delivery-worker.mjs");
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

function createFixtureClock(initial = "2026-07-20T00:00:00.000Z") {
	let current = initial;
	return Object.freeze({
		now: () => current,
		after: (milliseconds) => new Date(Date.parse(current) + milliseconds).toISOString(),
		advance: (milliseconds) => {
			current = new Date(Date.parse(current) + milliseconds).toISOString();
			return current;
		},
	});
}

function createEligibility(clock) {
	const fences = new Map();
	const unavailable = new Set();
	return Object.freeze({
		advance(recipientId) {
			fences.set(recipientId, (fences.get(recipientId) ?? 1) + 1);
		},
		unavailable(recipientId) {
			unavailable.add(recipientId);
		},
		resolve(recipientId) {
			if (unavailable.has(recipientId)) return undefined;
			return Object.freeze({
				recipientId,
				generationId: `gen_${recipientId}`,
				endpointId: `endpoint_${recipientId}`,
				ownerFence: fences.get(recipientId) ?? 1,
				readiness: "ready",
				mode: "next_turn",
				capabilities: [
					{
						capability: "delivery",
						qualification: "supported",
						observedAt: clock.now(),
					},
				],
			});
		},
	});
}

function openServices(home, clock, eligibility, ownerId) {
	const writer = openControlPlanePersistence(
		{
			runtimePath: home.runtimeDb,
			trackerPath: home.trackerDb,
			lockPath: path.join(home.root, "owner.lock"),
		},
		{ clock, ownerId },
	);
	return {
		writer,
		services: composeControlPlaneTrackerServices({ writer, eligibility, clock }),
	};
}

function envelope(id, recipientId, extra = {}) {
	return {
		id,
		idempotencyKey: `key-${id}`,
		senderId: "sender-a",
		recipientId,
		replyToRecipientId: "sender-a",
		kind: "ticket_dispatch",
		payload: { message: id },
		...extra,
	};
}

function claimChild(home, now, workerId) {
	const child = fork(worker, [], { cwd: repositoryRoot, env: { ...home.env, GOLEM_TRACKER_FIXTURE_NOW: now, GOLEM_TRACKER_FIXTURE_WORKER: workerId, GOLEM_TRACKER_FIXTURE_ROOT: home.root }, silent: true });
	const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); };
	const bounded = (label, register) => new Promise((resolve, reject) => {
		const timer = setTimeout(() => { stop(); reject(new Error(`${workerId} timed out waiting for ${label}`)); }, 5_000);
		register((value) => { clearTimeout(timer); resolve(value); });
	});
	const ready = bounded("READY", (resolve) => child.on("message", (message) => { if (message?.type === "READY") resolve(message); }));
	const claim = bounded("CLAIM", (resolve) => child.on("message", (message) => { if (message?.type === "CLAIM") resolve(message); }));
	const close = bounded("CLOSE", (resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
	child.once("error", stop);
	return { child, ready, claim, close, stop };
}

function durableTrackerCounts(home) {
	const database = new Database(home.trackerDb, { readonly: true, fileMustExist: true });
	try {
		return Object.freeze(
			Object.fromEntries(
				[
					"tracker_envelopes",
					"tracker_bus_events",
					"tracker_subscriptions",
					"tracker_passive_slots",
					"tracker_delivery_audit",
				].map((table) => [
					table,
					database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
				]),
			),
		);
	} finally {
		database.close();
	}
}

function persistedEnvelopeError(home, id) {
	const database = new Database(home.trackerDb, { readonly: true, fileMustExist: true });
	try {
		return database.prepare("SELECT last_error FROM tracker_envelopes WHERE id = ?").get(id)
			.last_error;
	} finally {
		database.close();
	}
}

test("delivery queue crash matrix", async () => {
	const home = createTemporaryHome("golem-j4-delivery-");
	const clock = createFixtureClock();
	const eligibility = createEligibility(clock);
	let writer;
	let services;
	try {
		({ writer, services } = openServices(home, clock, eligibility, "delivery-parent"));
		const deepPayload = {};
		let nested = deepPayload;
		for (let depth = 0; depth < 100; depth += 1) {
			nested.next = {};
			nested = nested.next;
		}
		const validationEnvelope = services.delivery.enqueue(
			envelope("env-validation", "recipient-a", {
				maxAttempts: trackerValidationLimits.maxAttempts,
				deadlineAt: clock.after(trackerValidationLimits.maxDeadlineHorizonMs),
			}),
		);
		assert.equal(
			validationEnvelope.maxAttempts,
			trackerValidationLimits.maxAttempts,
			"max-attempt and deadline horizon boundaries are accepted",
		);
		const [retryValidationClaim] = services.delivery.claim(
			"worker-validation",
			1,
			1,
		);
		assert(retryValidationClaim);
		assert.equal(retryValidationClaim.prepare().kind, "deliver");
		const durableBeforeInvalidInput = durableTrackerCounts(home);
		const invalidInputCases = [
			{
				name: "non-ISO delivery deadline",
				code: "invalid_deadline",
				run: () =>
					services.delivery.enqueue(
						envelope("env-invalid-date", "recipient-a", {
							deadlineAt: "not-a-date",
						}),
					),
			},
			{
				name: "nonpositive delivery attempts",
				code: "invalid_max_attempts",
				run: () =>
					services.delivery.enqueue(
						envelope("env-invalid-attempts", "recipient-a", { maxAttempts: 0 }),
					),
			},
			{
				name: "negative retry delay",
				code: "invalid_retry_delay",
				run: () => retryValidationClaim.fail("retry", -1),
			},
			{
				name: "blank bus identifier",
				code: "invalid_identifier",
				run: () =>
					services.bus.append({
						id: " ",
						deduplicationKey: "dedupe-invalid-id",
						topic: "validation/topic",
						class: "custom",
						payload: {},
					}),
			},
			{
				name: "duplicate subscription class",
				code: "invalid_subscription_class",
				run: () =>
					services.subscriptions.subscribe({
						name: "invalid-class",
						recipientId: "recipient-validation",
						topic: "validation/topic",
						classes: ["tracker", "tracker"],
					}),
			},
			{
				name: "negative subscription cursor",
				code: "invalid_cursor",
				run: () =>
					services.subscriptions.subscribe({
						name: "invalid-cursor",
						recipientId: "recipient-validation",
						topic: "validation/topic",
						cursor: -1,
					}),
			},
			{
				name: "unsafe subscription cursor range",
				code: "invalid_range",
				run: () => services.subscriptions.commit("sub-validation", 2, 1),
			},
			{
				name: "overdeep JSON payload",
				code: "invalid_json",
				run: () =>
					services.bus.append({
						id: "bus-invalid-depth",
						deduplicationKey: "dedupe-invalid-depth",
						topic: "validation/topic",
						class: "custom",
						payload: deepPayload,
					}),
			},
			{
				name: "oversize passive delta",
				code: "invalid_json",
				run: () =>
					services.passive.append({
						recipientId: "recipient-validation",
						ticketId: "GOL-36",
						category: "validation",
						baseline: { large: "x".repeat(trackerValidationLimits.maxJsonBytes) },
						value: {},
						eventId: "passive-invalid-size",
					}),
			},
			{
				name: "negative claim limit",
				code: "invalid_claim_limit",
				run: () => services.delivery.claim("worker-validation", -1, 1),
			},
			{
				name: "negative passive lease",
				code: "invalid_lease",
				run: () => services.passive.claim("recipient-validation", -1),
			},
		];
		for (const invalidCase of invalidInputCases) {
			assert.throws(
				invalidCase.run,
				(error) =>
					error instanceof TrackerValidationError && error.code === invalidCase.code,
				`${invalidCase.name} reports a stable service validation error`,
			);
		}
		assert.deepEqual(
			durableTrackerCounts(home),
			durableBeforeInvalidInput,
			"every invalid input is rejected before changing durable queue, bus, subscription, passive, or audit state",
		);
		const boundedIdentifier = "v".repeat(
			trackerValidationLimits.maxIdentifierLength,
		);
		const boundedSubscription = services.subscriptions.subscribe({
			id: boundedIdentifier,
			name: boundedIdentifier,
			recipientId: boundedIdentifier,
			topic: boundedIdentifier,
			classes: ["tracker", "lifecycle", "custom"],
			cursor: trackerValidationLimits.maxCursor,
		});
		assert.equal(
			boundedSubscription.cursor,
			trackerValidationLimits.maxCursor,
			"unique allowed classes and the maximum safe cursor are accepted",
		);
		assert.equal(
			boundedSubscription.id,
			boundedIdentifier,
			"maximum nonblank subscription id, name, recipient, and topic boundaries are accepted",
		);
		assert.deepEqual(
			services.delivery.claim(
				"worker-validation-boundary",
				trackerValidationLimits.maxClaimLimit,
				trackerValidationLimits.maxLeaseMs,
			),
			[],
			"maximum claim and lease boundaries are accepted without a competing pending envelope",
		);
		retryValidationClaim.delivered();
		retryValidationClaim.acknowledge("ack-validation");

		const first = services.delivery.enqueue(envelope("env-1", "recipient-a", { payload: { message: "env-1", nested: { b: [2, { c: 3 }], a: 1 } } }));
		assert.equal(
			services.delivery.enqueue(envelope("env-1", "recipient-a", { payload: { nested: { a: 1, b: [2, { c: 3 }] }, message: "env-1" } })).id,
			first.id,
			"identical idempotency is a stable duplicate, not a second envelope",
		);
		assert.throws(
			() => services.delivery.enqueue(envelope("env-conflict", "recipient-a", { idempotencyKey: "key-env-1", payload: { changed: true } })),
			EnvelopeConflictError,
			"a reused idempotency key with different payload is rejected",
		);
		assert.throws(() => services.delivery.enqueue(envelope("env-semantic", "recipient-a", { idempotencyKey: "key-env-1", deadlineAt: clock.after(1) })), EnvelopeConflictError, "deadline is semantic idempotency input");
		assert.equal(services.delivery.enqueue(envelope("env-1", "recipient-a", { payload: { nested: { a: 1, b: [2, { c: 3 }] }, message: "env-1" } })).id, first.id, "canonical nested payload order preserves duplicate identity");

		const [firstClaim] = services.delivery.claim("worker-a", 1, 5_000);
		assert(firstClaim, "one worker claims the only pending envelope");
		assert.equal(services.delivery.claim("worker-b", 1, 5_000).length, 0, "CAS claim prevents a second owner");
		assert.equal(firstClaim.prepare().kind, "deliver", "current endpoint fence permits transport");
		firstClaim.delivered();
		const reply = firstClaim.reply({ id: "env-1-reply", idempotencyKey: "key-env-1-reply", payload: { result: "ok" } });
		assert.equal(reply.parentId, first.id, "reply retains immutable parent/root route");
		assert.equal(firstClaim.acknowledge("ack-1", { accepted: true }), true, "ack is recorded against the current claim");
		assert.equal(firstClaim.acknowledge("ack-1", { accepted: true }), true, "duplicate acknowledgement is idempotent");
		const [replyClaim] = services.delivery.claim("worker-reply", 1, 5_000);
		assert(replyClaim, "reply becomes its own durable envelope");
		assert.equal(replyClaim.prepare().kind, "deliver");
		replyClaim.delivered();
		replyClaim.acknowledge("ack-reply");

		services.delivery.enqueue(envelope("env-stale", "recipient-stale", { maxAttempts: 2 }));
		const [staleClaim] = services.delivery.claim("worker-stale", 1, 5_000);
		assert(staleClaim, "stale-fence envelope is claimed before transport");
		eligibility.advance("recipient-stale");
		assert.deepEqual(staleClaim.prepare(), { kind: "stale", reason: "endpoint_changed" }, "fence change blocks transport and returns the claim to retrying");
		assert.throws(() => staleClaim.delivered(), /successful current prepare/, "stale-fence caller cannot bypass prepare to settle transport");
		clock.advance(1_000);
		const [retryClaim] = services.delivery.claim("worker-retry", 1, 5_000);
		assert(retryClaim, "stale claim is eligible for a bounded retry");
		assert.equal(retryClaim.prepare().kind, "stale", "retry still rechecks its original stale fence");
		services.delivery.enqueue(envelope("env-fail", "recipient-fail", { maxAttempts: 1 }));
		const [failureClaim] = services.delivery.claim("worker-fail", 1, 5_000);
		assert(failureClaim);
		assert.equal(failureClaim.prepare().kind, "deliver");
		const failed = failureClaim.fail(
			"Bearer ghp-abcdef123456 failed at /Users/example/.golem/token",
			1_000,
		);
		assert.equal(failed.status, "dead_letter", "second bounded failure is observable permanent failure");
		assert.equal(services.audit().some((row) => JSON.stringify(row.details).includes("ghp-abcdef123456")), false, "audit redacts transport credentials");
		assert.doesNotMatch(
			persistedEnvelopeError(home, "env-fail"),
			/ghp-abcdef123456|\/Users\/example/u,
			"storage receives only the service-sanitized transport diagnostic",
		);

		services.delivery.enqueue(envelope("env-lease", "recipient-lease"));
		const [oldClaim] = services.delivery.claim("worker-old", 1, 100);
		assert(oldClaim, "old worker owns the initial lease");
		assert.equal(oldClaim.prepare().kind, "deliver", "old worker prepared while its fence and lease were current");
		clock.advance(101);
		const [newClaim] = services.delivery.claim("worker-new", 1, 5_000);
		assert(newClaim, "a new worker reclaims only the expired lease");
		assert.equal(oldClaim.acknowledge("stale-ack"), false, "reclaimed claim token cannot acknowledge");
		assert.throws(() => oldClaim.reply({ id: "stale-reply", idempotencyKey: "stale-reply", payload: {} }), /claim|reply/i, "reclaimed claim token cannot create a reply");
		assert.throws(() => oldClaim.delivered(), /no longer current/, "reclaimed claim token cannot settle delivered");
		assert.throws(() => oldClaim.fail("late"), /no longer current/, "reclaimed claim token cannot settle failure");
		assert.equal(newClaim.prepare().kind, "deliver");
		newClaim.delivered();
		newClaim.acknowledge("fresh-ack");

		services.delivery.enqueue(envelope("env-deadline", "recipient-deadline", { deadlineAt: clock.after(5) }));
		clock.advance(6);
		assert.equal(services.delivery.recover().some((row) => row.id === "env-deadline" && row.status === "expired"), true, "deadline recovery expires an unclaimed envelope");

		const manual = services.subscriptions.subscribe({ id: "sub-manual", name: "ticket-audit", recipientId: "recipient-a", topic: "ticket/GOL-36", cursor: 0, manual: true });
		const event = services.bus.append({ id: "bus-1", deduplicationKey: "dedupe-bus-1", topic: "ticket/GOL-36", class: "tracker", payload: { action: "created", nested: { b: [2, { c: 3 }], a: 1 } } });
		assert.equal(services.bus.append({ id: "bus-1", deduplicationKey: "dedupe-bus-1", topic: "ticket/GOL-36", class: "tracker", payload: { nested: { a: 1, b: [2, { c: 3 }] }, action: "created" } }).sequence, event.sequence, "nested reordered bus payload preserves its original sequence");
		assert.throws(
			() => services.bus.append({ id: "bus-2", deduplicationKey: "dedupe-bus-1", topic: "ticket/GOL-36", class: "tracker", payload: { action: "changed" } }),
			BusEventConflictError,
			"conflicting bus deduplication is rejected",
		);
		const pending = services.subscriptions.pending(manual.id);
		assert.deepEqual(pending?.events.map((row) => row.id), ["bus-1"], "offline-safe named cursor sees ordered event history");
		assert.equal(services.subscriptions.commit(manual.id, 0, event.sequence), true, "cursor commit is compare-and-swap");
		assert.equal(services.subscriptions.commit(manual.id, 0, event.sequence), false, "stale cursor commit cannot overwrite a later cursor");
		const offline = services.subscriptions.subscribe({ id: "sub-offline", name: "offline", recipientId: "recipient-b", topic: "ticket/GOL-36", status: "offline" });
		services.bus.append({ id: "bus-3", deduplicationKey: "dedupe-bus-3", topic: "ticket/GOL-36", class: "lifecycle", payload: { action: "updated" } });
		assert.equal(services.subscriptions.pending(offline.id), undefined, "offline subscription advances no unsolicited turn");
		assert.equal(services.prune(clock.after(1)).events, 0, "offline unread event is protected from prune");
		const reactivated = services.subscriptions.subscribe({ name: "offline", recipientId: "recipient-b", topic: "ticket/GOL-36", status: "active" });
		assert.deepEqual(services.subscriptions.pending(reactivated.id)?.events.map((row) => row.id), ["bus-1", "bus-3"], "reactivated offline cursor replays ordered unread events");
		assert.equal(services.subscriptions.commit(reactivated.id, 0, 2), true, "reactivated cursor commits monotonically");
		assert.equal(services.subscriptions.subscribe({ name: "offline", recipientId: "recipient-b", topic: "ticket/GOL-36", cursor: 0 }).cursor, 2, "ordinary upsert cannot rewind cursor");
		assert.equal(services.prune(clock.after(1)).events, 1, "consumed history prunes only after all active/offline cursors advance");
		const remaining = services.subscriptions.pending(manual.id);
		assert.equal(services.subscriptions.commit(manual.id, event.sequence, remaining?.toSequence ?? event.sequence), true, "manual cursor records the later lifecycle event");
		assert.equal(services.prune(clock.after(2)).events, 1, "prune removes lifecycle history only after the manual cursor commits it");

		services.passive.append({ recipientId: "recipient-passive", ticketId: "GOL-36", category: "status", baseline: { state: "open" }, value: { state: "built" }, eventId: "passive-1" });
		const passive = services.passive.claim("recipient-passive", 5_000);
		assert(passive, "passive slot produces a lease-backed batch only when explicitly claimed");
		services.passive.append({ recipientId: "recipient-passive", ticketId: "GOL-36", category: "status", baseline: { state: "open" }, value: { state: "done" }, eventId: "passive-2" });
		assert.equal(services.delivery.claim("worker-passive", 1, 5_000).length, 0, "passive slots do not create an unsolicited delivery turn");
		assert.equal(services.passive.release("recipient-passive", passive.leaseId), true, "released passive lease remains replayable");
		const replayedPassive = services.passive.claim("recipient-passive", 5_000);
		assert(replayedPassive, "released batch replays its same coalesced slot");
		assert.equal(services.passive.commit("recipient-passive", replayedPassive.leaseId), true, "commit deletes only the lease-owned batch");
		assert.deepEqual(services.passive.claim("recipient-passive")?.entries.map((entry) => entry.value), [{ state: "done" }], "update during lease survives into the next passive batch");
		assert(services.audit().some((row) => row.kind === "tracker.pruned"), "prune leaves an audit fact");

		services.delivery.enqueue(envelope("env-crash", "recipient-crash"));
		await writer.close();
		writer = undefined;
		const childA = claimChild(home, clock.now(), "process-a");
		const childB = claimChild(home, clock.now(), "process-b");
		await Promise.all([childA.ready, childB.ready]);
		childA.child.send({ type: "RELEASE" }); childB.child.send({ type: "RELEASE" });
		const [resultA, resultB] = await Promise.all([childA.claim, childB.claim]);
		assert.equal([resultA, resultB].filter((result) => result.claimed).length, 1, "one real service child owns the durable claim");
		const winner = resultA.claimed ? childA.child : childB.child;
		const winnerHandle = resultA.claimed ? childA : childB;
		const loserHandle = resultA.claimed ? childB : childA;
		const winnerClose = winnerHandle.close; const loserClose = loserHandle.close;
		winner.kill("SIGKILL");
		assert.deepEqual(await winnerClose, { code: null, signal: "SIGKILL" }, "winner is killed before owner.close");
		assert.deepEqual(await loserClose, { code: 0, signal: null }, "loser closes normally");
		clock.advance(5_001);
		({ writer, services } = openServices(home, clock, eligibility, "delivery-recovery"));
		assert.equal(services.delivery.recover().some((row) => row.id === "env-crash" && row.status === "retrying"), true, "restart replays the dead child lease without double settlement");
		const [recovered] = services.delivery.claim("worker-recovered", 1, 5_000);
		assert(recovered, "recovered envelope is claimed exactly once after its lease expires");
		assert.equal(recovered.prepare().kind, "deliver");
		recovered.delivered();
		recovered.acknowledge("ack-crash");
		await writer.close();
		writer = undefined;

		const database = new Database(home.trackerDb, { readonly: true, fileMustExist: true });
		try {
			const finalCrash = database.prepare("SELECT status, attempts FROM tracker_envelopes WHERE id = ?").get("env-crash");
			assert.deepEqual(finalCrash, { status: "acknowledged", attempts: 2 }, "SQLite retains one recovered envelope with two bounded claims");
			assert.equal(database.pragma("integrity_check", { simple: true }), "ok", "real tracker SQLite remains internally consistent");
		} finally {
			database.close();
		}
	} finally {
		if (writer) await writer.close();
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false, "J4 leaves no temporary GOLEM_HOME state");
	}
});

test("bus offline replay", async () => {
	const home = createTemporaryHome("golem-j4-bus-offline-");
	const clock = createFixtureClock();
	const eligibility = createEligibility(clock);
	let writer;
	try {
		const opened = openServices(home, clock, eligibility, "bus-offline");
		writer = opened.writer;
		const offline = opened.services.subscriptions.subscribe({ id: "offline-replay", name: "offline-replay", recipientId: "recipient-offline", topic: "ticket/GOL-36", status: "offline" });
		opened.services.bus.append({ id: "offline-event-1", deduplicationKey: "offline-dedupe-1", topic: "ticket/GOL-36", class: "tracker", payload: { ordinal: 1 } });
		opened.services.bus.append({ id: "offline-event-2", deduplicationKey: "offline-dedupe-2", topic: "ticket/GOL-36", class: "lifecycle", payload: { ordinal: 2 } });
		assert.equal(opened.services.subscriptions.pending(offline.id), undefined, "offline subscriber receives no unsolicited turn");
		assert.equal(opened.services.prune(clock.after(1)).events, 0, "offline unread cursor protects both events");
		const active = opened.services.subscriptions.subscribe({ name: "offline-replay", recipientId: "recipient-offline", topic: "ticket/GOL-36", status: "active" });
		const pending = opened.services.subscriptions.pending(active.id);
		assert.deepEqual(pending?.events.map((event) => event.id), ["offline-event-1", "offline-event-2"], "reactivation replays events in durable sequence");
		assert.equal(opened.services.subscriptions.commit(active.id, 0, pending?.toSequence ?? 0), true, "cursor commit is CAS-bound and monotonic");
		assert.equal(opened.services.subscriptions.subscribe({ name: "offline-replay", recipientId: "recipient-offline", topic: "ticket/GOL-36", cursor: 0 }).cursor, 2, "resubscribe does not rewind committed cursor");
	} finally {
		if (writer) await writer.close();
		home.cleanup();
	}
});
