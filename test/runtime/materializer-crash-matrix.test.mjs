import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createRuntimeMaterializer, RuntimeOutboxDrainer } from "@golem/runtime";
import { createTemporaryHome, waitFor } from "@golem/testkit";
import { startControlPlane } from "../../apps/control-plane/dist/index.js";
import { openControlPlanePersistence } from "../../apps/control-plane/dist/persistence.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const childFixture = path.join(repositoryRoot, "test/runtime/materializer-child.mjs");
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

function count(database, table) {
	return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
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

test("J3 durable inbox materializer crash/concurrency/outbox matrix", async (t) => {
	const home = createTemporaryHome("golem-j3-runtime-engine-");
	const clock = createClock();
	let owner;
	try {
		owner = openOwner(home, clock);
		const { inbox, materializer } = createRuntimeMaterializer({ home: home.root, writer: owner });
		const staticDirectory = path.join(home.root, "control-plane-static");
		fs.mkdirSync(staticDirectory, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(staticDirectory, "index.html"), "<!doctype html><title>runtime J3</title>");
		let controlPlane;
		try {
			controlPlane = await startControlPlane({
				token: home.token,
				stateDirectory: path.join(home.root, "control-plane-state"),
				staticDirectory,
				runtimeIngress: inbox,
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
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${home.token}`,
				},
				body: JSON.stringify(ingressSignal),
			});
			assert.equal(accepted.status, 202, "authenticated runtime POST only acknowledges durable spool");
			assert.equal(materializer.drain().materialized, 1, "the service, not the HTTP producer, performs SQLite materialization");
		} catch (error) {
			if (!/(?:EPERM|EACCES).*listen|listen.*(?:EPERM|EACCES)/iu.test(String(error)))
				throw error;
			t.diagnostic("UNMET: sandbox rejected the real 127.0.0.1 authenticated-ingress boundary (EPERM)");
		} finally {
			await controlPlane?.close();
		}

		const producerSignals = Array.from({ length: 100 }, (_, index) => signal(index + 1));
		const receipts = await Promise.all(
			producerSignals.flatMap((entry) => [
				Promise.resolve().then(() => inbox.accept(entry)),
				Promise.resolve().then(() => inbox.accept(entry)),
			]),
		);
		assert.equal(
			receipts.filter((receipt) => receipt.status === "spooled").length,
			100,
			"one atomic pending envelope is published for each of 100 producers",
		);
		assert.equal(inbox.metrics().pending, 100, "duplicate producers never create a second pending file");
		const first = materializer.drain();
		assert.equal(first.materialized, 100, "each published event materializes exactly once");
		assert.equal(inbox.metrics().archived, 100, "committed events are only archived after the transaction");

		const orderedProducer = id("prod", 900);
		inbox.accept(signal(900, { producer: orderedProducer, sequence: 2 }));
		inbox.accept(signal(901, { producer: orderedProducer, sequence: 1 }));
		const ordered = materializer.drain();
		assert.equal(ordered.materialized, 1);
		assert.equal(ordered.stale, 1, "out-of-order event remains an auditable stale fact");
		await owner.close();
		owner = undefined;
		const prePublishSignal = signal(950);
		await crashChild(home, "before_publish", prePublishSignal);
		assert.equal(
			inbox.metrics().pending,
			0,
			"a producer killed after fsync but before publish leaves no partial pending envelope",
		);

		for (const [index, failpoint] of [
			"after_claim",
			"before_transaction",
			"after_commit",
			"before_archive",
		].entries()) {
			const crashSignal = signal(1_000 + index);
			inbox.accept(crashSignal);
			await crashChild(home, failpoint);
			owner = openOwner(home, clock);
			const restarted = createRuntimeMaterializer({ home: home.root, writer: owner });
			const recovered = restarted.materializer.drain();
			assert.equal(
				restarted.inbox.metrics().pending,
				0,
				`${failpoint} restart must leave no unprocessed source envelope`,
			);
			assert.equal(
				restarted.inbox.metrics().processing,
				0,
				`${failpoint} restart must reclaim abandoned processing`,
			);
			assert.equal(
				recovered.materialized + recovered.duplicated,
				1,
				`${failpoint} must materialize once or deduplicate a committed source`,
			);
			await owner.close();
			owner = undefined;
		}

		owner = openOwner(home, clock);
		const restarted = createRuntimeMaterializer({ home: home.root, writer: owner });
		for (const [number, body] of [
			[2_000, "{not json"],
			[2_001, JSON.stringify({ ...signal(2_001), schema_version: "golem.runtime-signal/v2" })],
			[2_002, "x".repeat(1_048_577)],
		])
			fs.writeFileSync(
				path.join(restarted.inbox.root, "pending", `${id("evt", number)}.json`),
				body,
				{ mode: 0o600 },
			);
		const quarantined = restarted.materializer.drain();
		assert.equal(quarantined.quarantined, 3, "malformed, unknown-major, and oversized input are quarantined without blocking");
		restarted.inbox.accept(signal(2_003));
		assert.equal(restarted.materializer.drain().materialized, 1, "a valid event follows quarantine normally");

		const consumerPath = path.join(home.root, "outbox-consumer.db");
		const consumer = new Database(consumerPath);
		consumer.exec("CREATE TABLE deliveries (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)");
		let serviceDown = true;
		let crashAfterDelivery = true;
		const drainer = new RuntimeOutboxDrainer({
			writer: owner,
			workerId: "runtime-j3-drainer",
			destinations: {
				tracker: {
					deliver: async ({ id: deliveryId, payload }) => {
						if (serviceDown) throw new Error("tracker service is down");
						const inserted = consumer
							.prepare("INSERT OR IGNORE INTO deliveries(id, payload_json) VALUES (?, ?)")
							.run(deliveryId, JSON.stringify(payload));
						if (crashAfterDelivery && inserted.changes === 1) {
							crashAfterDelivery = false;
							throw new Error("consumer crashed after durable idempotency write");
						}
					},
				},
			},
		});
		assert.equal((await drainer.drain(1)).deferred, 1, "service-down delivery stays durably spooled");
		serviceDown = false;
		clock.advance(1_000);
		assert.equal((await drainer.drain(1)).deferred, 1, "consumer crash before ack leaves a claim-token retry");
		clock.advance(2_000);
		let replayed = await drainer.drain(100);
		while (replayed.claimed === 100) replayed = await drainer.drain(100);
		assert(replayed.acknowledged >= 1, "idempotent cross-database replay acknowledges the persisted delivery");
		const runtimeDatabase = new Database(home.runtimeDb, { readonly: true });
		try {
			const outboxCount = count(runtimeDatabase, "runtime_outbox");
			assert.equal(
				runtimeDatabase.prepare("SELECT COUNT(*) AS count FROM runtime_outbox WHERE status = 'published'").get().count,
				outboxCount,
				"every durable outbox record is eventually acknowledged",
			);
			assert.equal(
				count(consumer, "deliveries"),
				outboxCount,
				"the consumer uses the outbox id as a cross-database idempotency key",
			);
			assert.equal(
				runtimeDatabase.prepare("SELECT COUNT(*) AS count FROM runtime_outbox WHERE status = 'permanent_failure'").get().count,
				0,
				"bounded retry did not convert a recoverable service outage into permanent failure",
			);
			assert.equal(
				runtimeDatabase.prepare("SELECT COUNT(*) AS count FROM runtime_events WHERE disposition = 'stale'").get().count,
				1,
				"stale ordering is durable and queryable",
			);
		} finally {
			runtimeDatabase.close();
			consumer.close();
		}
		const metrics = restarted.inbox.metrics();
		assert.deepEqual(
			Object.keys(metrics).sort(),
			["archived", "pending", "processing", "quarantined"],
			"inbox metrics expose counts only, never event payloads or secrets",
		);
	} finally {
		if (owner) await owner.close();
		home.cleanup();
		assert.equal(fs.existsSync(home.root), false, "temporary runtime home is always removed");
	}
});
