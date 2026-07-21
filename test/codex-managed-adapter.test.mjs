import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";
import { RuntimeSignalV1Schema } from "@golem/contracts";
import {
	ManagedCodexQualificationError,
	ManagedCodexSupervisor,
	validateManagedTuiBinding,
} from "@golem/adapter-codex";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const fixture = path.join(repositoryRoot, "test/fixtures/codex-managed-app-server.mjs");

test("managed Codex App Server lifecycle, fenced delivery, restart, and qualification", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "golem-codex-managed-"));
	const database = new Database(path.join(root, "runtime.sqlite"));
	database.exec("CREATE TABLE signals (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, generation TEXT NOT NULL); CREATE TABLE deliveries (id TEXT PRIMARY KEY, status TEXT NOT NULL, turn_id TEXT)");
	const signalInsert = database.prepare("INSERT INTO signals(kind,generation) VALUES (?,?)");
	const deliveryInsert = database.prepare("INSERT OR REPLACE INTO deliveries(id,status,turn_id) VALUES (?,?,?)");
	const signals = [];
	const reports = [];
	let eligible = false;
	let priorThread;
	let claims = 0;
	const turnLog = path.join(root, "turns.log");
	const endpoints = {
		claim(input) {
			claims += 1;
			priorThread ??= "thread-managed-1";
			return { disposition: "accepted", ownerFence: 1, ...(claims > 1 ? { threadId: priorThread } : {}), endpointId: input.endpointId };
		},
		eligibility() { return { disposition: eligible ? "eligible" : "ineligible", code: eligible ? "endpoint.ready" : "endpoint.not_ready" }; },
		reportReadiness(input) { reports.push({ kind: "readiness", ...input }); eligible = input.readiness === "ready"; },
		reportCapability(input) { reports.push({ kind: "capability", ...input }); },
		reportHealth(input) { reports.push({ kind: "health", ...input }); },
		reportDelivery(input) { reports.push({ kind: "delivery", ...input }); },
		release(input) { reports.push({ kind: "release", ...input }); },
	};
	const ingress = {
		ingest(signal) {
			signals.push(signal);
			signalInsert.run(signal.event_kind, signal.payload.generation.generation_id);
		},
	};
	const delivery = {
		async claim(input) { return { disposition: "accepted", ...input }; },
		async ack(input) { deliveryInsert.run(input.deliveryId, "completed", input.turnId ?? null); },
		async fail(input) { deliveryInsert.run(input.deliveryId, "failed", null); },
	};
	const base = {
		binding: {
			projectId: "prj_11111111-1111-4111-8111-111111111111",
			sessionId: "ses_22222222-2222-4222-8222-222222222222",
			generationId: "gen_33333333-3333-4333-8333-333333333333",
			endpointId: "ep_44444444-4444-4444-8444-444444444444",
			ownerInstanceId: "prod_55555555-5555-4555-8555-555555555555",
			producerInstanceId: "prod_66666666-6666-4666-8666-666666666666",
		},
		projectPath: root,
		command: process.execPath,
		rpc: { args: [fixture], requestTimeoutMs: 2_000 },
		env: { ...process.env, NODE_PATH: "", GOLEM_CODEX_TURN_LOG: turnLog },
		endpoints,
		ingress,
		delivery,
	};
	let supervisor;
	try {
		assert.throws(() => new ManagedCodexSupervisor({ ...base, backend: "ollama_local" }), ManagedCodexQualificationError, "local/OSS managed requests fail before spawn");
		supervisor = new ManagedCodexSupervisor({ ...base, backend: "openai", model: "gpt-4o" });
		const first = await supervisor.start();
		assert.equal(first.launchable, true);
		assert.equal(first.deliveryReady, false, "launchability does not imply consumer readiness");
		await supervisor.markConsumerReady();
		assert.equal(await supervisor.deliveryReady(), true);
		const accepted = await supervisor.deliver({ deliveryId: "delivery-one", text: "hello" });
		assert.equal(accepted.status, "accepted");
		const duplicate = await supervisor.deliver({ deliveryId: "delivery-one", text: "different hostile replacement" });
		assert.equal(duplicate.status, "duplicate");
		eligible = false;
		const stale = await supervisor.deliver({ deliveryId: "delivery-stale", text: "must not spawn" });
		assert.deepEqual(stale, { status: "rejected", code: "adapter.codex.managed.delivery_ineligible", deliveryId: "delivery-stale" });
		await supervisor.stop();
		supervisor = new ManagedCodexSupervisor({ ...base, backend: "openai", model: "gpt-4o" });
		const resumed = await supervisor.start();
		assert.equal(resumed.resumed, true, "restart resumes the stored canonical App Server thread");
		await supervisor.markConsumerReady();
		assert.equal((await supervisor.control("interrupt")).status, "accepted");
		assert.equal((await supervisor.control("halt")).status, "accepted");
		assert.equal(validateManagedTuiBinding({ socketPath: "/tmp/golem.sock", remote: "unix:///tmp/golem.sock", generationId: base.binding.generationId, cwd: root }, { generationId: base.binding.generationId, cwd: root }).generationId, base.binding.generationId);
		assert.throws(() => validateManagedTuiBinding({ socketPath: "/tmp/golem.sock", remote: "unix:///tmp/golem.sock", generationId: "gen_wrong", cwd: root }, { generationId: base.binding.generationId, cwd: root }), /tui_binding_mismatch/);
		assert.equal(signals.filter((signal) => signal.event_kind === "session.started").length, 1);
		assert.equal(signals.filter((signal) => signal.event_kind === "session.resumed").length, 1);
		for (const signal of signals) RuntimeSignalV1Schema.parse(signal);
		assert.equal(database.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE status='completed'").get().count, 1);
		assert.equal(fs.readFileSync(turnLog, "utf8").trim().split("\n").filter(Boolean).length, 1, "duplicate and stale delivery never create a second App Server turn");
		assert.equal(reports.some((report) => report.kind === "health" && report.state === "healthy"), true);
		assert.equal(reports.some((report) => report.kind === "release"), true);
		assert.equal(JSON.stringify(signals).includes("different hostile"), false);
		const cli = spawnSync(process.execPath, [
			path.join(repositoryRoot, "dist/apps/cli/golem.js"),
			"codex",
			"--backend",
			"ollama_local",
			"--dry-run",
			"--json",
		], { cwd: repositoryRoot, env: { ...process.env, GOLEM_HOME: root }, encoding: "utf8" });
		assert.notEqual(cli.status, 0, "unsupported managed backend fails before spawn");
		const cliFailure = JSON.parse(cli.stdout);
		assert.equal(cliFailure.error.code, "adapter.codex.managed.qualification_required");
		assert.deepEqual(cliFailure.error.remediation, ["Use direct Codex for local/OSS models, or select a qualified OpenAI/GPT managed preset."]);
		assert.equal(cli.stdout.includes("ollama_local"), false, "managed qualification diagnostics do not echo the backend selector");
		return "real Node App Server process, SQLite signal/delivery records, canonical resume, fenced duplicate/stale refusal, control ownership, and TUI binding verified";
	} finally {
		await supervisor?.stop().catch(() => {});
		database.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
