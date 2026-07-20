import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import {
	assertContained,
	createLogicalClock,
	createTemporaryHome,
	redactDiagnostic,
	registerScenario,
	runHeadlessServiceFixture,
	semanticParityDiff,
	spawnGrouped,
	stableSummaryJson,
	stopProcessGroup,
	summarizeJourneys,
	waitFor,
} from "@golem/testkit";
import { normalizeLegacyObservation } from "../parity/normalization.mjs";
import { exerciseControlPlaneShell } from "../control-plane/control-plane-shell.mjs";
import { exerciseRenderMcpClosure } from "../render-mcp-closure.mjs";
import { exerciseDomainReplay } from "./domain-replay.mjs";
import { exerciseLauncherResolution } from "./launcher-resolution.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serviceFixture = path.join(repositoryRoot, "test/journeys/real-service.mjs");
const fakeHarness = path.join(repositoryRoot, "test/fixtures/native-binaries/fake-harness.mjs");
const legacyBaseline = path.join(repositoryRoot, "test/parity/legacy-baseline.mjs");
const persistenceJourney = path.join(repositoryRoot, "test/persistence/sqlite-owner-migration-recovery.test.mjs");
const chromeExecutable = process.env.GOLEM_CHROME_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

class JourneyDiagnosticError extends Error {
	constructor(message, temporaryRoot, sensitiveValues) {
		super(message);
		this.temporaryRoot = temporaryRoot;
		this.sensitiveValues = sensitiveValues;
	}
}

function processFailure(label, group) {
	return new Error(`${label}; command=${group.command}; stdout=${group.stdout()}; stderr=${group.stderr()}`);
}

function parseReady(output) {
	for (const line of output.split("\n")) {
		try {
			const message = JSON.parse(line);
			if (message.type === "ready" && typeof message.origin === "string") return message;
		} catch { /* non-JSON process diagnostic */ }
	}
	return undefined;
}

function exited(group) {
	return group.child.exitCode !== null || group.child.signalCode !== null;
}

async function startService(home, withWorker = false) {
	const group = spawnGrouped(process.execPath, [serviceFixture], {
		cwd: repositoryRoot,
		env: {
			...home.env,
			TESTKIT_DB_PATH: home.runtimeDb,
			TESTKIT_SPAWN_WORKER: withWorker ? "1" : "0",
		},
	});
	try {
		const readyOrFailure = await waitFor(() => {
			const message = parseReady(group.stdout());
			if (message) return message;
			if (exited(group)) return { failure: processFailure("real service exited before ready", group) };
			return undefined;
		}, "real service readiness");
		if ("failure" in readyOrFailure) throw readyOrFailure.failure;
		const ready = readyOrFailure;
		return { group, origin: ready.origin, workerPid: ready.worker_pid };
	} catch (error) {
		await stopProcessGroup(group);
		throw new JourneyDiagnosticError(
			error instanceof Error ? error.message : String(error),
			home.root,
			[home.token],
		);
	}
}

async function childIsGone(pid, role = "descendant") {
	await waitFor(() => {
		try {
			process.kill(pid, 0);
			return undefined;
		} catch (error) {
			if (error && typeof error === "object" && error.code === "ESRCH") return true;
			throw error;
		}
	}, `${role} ${pid} termination`);
}

async function proveOutsideWriteIsRejected(home, outside) {
	const logPath = path.join(home.root, "escape-attempt.ndjson");
	const fixture = spawnGrouped(process.execPath, [fakeHarness, "--mode", "escape"], {
		cwd: repositoryRoot,
		env: {
			...home.env,
			TESTKIT_FAKE_LOG: logPath,
			TESTKIT_ESCAPE_PATH: outside,
		},
	});
	try {
		await waitFor(() => exited(fixture) ? true : undefined, "outside-write fixture exit");
		assert.equal(fixture.child.exitCode, 0, "escape fixture must complete its deliberate write attempt");
		assert.equal(fs.readFileSync(outside, "utf8"), "fixture escape attempt\n", "fixture must actually write outside the temporary root");
		let detection;
		try {
			assertContained(home.root, outside);
		} catch (error) {
			detection = error;
		}
		assert(detection instanceof Error, "runner must reject the concrete escaped target");
		assert.match(detection.message, /test artifact escaped its temporary root/);
		assert.match(detection.message, /golem-j27-escape/, "runner must report the concrete escaped target");
		const rows = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert(rows.some((row) => row.event === "escape" && row.escapePath === outside), "fixture records the rejected escape attempt");
	} finally {
		if (!exited(fixture)) await stopProcessGroup(fixture);
		fs.rmSync(outside, { force: true });
		assert.equal(fs.existsSync(outside), false, "rejected outside write must be removed exactly");
	}
}

async function receiveWebSocket(origin) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(origin.replace("http", "ws") + "/ws");
		const timeout = setTimeout(() => {
			socket.terminate();
			reject(new Error("websocket fixture timed out"));
		}, 4_000);
		socket.once("message", (raw) => {
			clearTimeout(timeout);
			socket.close();
			try { resolve(JSON.parse(String(raw))); } catch (error) { reject(error); }
		});
		socket.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

function cleanupHome(home) {
	home.cleanup();
	assert.equal(fs.existsSync(home.root), false, "temporary GOLEM_HOME must be removed after every journey");
}

export function isLoopbackUnavailable(error) {
	return /(?:EPERM|EACCES).*listen|listen.*(?:EPERM|EACCES)/iu.test(String(error?.stack || error));
}

export async function exerciseSmoke() {
	const home = createTemporaryHome("golem-j3-smoke-");
	let first;
	let second;
	try {
		first = await startService(home, true);
		const initial = await fetch(`${first.origin}/health`).then((response) => response.json());
		assert.deepEqual(initial, { ok: true, counter: 0 });
		const incremented = await fetch(`${first.origin}/increment`, { method: "POST" }).then((response) => response.json());
		assert.deepEqual(incremented, { counter: 1 });
		assert.deepEqual(await receiveWebSocket(first.origin), { type: "counter", counter: 1 });
		assert.equal(typeof first.workerPid, "number", "fixture must include a process descendant");
		await stopProcessGroup(first.group);
		await childIsGone(first.workerPid);
		first = undefined;

		second = await startService(home);
		const afterRestart = await fetch(`${second.origin}/health`).then((response) => response.json());
		assert.deepEqual(afterRestart, { ok: true, counter: 1 }, "SQLite state must survive a real process restart");
		return "HTTP, WebSocket, SQLite restart persistence, and child-group termination verified";
	} finally {
		if (second) await stopProcessGroup(second.group);
		if (first) await stopProcessGroup(first.group);
		cleanupHome(home);
	}
}

export async function exerciseFakeHarness() {
	const home = createTemporaryHome("golem-j5-native-");
	const logPath = path.join(home.root, "fake-harness.ndjson");
	const shared = { ...home.env, TESTKIT_FAKE_LOG: logPath, TESTKIT_FAKE_VALUE: "fixture-value" };
	let delayed;
	try {
		delayed = spawnGrouped(process.execPath, [fakeHarness, "--mode", "delayed", "--name", "fixture"], { cwd: repositoryRoot, env: shared });
		delayed.child.stdin.write("fixture-stdin");
		delayed.child.stdin.end();
		await waitFor(() => delayed.stdout().includes("ready\n") ? true : undefined, "delayed native harness readiness");
		await stopProcessGroup(delayed);
		delayed = undefined;

		const crashed = spawnGrouped(process.execPath, [fakeHarness, "--mode", "crash"], { cwd: repositoryRoot, env: shared });
		await waitFor(() => exited(crashed) ? true : undefined, "crashing native harness exit");
		assert.equal(crashed.child.exitCode, 23, "crash mode must retain its native exit code");

		const duplicate = spawnGrouped(process.execPath, [fakeHarness, "--mode", "duplicate"], { cwd: repositoryRoot, env: shared });
		await waitFor(() => exited(duplicate) ? true : undefined, "duplicate native harness exit");
		assert.equal(duplicate.stdout(), "duplicate-output\nduplicate-output\n", "duplicate stream output must not be collapsed");

		const rows = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert(rows.some((row) => row.event === "start" && row.args.includes("--name") && row.env.TESTKIT_FAKE_VALUE === "fixture-value"));
		assert(rows.some((row) => row.event === "stdin" && row.stdin === "fixture-stdin"));
		assert(rows.some((row) => row.event === "signal" && row.signal === "SIGTERM"));
		assert(rows.some((row) => row.event === "exit" && row.code === 23));
		return "native argv, stdin, signal, crash, delay, and duplicate-output contract verified";
	} finally {
		if (delayed) await stopProcessGroup(delayed);
		cleanupHome(home);
	}
}

export async function exerciseSemanticParity() {
	const legacy = {
		endpoint: "http://127.0.0.1:48765/health",
		observed_at: "2026-07-20T12:34:56.789Z",
		service_pid: 991,
		session_id: "11111111-1111-4111-8111-111111111111",
		readiness: "ready",
		labels: ["beta", "alpha"],
		queue: ["first", "second"],
	};
	const equivalentReplacement = {
		...legacy,
		endpoint: "http://127.0.0.1:57891/health",
		observed_at: "2026-07-21T00:00:00.000Z",
		service_pid: 992,
	};
	const equal = semanticParityDiff(legacy, equivalentReplacement, normalizeLegacyObservation);
	assert.equal(equal.equal, true, "GOL-24 normalizers must remove only volatile observations");
	const changed = semanticParityDiff(legacy, { ...equivalentReplacement, readiness: "pull_only" }, normalizeLegacyObservation);
	assert.equal(changed.equal, false);
	assert.deepEqual(changed.changed_paths, ["/readiness"]);
	assert.throws(() => registerScenario({ id: "invalid", journey: "J9", tier: "pr", regression: "must fail" }));

	const firstClock = createLogicalClock("semantic-parity");
	const secondClock = createLogicalClock("semantic-parity");
	assert.equal(firstClock.advance(5), secondClock.advance(5));
	const summary = summarizeJourneys([{ id: "stable", journey: "J6", tier: "pr", regression: "summary drift", status: "PASS", evidence: "semantic contract" }]);
	assert.equal(stableSummaryJson(summary), stableSummaryJson(summary), "journey summaries must be byte-stable");
	assert.equal(
		redactDiagnostic("Bearer abcdefghijkl /private/tmp/golem-j27-token", "/private/tmp/golem-j27-token"),
		"$REDACTED $TEMP_ROOT",
		"diagnostics must redact both credentials and temporary paths",
	);
	const redactionHome = createTemporaryHome("golem-redaction-probe-");
	try {
		const probe = new Error(`redaction probe root=${redactionHome.root} token=${redactionHome.token}`);
		const evidence = diagnosticFor(probe, redactionHome);
		const failureSummary = stableSummaryJson(summarizeJourneys([{
			id: "redaction-probe",
			journey: "J6",
			tier: "pr",
			regression: "failure evidence leaks temporary context",
			status: "FAIL",
			evidence,
		}]));
		assert.deepEqual({
			temporary_path_leaked: evidence.includes(redactionHome.root),
			test_token_leaked: evidence.includes(redactionHome.token),
		}, { temporary_path_leaked: false, test_token_leaked: false });
		assert.match(evidence, /\$TEMP_ROOT/);
		assert.match(evidence, /\$REDACTED/);
		assert.equal(failureSummary, stableSummaryJson(summarizeJourneys([{
			id: "redaction-probe",
			journey: "J6",
			tier: "pr",
			regression: "failure evidence leaks temporary context",
			status: "FAIL",
			evidence,
		}])));
	} finally {
		cleanupHome(redactionHome);
	}
	return "GOL-24 normalizer and deterministic semantic diff verified";
}

async function propagateCleanupFailure() {
	const home = createTemporaryHome("golem-j3-cleanup-");
	const outside = path.join(os.tmpdir(), `golem-j27-escape-${process.pid}-${Date.now()}`);
	let service;
	let rootPid;
	let workerPid;
	try {
		service = await startService(home, true);
		rootPid = service.group.child.pid;
		workerPid = service.workerPid;
		assert.equal(typeof rootPid, "number", "fixture must expose its root child PID");
		assert.equal(typeof workerPid, "number", "fixture must expose its descendant PID");
		await proveOutsideWriteIsRejected(home, outside);
		assert.fail("deliberate cleanup failure must propagate through finally");
	} finally {
		try {
			if (service) await stopProcessGroup(service.group);
			if (typeof rootPid === "number") await childIsGone(rootPid, "root child");
			if (typeof workerPid === "number") await childIsGone(workerPid);
		} finally {
			fs.rmSync(outside, { force: true });
			assert.equal(fs.existsSync(outside), false, "cleanup leaves no rejected outside-write residue");
			cleanupHome(home);
		}
	}
}

export async function exerciseCleanupDrill() {
	let propagated;
	try {
		await propagateCleanupFailure();
	} catch (error) {
		propagated = error;
	}
	if (!propagated) assert.fail("cleanup drill must propagate its deliberate failure");
	if (isLoopbackUnavailable(propagated)) throw propagated;
	assert.match(String(propagated), /deliberate cleanup failure must propagate through finally/);
	return "propagated failure terminated root and descendant children, removed its temporary root, and rejected a real fixture escape";
}

export async function exerciseSqliteOwnerMigrationRecovery() {
	const home = createTemporaryHome("golem-j3-persistence-runner-");
	const group = spawnGrouped(process.execPath, ["--test", "--test-concurrency=1", persistenceJourney], {
		cwd: repositoryRoot,
		env: home.env,
	});
	try {
		await waitFor(() => exited(group) ? true : undefined, "SQLite owner/migration journey exit", 30_000);
		if (group.child.exitCode !== 0)
			throw processFailure(`SQLite owner/migration journey exited ${group.child.exitCode}`, group);
		return "real SQLite final-schema constraints, writer boundary, nonce-safe crash recovery, bounded outbox failure, tracker baseline, backup, and restart recovery verified";
	} finally {
		if (!exited(group)) await stopProcessGroup(group);
		cleanupHome(home);
	}
}

export async function exerciseBrowser() {
	const home = createTemporaryHome("golem-j8-browser-");
	const artifactRoot = path.join(home.root, "browser-artifacts");
	let service;
	try {
		if (!fs.existsSync(chromeExecutable)) throw new Error(`headless Chrome fixture is unavailable: ${chromeExecutable}`);
		service = await startService(home);
		await runHeadlessServiceFixture({
			launch: (options) => chromium.launch(options),
			origin: service.origin,
			artifactRoot,
			executablePath: chromeExecutable,
		});
		assert.equal(fs.existsSync(artifactRoot), false, "successful browser runs retain no screenshots or traces");
		return "headless fresh-context Playwright fixture reached the real service without retained artifacts";
	} finally {
		if (service) await stopProcessGroup(service.group);
		cleanupHome(home);
	}
}

export async function exerciseLegacyParityBaseline() {
	const home = createTemporaryHome("golem-j4-legacy-");
	const group = spawnGrouped(process.execPath, [legacyBaseline], { cwd: repositoryRoot, env: home.env });
	try {
		await waitFor(() => exited(group) ? true : undefined, "legacy parity baseline exit", 30_000);
		if (group.child.exitCode !== 0) throw processFailure(`legacy parity baseline exited ${group.child.exitCode}`, group);
		return "thin legacy invocation adapter completed the GOL-24 real-boundary baseline";
	} finally {
		if (!exited(group)) await stopProcessGroup(group);
		cleanupHome(home);
	}
}

export function diagnosticFor(error, context) {
	const description = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	const temporaryRoot = context?.temporaryRoot || context?.root || (error instanceof JourneyDiagnosticError ? error.temporaryRoot : undefined);
	const sensitiveValues = context?.sensitiveValues || (context?.token ? [context.token] : undefined) || (error instanceof JourneyDiagnosticError ? error.sensitiveValues : []);
	return redactDiagnostic(description, temporaryRoot, sensitiveValues);
}

export const exercises = Object.freeze({
	"domain-replay": exerciseDomainReplay,
	"launcher-resolution-matrix": exerciseLauncherResolution,
	"testkit-smoke": exerciseSmoke,
	"testkit-fake-harness": exerciseFakeHarness,
	"testkit-semantic-parity": exerciseSemanticParity,
	"testkit-cleanup-drill": exerciseCleanupDrill,
	"sqlite-owner-migration-recovery": exerciseSqliteOwnerMigrationRecovery,
	"testkit-browser": exerciseBrowser,
	"legacy-parity-baseline": exerciseLegacyParityBaseline,
	"render-mcp-closure": exerciseRenderMcpClosure,
	"control-plane-auth-ws-lifecycle": exerciseControlPlaneShell,
});
