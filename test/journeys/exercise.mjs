import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { runMigrationPlanReplay } from "../migration/replay.mjs";
import { runMigrationApplyReplay } from "../migration/apply-replay.mjs";
import { exerciseRenderMcpClosure } from "../render-mcp-closure.mjs";
import { runOpenCodeComposedJourney } from "../adapter/opencode-composed-journey.mjs";
import { runOpenCodeNormalLaunchJourney } from "../adapter/opencode-normal-launch-journey.mjs";
import { exerciseDomainReplay } from "./domain-replay.mjs";
import { exerciseCompactLaunchDryRunMatrix } from "./compact-launch-dry-run-matrix.mjs";
import { exerciseLauncherLaunchabilityDeliverySplit } from "./launcher-launchability-delivery-split.mjs";
import {
	exerciseTrackerHttpMcpParity,
	exerciseDeliveryApiFenceRecheck,
} from "./tracker-api.mjs";
import { exercisePiNextTurnCrashReplay } from "./pi-next-turn-crash-replay.mjs";
import { exercisePiHostileDiagnostics } from "./pi-hostile-diagnostics.mjs";
import { exerciseLauncherResolution } from "./launcher-resolution.mjs";
import {
	exerciseLauncherSignalCleanup,
	exerciseNativeSpawnSafety,
} from "./native-spawn-safety.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serviceFixture = path.join(repositoryRoot, "test/journeys/real-service.mjs");
const fakeHarness = path.join(repositoryRoot, "test/fixtures/native-binaries/fake-harness.mjs");
const legacyBaseline = path.join(repositoryRoot, "test/parity/legacy-baseline.mjs");
const persistenceJourney = path.join(repositoryRoot, "test/persistence/sqlite-owner-migration-recovery.test.mjs");
const runtimeEngineJourney = path.join(repositoryRoot, "test/runtime/materializer-crash-matrix.test.mjs");
const dashboardDownJourney = path.join(repositoryRoot, "test/runtime/dashboard-down-inbox-replay.test.mjs");
const deliveryBusJourney = path.join(repositoryRoot, "test/tracker/delivery-bus.test.mjs");
const projectIdentityJourney = path.join(repositoryRoot, "test/projects/project-identity-git-worktree-relocation.test.mjs");
const projectConcurrencyJourney = path.join(repositoryRoot, "test/projects/project-register-concurrency.test.mjs");
const controlPlaneProgram = path.join(repositoryRoot, "apps/control-plane/dist/main.js");
const trackerCoreJourney = path.join(repositoryRoot, "test/tracker/tracker-core.test.mjs");
const managementJourney = path.join(repositoryRoot, "test/management/management-services.test.mjs");
const codexDirectJourney = path.join(repositoryRoot, "test/codex-direct-adapter.test.mjs");
const runtimeProjectionJourney = path.join(repositoryRoot, "test/runtime/runtime-projections.test.mjs");
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

export async function exerciseMaterializerCrashMatrix() {
	const home = createTemporaryHome("golem-j3-runtime-engine-runner-");
	const group = spawnGrouped(process.execPath, ["--test", "--test-concurrency=1", runtimeEngineJourney], {
		cwd: repositoryRoot,
		env: home.env,
	});
	try {
		await waitFor(() => exited(group) ? true : undefined, "runtime materializer crash matrix exit", 30_000);
		if (group.child.exitCode !== 0)
			throw processFailure(`runtime materializer crash matrix exited ${group.child.exitCode}`, group);
		if (group.stdout().includes("UNMET: sandbox rejected the real 127.0.0.1"))
			throw new Error("listen EPERM: sandbox rejected the real 127.0.0.1 authenticated-ingress boundary");
		return "100 independent producers, lease/poison/archive recovery, child crash replay, and exact redacted outbox state transitions verified";
	} finally {
		if (!exited(group)) await stopProcessGroup(group);
		cleanupHome(home);
	}
}

function runDeliveryBusJourney(testNamePattern) {
	const home = createTemporaryHome("golem-j4-delivery-runner-");
	try {
		const result = spawnSync(
			process.execPath,
		[
				"--test",
				"--test-concurrency=1",
				"--test-name-pattern",
				testNamePattern,
				deliveryBusJourney,
			],
			{ cwd: repositoryRoot, encoding: "utf8", env: home.env },
		);
		if (result.status !== 0)
			throw new JourneyDiagnosticError(
				`durable delivery/bus journey exited ${result.status}; stdout=${result.stdout}; stderr=${result.stderr}`,
				home.root,
				[home.token],
			);
	} finally {
		cleanupHome(home);
	}
}

function runRuntimeProjectionJourney(testNamePattern) {
	const home = createTemporaryHome("golem-j2-runtime-projection-runner-");
	try {
		const result = spawnSync(
			process.execPath,
			["--test", "--test-concurrency=1", "--test-name-pattern", testNamePattern, runtimeProjectionJourney],
			{ cwd: repositoryRoot, encoding: "utf8", env: home.env },
		);
		if (result.status !== 0)
			throw new JourneyDiagnosticError(
				`runtime projection journey exited ${result.status}; stdout=${result.stdout}; stderr=${result.stderr}`,
				home.root,
				[home.token],
			);
	} finally {
		cleanupHome(home);
	}
}

export async function exerciseRuntimeProjectionLiveHistoryDiagnostics() {
	runRuntimeProjectionJourney("GOL-46 live/history/diagnostics");
	return "real runtime.db live/history/diagnostic read models, endpoint facts, redaction, observation separation, pagination, and restart stability verified";
}

export async function exerciseRuntimeProjectionWsRestartResync() {
	runRuntimeProjectionJourney("GOL-46 authenticated WS");
	return "real authenticated runtime.live WebSocket snapshot/delta, monotonic cursor, and service-restart instance resync verified";
}

export async function exerciseDashboardDownInboxReplay() {
	const home = createTemporaryHome("golem-j1-dashboard-down-runner-");
	const group = spawnGrouped(process.execPath, ["--test", "--test-concurrency=1", dashboardDownJourney], {
		cwd: repositoryRoot,
		env: home.env,
	});
	try {
		await waitFor(() => (exited(group) ? true : undefined), "dashboard-down inbox replay", 60_000);
		if (group.child.exitCode !== 0) throw processFailure(`dashboard-down inbox replay exited ${group.child.exitCode}`, group);
		if (group.stdout().includes("UNMET: sandbox rejected the real 127.0.0.1"))
			throw new Error("listen EPERM: sandbox rejected the real 127.0.0.1 service-start boundary");
		return "independent filesystem producers remained lossless while the service was absent, then a fresh control-plane start replayed and archived every envelope";
	} finally {
		if (!exited(group)) await stopProcessGroup(group);
		cleanupHome(home);
	}
}

export async function exerciseDeliveryQueueCrashMatrix() {
	runDeliveryBusJourney("delivery queue crash matrix");
	return "real SQLite CAS claim, stale-fence recheck, bounded retry/deadline, and child-crash lease replay verified";
}

export async function exerciseBusOfflineReplay() {
	runDeliveryBusJourney("bus offline replay");
	return "real SQLite bus dedupe, named cursor replay, passive lease commit/release, manual-interest prune, and audit verified";
}

function createNodeSocket(url, token, sockets, frames = []) {
	const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
	const adapter = {
		close: () => socket.close(),
		onclose: null,
		onerror: null,
		onmessage: null,
		onopen: null,
	};
	socket.on("open", () => adapter.onopen?.());
	socket.on("message", (raw) => {
		const data = String(raw);
		try {
			frames.push(JSON.parse(data));
		} catch {
			// The adapter remains the source of protocol validation.
		}
		adapter.onmessage?.({ data });
	});
	socket.on("error", () => adapter.onerror?.());
	socket.on("close", () => adapter.onclose?.());
	sockets.push(adapter);
	return adapter;
}

export async function exerciseWsGapResync() {
	const home = createTemporaryHome("golem-j6-ws-gap-");
	const token = "golem-ws-gap-test-token-000000000000";
	const staticRoot = path.join(home.root, "static");
	let service;
	let synchronizer;
	try {
		fs.mkdirSync(staticRoot, { recursive: true });
		fs.writeFileSync(path.join(staticRoot, "index.html"), "<!doctype html><title>temporary dashboard</title>\n");
		service = spawnGrouped(process.execPath, [controlPlaneProgram], {
			cwd: repositoryRoot,
				env: {
					...home.env,
					GOLEM_CONTROL_PLANE_TOKEN: token,
					GOLEM_CONTROL_PLANE_PORT: "0",
					GOLEM_CONTROL_PLANE_PROJECTION_REVISION: "9",
					GOLEM_CONTROL_PLANE_REPLAY_WINDOW: "2",
				GOLEM_CONTROL_PLANE_STATIC_ROOT: staticRoot,
			},
		});
		const ready = await waitFor(() => {
			const message = parseReady(service.stdout());
			if (message) return message;
			if (exited(service)) return { failure: processFailure("ws gap control plane exited before ready", service) };
			return undefined;
		}, "ws gap control plane readiness");
		if ("failure" in ready) throw ready.failure;

		const {
			applyProjectionDelta,
			createBrowserControlPlaneClient,
			createProjectionSynchronizer,
			replaceProjectionSnapshot,
		} = await import("../../packages/api-client/dist/index.js");
		const client = createBrowserControlPlaneClient(ready.origin, {
			headers: { authorization: `Bearer ${token}` },
		});
		const states = [];
		const snapshots = [];
		const deltas = [];
		const sockets = [];
		const frames = [];
		let captureRestartedHttpSnapshot = false;
		let restartedHttpSnapshot;
		await client.bootstrap();
		let projectionCache = replaceProjectionSnapshot(
			undefined,
			await client.projection("runtime.live"),
		);
		synchronizer = createProjectionSynchronizer({
			client,
			stream: "runtime.live",
			socketFactory: (url) => createNodeSocket(url, token, sockets, frames),
			onState: (state) => states.push(state),
			onSnapshot: (snapshot, source) => {
				projectionCache = replaceProjectionSnapshot(projectionCache, snapshot);
				if (captureRestartedHttpSnapshot && source === "http")
					restartedHttpSnapshot = snapshot;
				snapshots.push({ source, revision: snapshot.resource_revision });
			},
			onDelta: (frame) => {
				if (frame.payload.kind !== "delta") return;
				projectionCache = applyProjectionDelta(
					projectionCache,
					frame.resource_revision,
					frame.payload.delta,
				);
				deltas.push(frame.sequence);
			},
			retryDelayMs: 250,
		});
		synchronizer.start();
		await waitFor(
			() => (snapshots.length === 1 && states.includes("connected") ? true : undefined),
			"initial typed WebSocket snapshot",
		);
		await client.echo("ordered-one");
		await waitFor(() => (deltas.length === 1 ? true : undefined), "ordered delta");
		assert.deepEqual(deltas, [1], "the first ordered delta applies exactly once");
		await new Promise((resolve) => setTimeout(resolve, 350));
		assert.equal(
			sockets.length,
			1,
			"an ordinary ordered delta does not restart the single socket epoch",
		);
		const activeSocket = sockets.at(-1);
		assert.ok(activeSocket, "journey owns a real authenticated WebSocket");
		activeSocket.close();
		await waitFor(
			() => (states.includes("disconnected") ? true : undefined),
			"WebSocket disconnect",
		);
		for (const value of ["gap-two", "gap-three", "gap-four"])
			await client.echo(value);
		await waitFor(
				() =>
					snapshots.some((snapshot) => snapshot.source === "http") &&
					snapshots.length >= 2 &&
					states.at(-1) === "connected"
						? true
						: undefined,
			"compacted-cursor HTTP resync and fresh WebSocket snapshot",
			4_000,
		);
		assert.deepEqual(deltas, [1], "gap frames never partially mutate the cache before a full resync");
		assert.equal(
			sockets.length,
			3,
			`the resync epoch closes its stale socket without scheduling a competing reconnect; states=${JSON.stringify(states)} snapshots=${JSON.stringify(snapshots)}`,
		);

		const staleSocket = sockets.at(-1);
		assert.ok(staleSocket, "resync creates one current socket before restart");
		const formerProjection = projectionCache;
		const formerInstance = ready.instance_id;
		const formerPort = new URL(ready.origin).port;
		captureRestartedHttpSnapshot = true;
		await stopProcessGroup(service);
		service = spawnGrouped(process.execPath, [controlPlaneProgram], {
			cwd: repositoryRoot,
			env: {
				...home.env,
				GOLEM_CONTROL_PLANE_TOKEN: token,
				GOLEM_CONTROL_PLANE_PORT: formerPort,
				GOLEM_CONTROL_PLANE_PROJECTION_REVISION: "0",
				GOLEM_CONTROL_PLANE_REPLAY_WINDOW: "2",
				GOLEM_CONTROL_PLANE_STATIC_ROOT: staticRoot,
			},
		});
		const restartedReady = await waitFor(() => {
			const message = parseReady(service.stdout());
			if (message) return message;
			if (exited(service))
				return {
					failure: processFailure(
						"restarted ws gap control plane exited before ready",
						service,
					),
				};
			return undefined;
		}, "restarted control plane readiness");
		if ("failure" in restartedReady) throw restartedReady.failure;
		assert.equal(
			new URL(restartedReady.origin).port,
			formerPort,
			"the restarted control plane owns the same loopback port",
		);
		assert.notEqual(
			restartedReady.instance_id,
			formerInstance,
			"the restarted child exposes a new control-plane instance",
		);
		await waitFor(
			() =>
				restartedHttpSnapshot &&
				frames.some(
					(frame) =>
						frame.instance_id === restartedReady.instance_id &&
						frame.payload?.kind === "resync_required" &&
						frame.payload.reason === "instance_changed",
					) &&
				projectionCache.resource_revision < formerProjection.resource_revision &&
				snapshots.at(-1)?.source === "ws"
					? true
					: undefined,
			"real instance_changed resync and lower-revision HTTP snapshot",
			4_000,
		);
		assert.equal(
			restartedHttpSnapshot.resource_revision < formerProjection.resource_revision,
			true,
			"the restarted child serves a lower authoritative HTTP revision",
		);
		assert.deepEqual(
			projectionCache,
			restartedHttpSnapshot,
			"the app's projection cache consumer replaces the former payload with the real HTTP snapshot",
		);
		assert.equal(
			sockets.length,
			5,
			`the real restart yields one instance-change socket, one fresh socket, and no competitor; states=${JSON.stringify(states)} snapshots=${JSON.stringify(snapshots)}`,
		);
		staleSocket.onmessage?.({ data: "not a current epoch frame" });
		staleSocket.onclose?.();
		await new Promise((resolve) => setTimeout(resolve, 350));
		assert.equal(
			sockets.length,
			5,
			"the retained old callback cannot mutate or reconnect over the real replacement epoch",
		);
		return "typed WebSocket keeps one socket for ordered deltas, restarts the real control plane on the same port, replaces the app cache with its lower HTTP revision, and rejects stale epoch callbacks";
	} finally {
		if (synchronizer) synchronizer.stop();
		if (service && !exited(service)) await stopProcessGroup(service);
		cleanupHome(home);
	}
}

async function runProjectJourney(journey, label) {
	const home = createTemporaryHome(`golem-j2-${label}-`);
	const group = spawnGrouped(process.execPath, ["--test", "--test-concurrency=1", journey], { cwd: repositoryRoot, env: home.env });
	try {
		await waitFor(() => (exited(group) ? true : undefined), `${label} project journey exit`, 30_000);
		if (group.child.exitCode !== 0) throw processFailure(`${label} project journey exited ${group.child.exitCode}`, group);
		return group.stdout().trim() || `${label} project identity journey passed`;
	} finally {
		if (!exited(group)) await stopProcessGroup(group);
		cleanupHome(home);
	}
}

export function exerciseProjectIdentityGitWorktreeRelocation() {
	return runProjectJourney(projectIdentityJourney, "identity-git-worktree-relocation");
}

export function exerciseProjectRegisterConcurrency() {
	return runProjectJourney(projectConcurrencyJourney, "register-concurrency");
}

export async function exerciseTrackerCoreCompatibility() {
	const home = createTemporaryHome("golem-j4-tracker-core-runner-");
	const group = spawnGrouped(
		process.execPath,
		["--test", "--test-concurrency=1", trackerCoreJourney],
		{ cwd: repositoryRoot, env: home.env },
	);
	try {
		await waitFor(
			() => (exited(group) ? true : undefined),
			"tracker core compatibility journey exit",
			30_000,
		);
		if (group.child.exitCode !== 0)
			throw processFailure(
				`tracker core compatibility journey exited ${group.child.exitCode}`,
				group,
			);
		return "real legacy tracker migration, SQLite repository, Fastify compatibility facade, MCP HTTP client, canonical phases, concurrent display ids, and transactional audit/outbox verified";
	} finally {
		if (!exited(group)) await stopProcessGroup(group);
		cleanupHome(home);
	}
}

function runManagementJourney(name) {
	const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-name-pattern", name, managementJourney], { cwd: repositoryRoot, encoding: "utf8", env: process.env });
	if (result.status !== 0) throw new Error(`management journey failed: ${result.stdout}\n${result.stderr}`);
	return result.stdout.trim().split("\n").filter(Boolean).at(-1) || `${name} passed`;
}

export function exerciseRolesGatesIdeasControls() {
	return runManagementJourney("roles gates ideas and controls");
}

export function exerciseTicketAssetsSecurity() {
	return runManagementJourney("ticket assets are bounded");
}

export function exerciseCodexDirectSeamlessIntegration() {
	const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", codexDirectJourney], {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: process.env,
	});
	if (result.status !== 0)
		throw new Error(`codex direct journey exited ${result.status}: ${result.stdout}\n${result.stderr}`);
	return "temporary-home rendered Codex hook emits canonical typed identities, terminal-to-resume lineage, bounded concurrent callbacks without lost revisions, redacts prompt data, and advertises pull-only discovery";
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

export async function exerciseMigrationDryRunAmbiguity() {
	return runMigrationPlanReplay();
}

export async function exerciseMigrationApplyCrashRollback() {
	return runMigrationApplyReplay();
}

export async function exerciseLegacyCompatProjection() {
	return runMigrationApplyReplay();
}

const sessionJourney = path.join(repositoryRoot, "test/sessions/session-service.test.mjs");
const endpointJourney = path.join(repositoryRoot, "test/endpoints/endpoint-service.test.mjs");

function runSessionJourney(name) {
	const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-name-pattern", name, sessionJourney], { cwd: repositoryRoot, encoding: "utf8", env: process.env });
	if (result.status !== 0) throw new Error(`session journey failed: ${result.stdout}\n${result.stderr}`);
	return result.stdout.trim().split("\n").filter(Boolean).at(-1) || `${name} passed`;
}

function runEndpointJourney(name) {
	const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-name-pattern", name, endpointJourney], { cwd: repositoryRoot, encoding: "utf8", env: process.env });
	if (result.status !== 0) throw new Error(`endpoint journey failed: ${result.stdout}\n${result.stderr}`);
	return result.stdout.trim().split("\n").filter(Boolean).at(-1) || `${name} passed`;
}

export async function exerciseCrossHarnessSessionLifecycle() {
	return runSessionJourney("GOL-41 cross-harness lifecycle");
}

export async function exerciseSessionReorderRestartReplay() {
	return runSessionJourney("GOL-41 reorder/restart/replay");
}

export async function exerciseEndpointFenceConcurrencyCrash() {
	return runEndpointJourney("GOL-42 endpoint fence concurrency/crash");
}

export async function exerciseReadinessCapabilityMatrix() {
	return runEndpointJourney("GOL-42 readiness/capability matrix");
}

const typedCliEntry = path.join(repositoryRoot, "dist/apps/cli/golem.js");

function runTypedCliFixture(home, args) {
	return spawnSync(process.execPath, [typedCliEntry, ...args], {
		cwd: repositoryRoot,
		env: { ...process.env, GOLEM_HOME: home },
		encoding: "utf8",
	});
}

export async function exerciseCliCommandParity() {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "golem-j5-cli-parity-"));
	try {
		const before = fs.readdirSync(home);
		const help = runTypedCliFixture(home, ["help"]);
		assert.equal(help.status, 0);
		assert.match(help.stdout, /codex \[options\]/);
		assert.match(help.stdout, /opencode \[options\]/);
		assert.doesNotMatch(help.stdout, /^\s+launch(?:\s|$)/mu);
		const schema = runTypedCliFixture(home, ["--json-schema"]);
		assert.equal(schema.status, 0);
		const metadata = JSON.parse(schema.stdout);
		assert.equal(metadata.schemaVersion, "golem.cli-registry/v1");
		assert.equal(metadata.commands.some((command) => command.name === "launch"), false);
		const local = runTypedCliFixture(home, ["claude", "local", "--dry-run", "--json"]);
		assert.equal(local.status, 0, local.stderr);
		const localPlan = JSON.parse(local.stdout);
		assert.equal(localPlan.ok, true);
		assert.equal(localPlan.launch.status, "launchable");
		assert.equal(localPlan.delivery.mode, "native_channel");
		assert.equal(localPlan.delivery.readiness, "not_ready");
		assert.notEqual(localPlan.capabilityFacts.deliveryFlow, "push");
		const explained = runTypedCliFixture(home, ["claude", "local", "--explain"]);
		assert.equal(explained.status, 0, explained.stderr);
		assert.match(explained.stdout, /launch launchable; delivery native_channel\/unknown\/not_ready/u);
		assert.deepEqual(fs.readdirSync(home), before, "help and schema generation perform no writes");
		return "one Commander registry generated help/metadata with canonical harness verbs, compatibility names, no launch command, and zero home writes";
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

export function diagnosticFor(error, context) {
	const description = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	const temporaryRoot = context?.temporaryRoot || context?.root || (error instanceof JourneyDiagnosticError ? error.temporaryRoot : undefined);
	const sensitiveValues = context?.sensitiveValues || (context?.token ? [context.token] : undefined) || (error instanceof JourneyDiagnosticError ? error.sensitiveValues : []);
	return redactDiagnostic(description, temporaryRoot, sensitiveValues);
}

export const exercises = Object.freeze({
	"opencode-provider-coexistence": runOpenCodeComposedJourney,
	"opencode-resume-bridge-recovery": runOpenCodeComposedJourney,
	"opencode-direct-canonical-ingress": runOpenCodeNormalLaunchJourney,
	"cli-command-parity": exerciseCliCommandParity,
	"compact-launch-dry-run-matrix": exerciseCompactLaunchDryRunMatrix,
	"domain-replay": exerciseDomainReplay,
	"project-identity-git-worktree-relocation": exerciseProjectIdentityGitWorktreeRelocation,
	"project-register-concurrency": exerciseProjectRegisterConcurrency,
	"cross-harness-session-lifecycle": exerciseCrossHarnessSessionLifecycle,
	"session-reorder-restart-replay": exerciseSessionReorderRestartReplay,
	"endpoint-fence-concurrency-crash": exerciseEndpointFenceConcurrencyCrash,
	"readiness-capability-matrix": exerciseReadinessCapabilityMatrix,
	"launcher-resolution-matrix": exerciseLauncherResolution,
	"launcher-launchability-delivery-split": exerciseLauncherLaunchabilityDeliverySplit,
	"native-spawn-safety": exerciseNativeSpawnSafety,
	"launcher-signal-cleanup": exerciseLauncherSignalCleanup,
	"migration-dry-run-ambiguity": exerciseMigrationDryRunAmbiguity,
	"migration-apply-crash-rollback": exerciseMigrationApplyCrashRollback,
	"legacy-compat-projection": exerciseLegacyCompatProjection,
	"testkit-smoke": exerciseSmoke,
	"testkit-fake-harness": exerciseFakeHarness,
	"testkit-semantic-parity": exerciseSemanticParity,
	"testkit-cleanup-drill": exerciseCleanupDrill,
	"sqlite-owner-migration-recovery": exerciseSqliteOwnerMigrationRecovery,
	"materializer-crash-matrix": exerciseMaterializerCrashMatrix,
	"dashboard-down-inbox-replay": exerciseDashboardDownInboxReplay,
	"delivery-queue-crash-matrix": exerciseDeliveryQueueCrashMatrix,
	"bus-offline-replay": exerciseBusOfflineReplay,
	"ws-gap-resync": exerciseWsGapResync,
	"tracker-core-compatibility": exerciseTrackerCoreCompatibility,
	"tracker-http-mcp-parity": exerciseTrackerHttpMcpParity,
	"delivery-api-fence-recheck": exerciseDeliveryApiFenceRecheck,
	"pi-next-turn-crash-replay": exercisePiNextTurnCrashReplay,
	"pi-hostile-diagnostics": exercisePiHostileDiagnostics,
	"testkit-browser": exerciseBrowser,
	"legacy-parity-baseline": exerciseLegacyParityBaseline,
	"render-mcp-closure": exerciseRenderMcpClosure,
	"control-plane-auth-ws-lifecycle": exerciseControlPlaneShell,
	"codex-direct-seamless-integration": exerciseCodexDirectSeamlessIntegration,
	"roles-gates-ideas-controls": exerciseRolesGatesIdeasControls,
	"ticket-assets-security": exerciseTicketAssetsSecurity,
	"live-history-diagnostics": exerciseRuntimeProjectionLiveHistoryDiagnostics,
	"projection-ws-restart-resync": exerciseRuntimeProjectionWsRestartResync,
});
