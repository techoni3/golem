import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { composeControlPlaneTrackerServices } from "../../apps/control-plane/dist/tracker.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";
import { BusEventConflictError, EnvelopeConflictError } from "@golem/tracker";
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

test("delivery queue crash matrix", async () => {
	const home = createTemporaryHome("golem-j4-delivery-");
	const clock = createFixtureClock();
	const eligibility = createEligibility(clock);
	let writer;
	let services;
	try {
		({ writer, services } = openServices(home, clock, eligibility, "delivery-parent"));

		const first = services.delivery.enqueue(envelope("env-1", "recipient-a"));
		assert.equal(
			services.delivery.enqueue(envelope("env-1", "recipient-a")).id,
			first.id,
			"identical idempotency is a stable duplicate, not a second envelope",
		);
		assert.throws(
			() => services.delivery.enqueue(envelope("env-conflict", "recipient-a", { idempotencyKey: "key-env-1", payload: { changed: true } })),
			EnvelopeConflictError,
			"a reused idempotency key with different payload is rejected",
		);
		assert.throws(() => services.delivery.enqueue(envelope("env-semantic", "recipient-a", { idempotencyKey: "key-env-1", deadlineAt: clock.after(1) })), EnvelopeConflictError, "deadline is semantic idempotency input");
		assert.equal(services.delivery.enqueue(envelope("env-1", "recipient-a", { payload: { message: "env-1" } })).id, first.id, "canonical payload order/shape preserves duplicate identity");

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
		replyClaim.delivered();
		replyClaim.acknowledge("ack-reply");

		services.delivery.enqueue(envelope("env-stale", "recipient-stale", { maxAttempts: 2 }));
		const [staleClaim] = services.delivery.claim("worker-stale", 1, 5_000);
		assert(staleClaim, "stale-fence envelope is claimed before transport");
		eligibility.advance("recipient-stale");
		assert.deepEqual(staleClaim.prepare(), { kind: "stale", reason: "endpoint_changed" }, "fence change blocks transport and returns the claim to retrying");
		clock.advance(1_000);
		const [retryClaim] = services.delivery.claim("worker-retry", 1, 5_000);
		assert(retryClaim, "stale claim is eligible for a bounded retry");
		const failed = retryClaim.fail("Bearer ghp-abcdef123456", 1_000);
		assert.equal(failed.status, "dead_letter", "second bounded failure is observable permanent failure");
		assert.equal(services.audit().some((row) => JSON.stringify(row.details).includes("ghp-abcdef123456")), false, "audit redacts transport credentials");

		services.delivery.enqueue(envelope("env-lease", "recipient-lease"));
		const [oldClaim] = services.delivery.claim("worker-old", 1, 100);
		assert(oldClaim, "old worker owns the initial lease");
		clock.advance(101);
		const [newClaim] = services.delivery.claim("worker-new", 1, 5_000);
		assert(newClaim, "a new worker reclaims only the expired lease");
		assert.equal(oldClaim.acknowledge("stale-ack"), false, "expired claim cannot acknowledge after recovery");
		assert.throws(() => oldClaim.reply({ id: "stale-reply", idempotencyKey: "stale-reply", payload: {} }), /claim|reply/i, "expired claim cannot create a reply");
		newClaim.delivered();
		newClaim.acknowledge("fresh-ack");

		services.delivery.enqueue(envelope("env-deadline", "recipient-deadline", { deadlineAt: clock.after(5) }));
		clock.advance(6);
		assert.equal(services.delivery.recover().some((row) => row.id === "env-deadline" && row.status === "expired"), true, "deadline recovery expires an unclaimed envelope");

		const manual = services.subscriptions.subscribe({ id: "sub-manual", name: "ticket-audit", recipientId: "recipient-a", topic: "ticket/GOL-36", cursor: 0, manual: true });
		const event = services.bus.append({ id: "bus-1", deduplicationKey: "dedupe-bus-1", topic: "ticket/GOL-36", class: "tracker", payload: { action: "created" } });
		assert.equal(services.bus.append({ id: "bus-1", deduplicationKey: "dedupe-bus-1", topic: "ticket/GOL-36", class: "tracker", payload: { action: "created" } }).sequence, event.sequence, "duplicate bus delivery preserves its original sequence");
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
		const child = spawnSync(process.execPath, [worker], {
			cwd: repositoryRoot,
			encoding: "utf8",
			env: {
				...home.env,
				GOLEM_TRACKER_FIXTURE_NOW: clock.now(),
				GOLEM_TRACKER_FIXTURE_RECIPIENT: "recipient-crash",
			},
		});
		assert.equal(child.status, 0, `crash worker must claim then exit: ${child.stderr}`);
		assert.match(child.stdout, /env-crash/, "real child process claims the persisted envelope");
		clock.advance(5_001);
		({ writer, services } = openServices(home, clock, eligibility, "delivery-recovery"));
		assert.equal(services.delivery.recover().some((row) => row.id === "env-crash" && row.status === "retrying"), true, "restart replays the dead child lease without double settlement");
		const [recovered] = services.delivery.claim("worker-recovered", 1, 5_000);
		assert(recovered, "recovered envelope is claimed exactly once after its lease expires");
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
