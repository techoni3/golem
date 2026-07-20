import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	discoverUpstreamBinary,
	executeLaunch,
	LauncherExecutionError,
	parseJsoncConfig,
	resolveLaunch,
	stableLaunchRecordJson,
} from "@golem/launcher";
import { createTemporaryHome, waitFor } from "@golem/testkit";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fakeHarness = path.join(repositoryRoot, "test/fixtures/native-binaries/fake-harness.mjs");
const now = "2026-07-20T00:00:00.000Z";
const secret = "upstream-secret-value-must-not-appear";

function launcherConfig() {
	return parseJsoncConfig(
		`{
  "schema_version": "golem.launcher-config/v1",
  "launch": {
    "harness_defaults": { "opencode": "fixture" },
    "presets": [{
      "name": "fixture",
      "harness": "opencode",
      "backend": "ollama_local",
      "model_selector": "fixture-model",
      "delivery_mode": "prompt_bridge",
      "native_args": [],
      "env_key_refs": ["UPSTREAM_TOKEN"]
    }]
  }
}\n`,
		"user",
	);
}

function resolvedPlan(harness = "opencode") {
	const resolution = resolveLaunch({
		harness,
		user: harness === "opencode" ? launcherConfig() : undefined,
		isTTY: false,
		now,
	});
	assert.equal(resolution.ok, true, resolution.ok ? "" : resolution.error.code);
	return resolution;
}

function expectExecutionFailure(action, code) {
	assert.throws(action, (error) => {
		assert.equal(error instanceof LauncherExecutionError, true);
		assert.equal(error.code, code);
		assert.equal(String(error).includes(secret), false);
		return true;
	});
}

function writeExecutable(directory, name, mode = 0o755) {
	const target = path.join(directory, name);
	fs.writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode });
	fs.chmodSync(target, mode);
	return target;
}

function rows(logPath) {
	return fs
		.readFileSync(logPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function waitForRow(logPath, predicate, label) {
	return waitFor(() => {
		if (!fs.existsSync(logPath)) return undefined;
		return rows(logPath).find(predicate);
	}, label);
}

async function childIsGone(pid) {
	await waitFor(() => {
		try {
			process.kill(pid, 0);
			return undefined;
		} catch (error) {
			if (error && typeof error === "object" && error.code === "ESRCH") return true;
			throw error;
		}
	}, `fixture descendant ${pid} termination`);
}

function trustedNodeDiscovery(home) {
	return {
		commandName: "node",
		explicitPath: process.execPath,
		trustedExplicitPaths: [process.execPath],
		golemExecutable: path.join(home.root, "golem-not-node"),
		compatibilityShims: [],
	};
}

function executionInput(home, plan, logPath, mode, extra = {}) {
	return {
		plan,
		discovery: trustedNodeDiscovery(home),
		adapter: {
			argv: [
				fakeHarness,
				"--mode",
				mode,
				"space value",
				"$(not-expanded)",
				"`not-expanded`",
				"*.glob",
				"semi;colon",
			],
			cwd: repositoryRoot,
			environment: {
				values: {
					TESTKIT_FAKE_VALUE: "allowed-value",
					TESTKIT_FAKE_LOG: logPath,
				},
			},
		},
		resolveSecret: (reference) => reference === "UPSTREAM_TOKEN" || reference === "OPENAI_API_KEY" ? secret : undefined,
		inheritedEnvironment: {
			PATH: process.env.PATH,
			HOME: home.home,
			LANG: "C",
			FORBIDDEN_INHERITED: secret,
		},
		interactive: false,
		isTTY: false,
		...extra,
	};
}

function proveTrustedDiscovery(home) {
	const root = fs.mkdtempSync(path.join(home.root, "discovery-"));
	try {
		const first = fs.mkdtempSync(path.join(root, "first-"));
		const second = fs.mkdtempSync(path.join(root, "second-"));
		const firstNative = writeExecutable(first, "native");
		writeExecutable(second, "native");
		const selected = discoverUpstreamBinary({
			commandName: "native",
			pathValue: `${first}${path.delimiter}${second}`,
			golemExecutable: path.join(root, "golem"),
			compatibilityShims: [],
		});
		assert.equal(selected.path, fs.realpathSync(firstNative), "first safe PATH entry wins deterministically");
			expectExecutionFailure(
			() => discoverUpstreamBinary({
				commandName: "native",
				pathValue: `${first}${path.delimiter}.`,
				golemExecutable: path.join(root, "golem"),
				compatibilityShims: [],
			}),
			"launcher.binary.path_entry_invalid",
		);

		const recursion = writeExecutable(root, "recursion");
		expectExecutionFailure(
			() => discoverUpstreamBinary({
				commandName: "recursion",
				pathValue: root,
				golemExecutable: recursion,
				compatibilityShims: [],
			}),
			"launcher.binary.recursion",
		);

		const golem = writeExecutable(root, "golem");
		const golemc = writeExecutable(root, "golemc");
		const golemx = writeExecutable(root, "golemx");
		for (const commandName of ["golemc", "golemx"]) {
			expectExecutionFailure(
				() => discoverUpstreamBinary({
					commandName,
					pathValue: root,
					golemExecutable: golem,
					compatibilityShims: [golemc, golemx],
				}),
				"launcher.binary.recursion",
			);
		}
		const shimDirectory = fs.mkdtempSync(path.join(root, "shim-"));
		const pathShim = path.join(shimDirectory, "native");
		fs.symlinkSync(golemc, pathShim);
		expectExecutionFailure(
			() => discoverUpstreamBinary({
				commandName: "native",
				pathValue: `${shimDirectory}${path.delimiter}${first}`,
				golemExecutable: golem,
				compatibilityShims: [golemc, golemx],
			}),
			"launcher.binary.recursion",
		);

		const worldWritable = writeExecutable(root, "world-writable", 0o777);
		expectExecutionFailure(
			() => discoverUpstreamBinary({
				commandName: "world-writable",
				explicitPath: worldWritable,
				trustedExplicitPaths: [worldWritable],
				golemExecutable: path.join(root, "golem"),
				compatibilityShims: [],
			}),
			"launcher.binary.world_writable",
		);

		const nonExecutable = writeExecutable(root, "not-executable", 0o644);
		expectExecutionFailure(
			() => discoverUpstreamBinary({
				commandName: "not-executable",
				explicitPath: nonExecutable,
				trustedExplicitPaths: [nonExecutable],
				golemExecutable: path.join(root, "golem"),
				compatibilityShims: [],
			}),
			"launcher.binary.not_executable",
		);

		const loopA = path.join(root, "loop-a");
		const loopB = path.join(root, "loop-b");
		fs.symlinkSync(loopB, loopA);
		fs.symlinkSync(loopA, loopB);
		expectExecutionFailure(
			() => discoverUpstreamBinary({
				commandName: "native",
				explicitPath: loopA,
				trustedExplicitPaths: [loopA],
				golemExecutable: path.join(root, "golem"),
				compatibilityShims: [],
			}),
			"launcher.binary.symlink_loop",
		);

		expectExecutionFailure(
			() => discoverUpstreamBinary({
				commandName: "missing",
				explicitPath: path.join(root, "missing"),
				trustedExplicitPaths: [path.join(root, "missing")],
				golemExecutable: path.join(root, "golem"),
				compatibilityShims: [],
			}),
			"launcher.binary.unavailable",
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

/** J5: protects against a recursive/unsafe native launch or a leaked process group. */
export async function exerciseNativeSpawnSafety() {
	const home = createTemporaryHome("golem-j5-native-spawn-");
	const ownedLaunches = new Set();
	try {
		proveTrustedDiscovery(home);
		const directPlan = resolvedPlan();
		const logPath = path.join(home.root, "native.ndjson");
		const started = await executeLaunch(executionInput(home, directPlan, logPath, "tree"));
		assert.equal(started.kind, "running");
		if (started.kind !== "running") throw new Error("native launch did not start");
		ownedLaunches.add(started.running);
		const launchStart = await waitForRow(logPath, (row) => row.event === "start", "fake native start");
		const start = await waitForRow(logPath, (row) => row.event === "ready", "fake native readiness");
		assert.equal(started.running.record.stdio, "capture");
		assert.equal(started.running.record.controlPlane, "not_required");
		assert.equal(stableLaunchRecordJson(started.running.record).includes(secret), false);
		assert.equal(started.running.record.environmentKeys.includes("UPSTREAM_TOKEN"), true);
		assert.equal(started.running.record.environmentKeys.includes("FORBIDDEN_INHERITED"), false);
		const capture = await waitFor(() => {
			const output = started.running.output();
			return output.stdout.includes("ready") && output.stderr.includes("fixture-stderr")
				? output
				: undefined;
		}, "fake native captured stdout and stderr");
		assert.equal(capture.stdout.includes(secret), false);
		assert.equal(capture.stderr.includes(secret), false);
		assert.deepEqual(start.args.slice(-5), ["space value", "$(not-expanded)", "`not-expanded`", "*.glob", "semi;colon"]);
		assert.equal(launchStart.cwd, repositoryRoot, "fake native receives the real adapter cwd");
		assert.deepEqual(launchStart.stdio, {
			stdin_is_tty: false,
			stdout_is_tty: false,
			stderr_is_tty: false,
		}, "captured launch uses non-TTY child streams");
		const capturedStdin = await waitForRow(logPath, (row) => row.event === "stdin", "captured stdin close");
		assert.equal(capturedStdin.stdin, "", "captured launch does not inherit caller stdin");
		assert.deepEqual(start.env, {
			TESTKIT_FAKE_VALUE: "allowed-value",
			has_upstream_secret: true,
			has_forbidden_inherited_value: false,
		});
		const exited = await started.running.stop(100);
		assert.equal(exited.code, 0, "owned process groups stop cleanly after noninteractive launch");
		assert.equal(typeof start.worker_pid, "number");
		await childIsGone(start.worker_pid);

		const ttyLog = path.join(home.root, "tty.ndjson");
		const interactive = await executeLaunch(executionInput(home, directPlan, ttyLog, "ready", {
			interactive: true,
			isTTY: true,
		}));
		assert.equal(interactive.kind, "running");
		if (interactive.kind !== "running") throw new Error("interactive native launch did not start");
		ownedLaunches.add(interactive.running);
		const ttyStart = await waitForRow(ttyLog, (row) => row.event === "start", "interactive native start");
		assert.equal(interactive.running.record.stdio, "inherit");
		assert.deepEqual(ttyStart.stdio, {
			stdin_is_tty: process.stdin.isTTY === true,
			stdout_is_tty: process.stdout.isTTY === true,
			stderr_is_tty: process.stderr.isTTY === true,
		}, "interactive launch inherits the real parent TTY state");
		await interactive.running.stop(100);

		const dryLog = path.join(home.root, "dry-run.ndjson");
		const dryRun = await executeLaunch(executionInput(home, directPlan, dryLog, "ready", {
			dryRun: true,
			interactive: true,
			isTTY: true,
		}));
		assert.equal(dryRun.kind, "dry_run");
		assert.equal(dryRun.record.stdio, "inherit");
		assert.equal(fs.existsSync(dryLog), false, "dry-run validates discovery without spawning");
		assert.equal(stableLaunchRecordJson(dryRun.record).includes(secret), false);

		const unsafeLog = path.join(home.root, "unsafe-argv.ndjson");
		const unsafeInput = executionInput(home, directPlan, unsafeLog, "ready");
		await assert.rejects(
			() => executeLaunch({
				...unsafeInput,
				adapter: {
					...unsafeInput.adapter,
					argv: [fakeHarness, "--token=adapter-secret"],
				},
			}),
			(error) => error instanceof LauncherExecutionError && error.code === "launcher.argv.secret_or_unsafe" && !String(error).includes("adapter-secret"),
		);
		assert.equal(fs.existsSync(unsafeLog), false, "secret argv is rejected before native execution");

		const managedPlan = resolvedPlan("codex");
		const managedLog = path.join(home.root, "managed.ndjson");
		let ensureCalls = 0;
		const managed = await executeLaunch(executionInput(home, managedPlan, managedLog, "crash", {
			controlPlane: {
				ensure: async ({ capabilityId }) => {
					ensureCalls += 1;
					assert.equal(capabilityId, "codex.openai.managed");
				},
			},
		}));
		assert.equal(managed.kind, "running");
		if (managed.kind !== "running") throw new Error("managed launch did not start");
		ownedLaunches.add(managed.running);
		assert.equal((await managed.running.wait()).code, 23);
		assert.equal(ensureCalls, 1, "only managed launch invokes the control-plane ensure port");

		const failedManagedLog = path.join(home.root, "managed-failed.ndjson");
		await assert.rejects(
			() => executeLaunch(executionInput(home, managedPlan, failedManagedLog, "ready", {
				controlPlane: { ensure: async () => { throw new Error(secret); } },
			})),
			(error) => error instanceof LauncherExecutionError && error.code === "launcher.control_plane.ensure_failed" && !String(error).includes(secret),
		);
		assert.equal(fs.existsSync(failedManagedLog), false, "ensure failure blocks spawn before native execution");
		return "absolute PATH/named-shim refusal, shell-free argv/env, real cwd/capture/TTY, dry-run, process groups, managed ensure, and redacted records verified";
	} finally {
		await Promise.all(
			[...ownedLaunches].map(async (running) => {
				try {
					await running.stop(100);
				} catch {
					// The result assertion remains the primary failure; this only owns cleanup.
				}
			}),
		);
		home.cleanup();
	}
}

/** J5 companion matrix entry: protects signal/resize propagation and timeout cleanup. */
export async function exerciseLauncherSignalCleanup() {
	const home = createTemporaryHome("golem-j5-launcher-signals-");
	const ownedLaunches = new Set();
	try {
		const directPlan = resolvedPlan();
		const signalLog = path.join(home.root, "signals.ndjson");
		const started = await executeLaunch(executionInput(home, directPlan, signalLog, "tree"));
		assert.equal(started.kind, "running");
		if (started.kind !== "running") throw new Error("signal fixture did not start");
		ownedLaunches.add(started.running);
		const ready = await waitForRow(signalLog, (row) => row.event === "ready", "signal fixture readiness");
		const listenerCounts = Object.freeze({
			SIGINT: process.listenerCount("SIGINT"),
			SIGTERM: process.listenerCount("SIGTERM"),
			SIGWINCH: process.listenerCount("SIGWINCH"),
		});
		const restoreForwarding = started.running.installSignalForwarding();
		assert.equal(process.listenerCount("SIGINT"), listenerCounts.SIGINT + 1);
		assert.equal(process.listenerCount("SIGTERM"), listenerCounts.SIGTERM + 1);
		assert.equal(process.listenerCount("SIGWINCH"), listenerCounts.SIGWINCH + 1);
		process.kill(process.pid, "SIGWINCH");
		await waitForRow(signalLog, (row) => row.event === "signal" && row.signal === "SIGWINCH", "installed resize forwarding");
		restoreForwarding();
		assert.deepEqual({
			SIGINT: process.listenerCount("SIGINT"),
			SIGTERM: process.listenerCount("SIGTERM"),
			SIGWINCH: process.listenerCount("SIGWINCH"),
		}, listenerCounts, "signal forwarding listeners restore exactly");
		started.running.forwardSignal("SIGINT");
		const exited = await started.running.wait();
		assert.equal(exited.code, 0, "SIGINT exits the upstream process cleanly");
		assert.equal(typeof ready.worker_pid, "number");
		await childIsGone(ready.worker_pid);

		const timeoutLog = path.join(home.root, "timeout.ndjson");
		const timed = await executeLaunch(
			executionInput(home, directPlan, timeoutLog, "stubborn-tree"),
		);
		assert.equal(timed.kind, "running");
		if (timed.kind !== "running") throw new Error("timeout launch did not start");
		ownedLaunches.add(timed.running);
		const timeoutReady = await waitForRow(
			timeoutLog,
			(row) =>
				row.event === "ready" &&
				row.root_sigterm_resistance_ready === true,
			"SIGTERM-resistance readiness before TERM-to-KILL timeout",
		);
		const timeoutExit = await timed.running.stop(50);
		assert.equal(timeoutExit.signal, "SIGKILL", "observably SIGTERM-resistant root receives bounded SIGKILL");
		await waitForRow(timeoutLog, (row) => row.event === "signal" && row.signal === "SIGTERM", "timeout termination");
		assert.equal(timeoutReady.root_sigterm_resistance_ready, true, "TERM-to-KILL grace starts only after the fixture confirms resistance");
		assert.equal(typeof timeoutReady.worker_pid, "number");
		await childIsGone(timeoutReady.worker_pid);
		return "SIGINT/SIGWINCH forwarding, listener restoration, readiness-gated TERM-to-KILL timeout, and descendant cleanup verified";
	} finally {
		await Promise.all(
			[...ownedLaunches].map(async (running) => {
				try {
					await running.stop(100);
				} catch {
					// The result assertion remains the primary failure; this only owns cleanup.
				}
			}),
		);
		home.cleanup();
	}
}
