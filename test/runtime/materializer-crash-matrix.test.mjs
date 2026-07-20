import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	createRuntimeMaterializer,
	RuntimeEngineScheduler,
	RuntimeOutboxDrainer,
} from "@golem/runtime";
import { createTemporaryHome, waitFor } from "@golem/testkit";
import { startControlPlane } from "../../apps/control-plane/dist/index.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const childFixture = path.join(repositoryRoot, "test/runtime/materializer-child.mjs");
const producerFixture = path.join(repositoryRoot, "test/runtime/inbox-producer.mjs");
const outboxConsumerFixture = path.join(
	repositoryRoot,
	"test/runtime/outbox-consumer-child.mjs",
);
const require = createRequire(new URL("../../packages/persistence/package.json", import.meta.url));
const Database = require("better-sqlite3");

function id(prefix, number) {
	return `${prefix}_00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function createClock() {
	let value = "2026-07-20T00:00:00.000Z";
	return {
		now: () => value,
		after: (milliseconds) => new Date(Date.parse(value) + milliseconds).toISOString(),
		advance: (milliseconds) => {
			value = new Date(Date.parse(value) + milliseconds).toISOString();
		},
	};
}

function signal(number, options = {}) {
	const eventId = options.eventId ?? id("evt", number);
	const producer = options.producer ?? id("prod", number);
	return {
		schema_version: "golem.runtime-signal/v1",
		event_id: eventId,
		event_kind: "project.observed",
		producer: "fixture",
		producer_instance_id: producer,
		harness: "claude",
		...(options.sequence === undefined ? {} : { producer_sequence: options.sequence }),
		correlation_id: `corr-${number}`,
		deduplication_key: options.deduplicationKey ?? `dedupe-${number}`,
		clocks: {
			source_observed_at: "2026-07-20T00:00:00.000Z",
			received_at: "2026-07-20T00:00:01.000Z",
		},
		provenance: { source: "adapter", confidence: "verified", evidence_id: `evidence-${number}` },
		clear_fields: [],
		payload: {
			kind: "project.observed",
			project: { project_id: id("prj", number) },
			location: {
				project_id: id("prj", number),
				location_id: id("loc", number),
				relation: "registered",
				canonical_path: `/temporary/project-${number}`,
			},
		},
	};
}

function openOwner(home, clock) {
	return openControlPlanePersistence(
		{ runtimePath: home.runtimeDb, trackerPath: home.trackerDb },
		{ clock },
	);
}

function count(database, where = "1 = 1") {
	return database.prepare(`SELECT COUNT(*) AS count FROM runtime_outbox WHERE ${where}`).get().count;
}

function countRows(database, table) {
	return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function runProducer(home, envelope) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [producerFixture], {
			cwd: repositoryRoot,
			env: {
				...home.env,
				GOLEM_RUNTIME_TEST_HOME: home.root,
				GOLEM_RUNTIME_TEST_SIGNAL: JSON.stringify(envelope),
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`independent runtime producer exited ${code}: ${stderr}`));
		});
	});
}

function deliverThroughConsumerChild({ databasePath, id: deliveryId, payload, crashAfterWrite }) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [outboxConsumerFixture], {
			cwd: repositoryRoot,
			env: {
				GOLEM_RUNTIME_CONSUMER_DB: databasePath,
				GOLEM_RUNTIME_CONSUMER_ID: deliveryId,
				GOLEM_RUNTIME_CONSUMER_PAYLOAD: JSON.stringify(payload),
				GOLEM_RUNTIME_CONSUMER_CRASH_AFTER_WRITE: crashAfterWrite ? "1" : "0",
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`outbox consumer child exited ${code}: ${stderr}`));
		});
	});
}

async function crashChild(home, failpoint, envelope) {
	const child = spawn(process.execPath, [childFixture], {
		cwd: repositoryRoot,
		env: {
			...home.env,
			GOLEM_RUNTIME_TEST_HOME: home.root,
			GOLEM_RUNTIME_TEST_DB: home.runtimeDb,
			GOLEM_RUNTIME_TEST_TRACKER_DB: home.trackerDb,
			GOLEM_RUNTIME_TEST_FAILPOINT: failpoint,
			GOLEM_RUNTIME_TEST_CLAIM_LEASE_MS: "10",
			...(envelope ? { GOLEM_RUNTIME_TEST_SIGNAL: JSON.stringify(envelope) } : {}),
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	await waitFor(
		() => (child.exitCode === null ? undefined : true),
		`runtime materializer ${failpoint} crash`,
		10_000,
	);
	assert.equal(
		child.exitCode,
		failpoint === "before_publish" ? 73 : 74,
		`child must crash at ${failpoint}: ${stderr}`,
	);
}

async function waitForLeaseExpiry() {
	const deadline = Date.now() + 20;
	await waitFor(
		() => (Date.now() >= deadline ? true : undefined),
		"short runtime inbox claim lease expiry",
		1_000,
	);
}

test("J3 durable inbox materializer crash/concurrency/outbox matrix", async (t) => {
	const home = createTemporaryHome("golem-j3-runtime-engine-");
	const clock = createClock();
	let owner;
	try {
		owner = openOwner(home, clock);
		let runtime = createRuntimeMaterializer({
			home: home.root,
			writer: owner,
			inboxOptions: { claimLeaseMs: 10 },
		});
		const staticDirectory = path.join(home.root, "control-plane-static");
		fs.mkdirSync(staticDirectory, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(staticDirectory, "index.html"), "<!doctype html><title>runtime J3</title>");
		let controlPlane;
		try {
			controlPlane = await startControlPlane({
				token: home.token,
				stateDirectory: path.join(home.root, "control-plane-state"),
				staticDirectory,
				runtimeIngress: runtime.inbox,
			});
			const ingressSignal = signal(9_999);
			const unauthorized = await fetch(`${controlPlane.origin}/api/v1/runtime/events`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(ingressSignal),
			});
			assert.equal(unauthorized.status, 401, "runtime POST rejects a producer without bearer authority");
			const accepted = await fetch(`${controlPlane.origin}/api/v1/runtime/events`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${home.token}` },
				body: JSON.stringify(ingressSignal),
			});
			assert.equal(accepted.status, 202, "authenticated runtime POST only acknowledges durable spool");
			assert.equal(runtime.materializer.drain().materialized, 1, "the service, not HTTP ingress, writes SQLite");
		} catch (error) {
			if (!/(?:EPERM|EACCES).*listen|listen.*(?:EPERM|EACCES)/iu.test(String(error))) throw error;
			t.diagnostic("UNMET: sandbox rejected the real 127.0.0.1 authenticated-ingress boundary (EPERM)");
		} finally {
			await controlPlane?.close();
		}

		const archiveBeforeProducers = runtime.inbox.metrics().archived;
		const producerSignals = Array.from({ length: 100 }, (_, index) => signal(index + 1));
		await Promise.all([
			...producerSignals.map((entry) => runProducer(home, entry)),
			...producerSignals.slice(0, 10).map((entry) => runProducer(home, entry)),
		]);
		assert.equal(runtime.inbox.metrics().pending, 100, "100 independent producers plus duplicate ids yield one atomic pending file per event");
		const first = runtime.materializer.drain();
		assert.equal(first.materialized, 100, "each unique independent producer materializes exactly once");
		assert.equal(runtime.inbox.metrics().archived, archiveBeforeProducers + 100, "archive assertion accounts for authenticated ingress before the producer matrix");

		const orderedProducer = id("prod", 900);
		runtime.inbox.accept(signal(900, { producer: orderedProducer, sequence: 2 }));
		runtime.inbox.accept(signal(901, { producer: orderedProducer, sequence: 1 }));
		const ordered = runtime.materializer.drain();
		assert.equal(ordered.materialized, 1);
		assert.equal(ordered.stale, 1, "out-of-order event remains an auditable stale fact");

		await owner.close();
		owner = undefined;
		const prePublishSignal = signal(950);
		await crashChild(home, "before_publish", prePublishSignal);
		assert.equal(runtime.inbox.metrics().pending, 0, "producer killed after fsync but before publish leaves no partial pending envelope");

		for (const [index, failpoint] of ["after_claim", "before_transaction", "after_commit", "before_archive"].entries()) {
			const crashSignal = signal(1_000 + index);
			runtime.inbox.accept(crashSignal);
			await crashChild(home, failpoint);
			await waitForLeaseExpiry();
			owner = openOwner(home, clock);
			runtime = createRuntimeMaterializer({ home: home.root, writer: owner, inboxOptions: { claimLeaseMs: 10 } });
			const recovered = runtime.materializer.drain();
			assert.equal(runtime.inbox.metrics().pending, 0, `${failpoint} restart leaves no pending envelope`);
			assert.equal(runtime.inbox.metrics().processing, 0, `${failpoint} restart reclaims only the expired lease`);
			assert.equal(recovered.materialized + recovered.duplicated, 1, `${failpoint} materializes once or deduplicates a committed source`);
			await owner.close();
			owner = undefined;
		}

		owner = openOwner(home, clock);
		let leaseNow = 100;
		runtime = createRuntimeMaterializer({
			home: home.root,
			writer: owner,
			inboxOptions: { now: () => leaseNow, claimLeaseMs: 10 },
		});
		runtime.inbox.accept(signal(1_500));
		assert.equal(runtime.inbox.claim(1).length, 1, "claim owns the envelope before a materializer effect");
		assert.equal(runtime.inbox.reclaimProcessing(), 0, "an active lease is never reclaimed eagerly");
		leaseNow += 11;
		assert.equal(runtime.inbox.reclaimProcessing(), 1, "only an expired lease becomes recoverable work");
		assert.equal(runtime.materializer.drain().materialized, 1, "expired work resumes through the normal transaction path");

		let poisonNow = 1_000;
		const poison = createRuntimeMaterializer({
			home: home.root,
			writer: owner,
			inboxOptions: { now: () => poisonNow, maxAttempts: 3 },
			handlers: [{ kinds: ["project.observed"], materialize: () => { throw new Error("Bearer ghp-abcdef123456"); } }],
		});
		poison.inbox.accept(signal(1_600));
		assert.equal(poison.materializer.drain().retrying, 1, "first poison effect retains bounded retry metadata");
		poisonNow += 500;
		const pendingPoisonHealth = poison.inbox.metrics();
		assert.equal(pendingPoisonHealth.retrying, 1, "retry health exposes the deferred poison envelope");
		assert.equal(pendingPoisonHealth.oldestRetryAgeMs, 500, "inbox retry age is positive and bounded while retry work is pending");
		const retryMetadata = fs.readFileSync(path.join(poison.inbox.root, "retry", `${id("evt", 1_600)}.json`), "utf8");
		assert(!retryMetadata.includes("ghp-abcdef123456"), "retry metadata redacts bearer credentials");
		poisonNow += 500;
		assert.equal(poison.materializer.drain().retrying, 1, "second poison effect is deferred with backoff");
		poisonNow += 2_000;
		assert.equal(poison.materializer.drain().quarantined, 1, "third poison effect becomes inspectable quarantine evidence");
		assert.equal(poison.inbox.metrics().quarantined >= 1, true);
		const quarantineNames = fs.readdirSync(path.join(poison.inbox.root, "quarantine"));
		const poisonMetadata = quarantineNames.find((name) => name.endsWith(".metadata.json"));
		assert(poisonMetadata, "poison quarantine writes bounded metadata");
		assert(!fs.readFileSync(path.join(poison.inbox.root, "quarantine", poisonMetadata), "utf8").includes("ghp-abcdef123456"), "poison metadata redacts bearer credentials");

		const noClobber = signal(1_700);
		runtime.inbox.accept(noClobber);
		assert.equal(runtime.materializer.drain().materialized, 1);
		const archivedPath = path.join(runtime.inbox.root, "archived", `${noClobber.event_id}.json`);
		const originalArchive = fs.readFileSync(archivedPath);
		const conflictingRaw = Buffer.from(JSON.stringify({ ...noClobber, deduplication_key: "different-but-same-id" }));
		fs.writeFileSync(path.join(runtime.inbox.root, "pending", `${noClobber.event_id}.json`), conflictingRaw, { mode: 0o600 });
		assert.equal(runtime.materializer.drain().duplicated, 1, "committed-but-unarchived replay remains a duplicate transaction");
		assert.deepEqual(fs.readFileSync(archivedPath), originalArchive, "archive never overwrites the original raw envelope");
		assert.equal(runtime.inbox.metrics().quarantined >= 2, true, "conflicting replay is preserved outside the archive");

		const consumerPath = path.join(home.root, "outbox-consumer.db");
		const consumer = new Database(consumerPath);
		consumer.exec("CREATE TABLE deliveries (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)");
		const successDrainer = new RuntimeOutboxDrainer({
			writer: owner,
			workerId: "runtime-j3-baseline-drainer",
			destinations: { tracker: { deliver: async ({ id: deliveryId, payload }) => { consumer.prepare("INSERT OR IGNORE INTO deliveries(id, payload_json) VALUES (?, ?)").run(deliveryId, JSON.stringify(payload)); } } },
		});
		while ((await successDrainer.drain(100)).claimed > 0) undefined;

		const runtimeDatabase = new Database(home.runtimeDb, { readonly: true });
		try {
			assert.equal(count(runtimeDatabase, "status = 'pending'"), 0, "baseline delivery has no pending rows");
			runtime.inbox.accept(signal(1_799));
			assert.equal(runtime.materializer.drain().materialized, 1);
			const crashingConsumerDrainer = new RuntimeOutboxDrainer({
				writer: owner,
				workerId: "runtime-j3-consumer-crash",
				destinations: {
					tracker: {
						deliver: async (delivery) =>
							deliverThroughConsumerChild({
								databasePath: consumerPath,
								id: delivery.id,
								payload: delivery.payload,
								crashAfterWrite: true,
							}),
					},
				},
			});
			assert.equal((await crashingConsumerDrainer.drain(1)).deferred, 1, "a real idempotent consumer child writes then exits before acknowledgement");
			clock.advance(1_000);
			const restartedConsumerDrainer = new RuntimeOutboxDrainer({
				writer: owner,
				workerId: "runtime-j3-consumer-restart",
				destinations: {
					tracker: {
						deliver: async (delivery) =>
							deliverThroughConsumerChild({
								databasePath: consumerPath,
								id: delivery.id,
								payload: delivery.payload,
								crashAfterWrite: false,
							}),
					},
				},
			});
			assert.equal((await restartedConsumerDrainer.drain(1)).acknowledged, 1, "a restarted drainer redelivers after the child crash and completes ack CAS");
			assert.equal(countRows(consumer, "deliveries"), count(runtimeDatabase, "status = 'published'"), "consumer crash/restart preserves one idempotency row per published outbox id");
			runtime.inbox.accept(signal(1_800));
			assert.equal(runtime.materializer.drain().materialized, 1);
			const failingDrainer = new RuntimeOutboxDrainer({
				writer: owner,
				workerId: "runtime-j3-failing-drainer",
				destinations: { tracker: { deliver: async () => { throw new Error("Bearer ghp-abcdef123456"); } } },
			});
			assert.deepEqual(await failingDrainer.drain(1), { claimed: 1, acknowledged: 0, acknowledgementConflicts: 0, failureConflicts: 0, deferred: 1, permanentFailures: 0 }, "first failure records one pending retry transition");
			let retryRow = runtimeDatabase.prepare("SELECT status, attempts, last_error FROM runtime_outbox WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1").get();
			assert.deepEqual({ status: retryRow.status, attempts: retryRow.attempts }, { status: "pending", attempts: 1 }, "outbox persists exact pending/attempt state after a transient failure");
			assert(!retryRow.last_error.includes("ghp-abcdef123456"), "outbox bearer errors are redacted before persistence");
			clock.advance(500);
			const pendingOutboxHealth = owner.runtimeOutboxHealth();
			assert.equal(pendingOutboxHealth.oldestRetryAgeMs, 500, "outbox retry age is positive and bounded while a transient retry is pending");
			assert(!JSON.stringify(pendingOutboxHealth).includes("ghp-abcdef123456"), "payload-free health never leaks a bearer credential");
			clock.advance(500);
			assert.deepEqual(await failingDrainer.drain(1), { claimed: 1, acknowledged: 0, acknowledgementConflicts: 0, failureConflicts: 0, deferred: 1, permanentFailures: 0 }, "second transient failure records deterministic backoff state");
			clock.advance(2_000);
			assert.deepEqual(await successDrainer.drain(1), { claimed: 1, acknowledged: 1, acknowledgementConflicts: 0, failureConflicts: 0, deferred: 0, permanentFailures: 0 }, "replayed delivery reaches published through ack CAS");
			assert.equal(count(runtimeDatabase, "status = 'published'"), count(runtimeDatabase), "all current outbox rows are published after successful replay");

			runtime.inbox.accept(signal(1_801));
			assert.equal(runtime.materializer.drain().materialized, 1);
			const ackRaceDrainer = new RuntimeOutboxDrainer({
				writer: owner,
				workerId: "runtime-j3-ack-race",
				destinations: { tracker: { deliver: async () => { clock.advance(31_000); owner.replayRuntimeOutbox(); } } },
			});
			const ackRace = await ackRaceDrainer.drain(1);
			assert.equal(ackRace.acknowledgementConflicts, 1, "ack CAS loss is explicit accounting, never a silent success");
			clock.advance(1_000);
			assert.equal((await successDrainer.drain(1)).acknowledged, 1, "expired delivery remains replayable after an ack CAS race");

			runtime.inbox.accept(signal(1_802));
			assert.equal(runtime.materializer.drain().materialized, 1);
			for (let attempt = 1; attempt <= 5; attempt += 1) {
				const result = await failingDrainer.drain(1);
				if (attempt < 5) assert.equal(result.deferred, 1);
				else assert.equal(result.permanentFailures, 1, "fifth bounded failure becomes observable permanent failure");
				clock.advance(60_000);
			}
			assert.equal(count(runtimeDatabase, "status = 'permanent_failure'"), 1, "permanent state is durable and queryable");

			runtime.inbox.accept(signal(1_803));
			const scheduler = new RuntimeEngineScheduler({ materializer: runtime.materializer, outbox: successDrainer, writer: owner, intervalMs: 25 });
			await scheduler.start();
			const health = scheduler.health();
			assert(health.lastSuccessfulMaterializationAt, "scheduler records last successful materialization");
			assert.equal(health.outbox.permanentFailures, 1, "scheduler health exposes permanent delivery failures");
			assert.equal(typeof health.outbox.oldestRetryAgeMs, "undefined", "published work does not report a retry age");
			await scheduler.stop();
			assert.equal(countRows(consumer, "deliveries"), count(runtimeDatabase, "status = 'published'"), "consumer idempotency key records every published cross-store delivery exactly once");
			assert.equal(runtimeDatabase.prepare("SELECT COUNT(*) AS count FROM runtime_events WHERE disposition = 'stale'").get().count, 1, "stale ordering remains durable and queryable");
		} finally {
			runtimeDatabase.close();
			consumer.close();
		}
	} finally {
		if (owner) await owner.close();
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false, "temporary runtime home is always removed");
	}
});
