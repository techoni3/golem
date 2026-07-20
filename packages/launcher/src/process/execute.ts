import {
	type ChildProcess,
	type StdioOptions,
	spawn,
} from "node:child_process";
import path from "node:path";

import {
	discoverUpstreamBinary,
	type ResolvedUpstreamBinary,
	type UpstreamDiscoveryInput,
} from "../binaries/discovery.js";
import {
	type AdapterEnvironmentContribution,
	buildSanitizedEnvironment,
	type SanitizedEnvironment,
} from "../environment/sanitize.js";
import { type LaunchRecord, launchRecord } from "../records/launch-record.js";
import type { LaunchPlan } from "../types.js";
import { executionFailure } from "./errors.js";

export interface AdapterSpawnContribution {
	/** Appended as argv data; no value is ever executed by a shell. */
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly environment?: AdapterEnvironmentContribution;
}

export interface ControlPlaneEnsurePort {
	ensure(input: {
		readonly capabilityId: string;
		readonly mode: LaunchPlan["selection"]["mode"];
	}): Promise<void>;
}

export interface LaunchExecutionInput {
	readonly plan: LaunchPlan;
	readonly discovery: UpstreamDiscoveryInput;
	readonly adapter: AdapterSpawnContribution;
	readonly resolveSecret: (keyReference: string) => string | undefined;
	readonly inheritedEnvironment?: Readonly<Record<string, string | undefined>>;
	readonly interactive: boolean;
	readonly isTTY: boolean;
	readonly dryRun?: boolean;
	readonly timeoutMs?: number;
	/**
	 * An adapter-owned readiness fence. When supplied, the automatic timeout is
	 * armed only after it resolves; a rejected fence fails safe by stopping the
	 * owned process group immediately.
	 */
	readonly timeoutGate?: Promise<void>;
	readonly controlPlane?: ControlPlaneEnsurePort;
}

export type LauncherSignal = "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGWINCH";

export interface LaunchExit {
	readonly code: number | null;
	readonly signal: string | null;
	readonly timedOut: boolean;
}

export interface CapturedLaunchOutput {
	readonly stdout: string;
	readonly stderr: string;
}

export interface RunningLaunch {
	readonly record: LaunchRecord;
	readonly pid: number;
	wait(): Promise<LaunchExit>;
	output(): CapturedLaunchOutput;
	forwardSignal(signal: LauncherSignal): void;
	forwardResize(): void;
	stop(graceMs?: number): Promise<LaunchExit>;
	installSignalForwarding(): () => void;
}

export type LaunchExecution =
	| { readonly kind: "dry_run"; readonly record: LaunchRecord }
	| { readonly kind: "running"; readonly running: RunningLaunch };

function processGroupSignal(child: ChildProcess, signal: LauncherSignal): void {
	if (!child.pid || child.exitCode !== null) return;
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch (error) {
		if (
			!(
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "ESRCH"
			)
		)
			throw error;
	}
}

function safeArgv(values: readonly string[]): readonly string[] {
	for (const value of values) {
		if (
			/[\0\r\n]/u.test(value) ||
			/^--?(?:api[_-]?key|token|secret|password|credential)(?:=|$)/iu.test(
				value,
			) ||
			/(?:api[_-]?key|token|secret|password|credential)\s*=/iu.test(value)
		)
			throw executionFailure(
				"launcher.argv.secret_or_unsafe",
				"Launch argv cannot contain secrets or unsafe control characters.",
				[
					"Pass safe native argv and provide credentials through an environment key reference.",
				],
			);
	}
	return Object.freeze([...values]);
}

function appendBounded(
	current: string,
	chunk: unknown,
	limit = 12_000,
): string {
	const next = current + String(chunk);
	return next.length <= limit ? next : `…[truncated]\n${next.slice(-limit)}`;
}

function redactCapturedOutput(
	value: string,
	sensitiveValues: readonly string[],
): string {
	let redacted = value.replace(
		/\b(?:sk|ghp|xoxb)-[-_A-Za-z0-9.]{6,}\b|\bBearer\s+[-_A-Za-z0-9.]{6,}\b/giu,
		"$REDACTED",
	);
	for (const sensitiveValue of sensitiveValues) {
		if (sensitiveValue)
			redacted = redacted.split(sensitiveValue).join("$REDACTED");
	}
	return redacted;
}

function stdioFor(input: Pick<LaunchExecutionInput, "interactive" | "isTTY">): {
	readonly value: StdioOptions;
	readonly record: LaunchRecord["stdio"];
} {
	return input.interactive && input.isTTY
		? { value: "inherit", record: "inherit" }
		: { value: ["ignore", "pipe", "pipe"], record: "capture" };
}

function argvFor(
	plan: LaunchPlan,
	adapter: AdapterSpawnContribution,
): readonly string[] {
	return safeArgv([...plan.effectiveArgvIntent.slice(1), ...adapter.argv]);
}

async function ensureManagedControlPlane(
	input: LaunchExecutionInput,
): Promise<LaunchRecord["controlPlane"]> {
	if (input.plan.selection.mode !== "managed") return "not_required";
	if (!input.controlPlane)
		throw executionFailure(
			"launcher.control_plane.ensure_required",
			"Managed launch requires the configured control-plane service.",
			["Start the local control plane or choose a direct qualified preset."],
		);
	try {
		await input.controlPlane.ensure({
			capabilityId: input.plan.selection.adapterId,
			mode: input.plan.selection.mode,
		});
	} catch {
		throw executionFailure(
			"launcher.control_plane.ensure_failed",
			"The managed control plane could not be ensured before launch.",
			["Check control-plane health or choose a direct qualified preset."],
		);
	}
	return "ensured";
}

function runningLaunch(input: {
	readonly child: ChildProcess;
	readonly record: LaunchRecord;
	readonly timeoutMs?: number;
	readonly timeoutGate?: Promise<void>;
	readonly sensitiveValues: readonly string[];
}): RunningLaunch {
	const { child, record } = input;
	if (!child.pid)
		throw executionFailure(
			"launcher.process.spawn_failed",
			"The upstream process did not provide a process identifier.",
			["Check the installed native executable and retry."],
		);
	let timedOut = false;
	let stdout = "";
	let stderr = "";
	let timeout: NodeJS.Timeout | undefined;
	let resolveExit: ((exit: LaunchExit) => void) | undefined;
	let rejectExit: ((error: Error) => void) | undefined;
	const completed = new Promise<LaunchExit>((resolve, reject) => {
		resolveExit = resolve;
		rejectExit = reject;
	});
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: unknown) => {
		stdout = appendBounded(stdout, chunk);
	});
	child.stderr?.on("data", (chunk: unknown) => {
		stderr = appendBounded(stderr, chunk);
	});
	child.once("error", () => {
		if (timeout) clearTimeout(timeout);
		rejectExit?.(
			executionFailure(
				"launcher.process.spawn_failed",
				"The upstream process could not be started.",
				["Check the trusted executable and its runtime dependencies."],
			),
		);
	});
	child.once("close", (code, signal) => {
		if (timeout) clearTimeout(timeout);
		resolveExit?.({ code, signal, timedOut });
	});
	const forwardSignal = (signal: LauncherSignal): void => {
		processGroupSignal(child, signal);
	};
	const stop = async (graceMs = 1_000): Promise<LaunchExit> => {
		forwardSignal("SIGTERM");
		const exited = await Promise.race([
			completed,
			new Promise<undefined>((resolve) => setTimeout(resolve, graceMs)),
		]);
		if (exited) return exited;
		forwardSignal("SIGKILL");
		return completed;
	};
	const armTimeout = (timeoutMs: number): void => {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
			throw executionFailure(
				"launcher.process.timeout_invalid",
				"The launch timeout must be a positive whole number of milliseconds.",
				["Use a bounded positive timeout for non-interactive launch."],
			);
		if (timeout || child.exitCode !== null || child.signalCode !== null) return;
		timeout = setTimeout(() => {
			timedOut = true;
			void stop();
		}, timeoutMs);
	};
	if (input.timeoutMs !== undefined) {
		const timeoutMs = input.timeoutMs;
		if (input.timeoutGate)
			void input.timeoutGate.then(
				() => armTimeout(timeoutMs),
				() => {
					timedOut = true;
					void stop();
				},
			);
		else armTimeout(timeoutMs);
	}
	return Object.freeze({
		record,
		pid: child.pid,
		wait: () => completed,
		output: () =>
			Object.freeze({
				stdout: redactCapturedOutput(stdout, input.sensitiveValues),
				stderr: redactCapturedOutput(stderr, input.sensitiveValues),
			}),
		forwardSignal,
		forwardResize: () => forwardSignal("SIGWINCH"),
		stop,
		installSignalForwarding: () => {
			const forwardInterrupt = () => forwardSignal("SIGINT");
			const forwardTerminate = () => forwardSignal("SIGTERM");
			const forwardWindowChange = () => forwardSignal("SIGWINCH");
			process.on("SIGINT", forwardInterrupt);
			process.on("SIGTERM", forwardTerminate);
			process.on("SIGWINCH", forwardWindowChange);
			return () => {
				process.off("SIGINT", forwardInterrupt);
				process.off("SIGTERM", forwardTerminate);
				process.off("SIGWINCH", forwardWindowChange);
			};
		},
	});
}

/**
 * Convert the redacted GOL-33 plan plus an adapter contribution into a real
 * upstream process. Every launch uses an explicit argv vector and `shell:false`.
 */
export async function executeLaunch(
	input: LaunchExecutionInput,
): Promise<LaunchExecution> {
	if (!path.isAbsolute(input.adapter.cwd))
		throw executionFailure(
			"launcher.process.cwd_invalid",
			"The native launch working directory must be absolute.",
			[
				"Resolve the project working directory before creating the adapter contribution.",
			],
		);
	if (
		input.timeoutMs !== undefined &&
		(!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)
	)
		throw executionFailure(
			"launcher.process.timeout_invalid",
			"The launch timeout must be a positive whole number of milliseconds.",
			["Use a bounded positive timeout for non-interactive launch."],
		);
	const binary: ResolvedUpstreamBinary = discoverUpstreamBinary(
		input.discovery,
	);
	const environment: SanitizedEnvironment = buildSanitizedEnvironment({
		plan: input.plan,
		...(input.inheritedEnvironment
			? { inherited: input.inheritedEnvironment }
			: {}),
		...(input.adapter.environment
			? { adapter: input.adapter.environment }
			: {}),
		resolveSecret: input.resolveSecret,
	});
	const argv = argvFor(input.plan, input.adapter);
	const stdio = stdioFor(input);
	const dryRun = input.dryRun === true;
	const controlPlane: LaunchRecord["controlPlane"] = dryRun
		? input.plan.selection.mode === "managed"
			? "would_ensure"
			: "not_required"
		: await ensureManagedControlPlane(input);
	const record = launchRecord({
		plan: input.plan,
		binary,
		argv,
		environment,
		disposition: dryRun ? "dry_run" : "spawned",
		stdio: stdio.record,
		controlPlane,
	});
	if (dryRun) return Object.freeze({ kind: "dry_run", record });
	let child: ChildProcess;
	try {
		child = spawn(binary.path, argv, {
			cwd: input.adapter.cwd,
			env: environment.values,
			shell: false,
			detached: process.platform !== "win32",
			stdio: stdio.value,
		});
	} catch {
		throw executionFailure(
			"launcher.process.spawn_failed",
			"The upstream process could not be started.",
			["Check the trusted executable and its runtime dependencies."],
		);
	}
	return Object.freeze({
		kind: "running",
		running: runningLaunch({
			child,
			record,
			sensitiveValues: Object.values(environment.values),
			...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
			...(input.timeoutGate ? { timeoutGate: input.timeoutGate } : {}),
		}),
	});
}
