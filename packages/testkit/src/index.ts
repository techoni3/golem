import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ContractBoundary } from "@golem/contracts";

interface ReadableChildStream {
	setEncoding(encoding: string): void;
	on(event: "data", listener: (chunk: unknown) => void): void;
}

interface SpawnedChild {
	readonly pid?: number;
	readonly stdout?: ReadableChildStream;
	readonly stderr?: ReadableChildStream;
	readonly exitCode: number | null;
	readonly signalCode: string | null;
	once(event: "exit", listener: () => void): void;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
}

interface ChildProcessModule {
	spawn(
		command: string,
		args: readonly string[],
		options: {
			cwd: string;
			env: Record<string, string>;
			detached: boolean;
			stdio: ["pipe", "pipe", "pipe"];
		},
	): SpawnedChild;
}

interface CryptoModule {
	createHash(name: "sha256"): {
		update(value: string): { digest(encoding: "hex"): string };
	};
}

interface FsModule {
	mkdtempSync(prefix: string): string;
	mkdirSync(directory: string, options: { recursive: true }): void;
	rmSync(directory: string, options: { recursive: true; force: true }): void;
}

interface OsModule {
	tmpdir(): string;
}

interface PathModule {
	join(...segments: readonly string[]): string;
	relative(from: string, to: string): string;
	isAbsolute(value: string): boolean;
}

const childProcessBoundary = childProcess as ChildProcessModule;
const cryptoBoundary = crypto as CryptoModule;
const fsBoundary = fs as FsModule;
const osBoundary = os as OsModule;
const pathBoundary = path as PathModule;

export const journeyIds = [
	"J1",
	"J2",
	"J3",
	"J4",
	"J5",
	"J6",
	"J7",
	"J8",
] as const;

export type JourneyId = (typeof journeyIds)[number];
export type JourneyTier = "pr" | "integration" | "release";
export type JourneyStatus = "PASS" | "FAIL" | "UNMET";

export interface TestkitBoundary {
	readonly contract: ContractBoundary;
}

export interface JourneyScenario {
	readonly id: string;
	readonly journey: JourneyId;
	readonly tier: JourneyTier;
	readonly regression: string;
}

export interface JourneyResult extends JourneyScenario {
	readonly status: JourneyStatus;
	readonly evidence: string;
}

export interface JourneySummary {
	readonly schema_version: "golem-journey-summary/v1";
	readonly overall: JourneyStatus;
	readonly results: readonly JourneyResult[];
}

export interface TemporaryHome {
	readonly root: string;
	readonly home: string;
	readonly temporaryDir: string;
	readonly golemHome: string;
	readonly xdgConfigHome: string;
	readonly runtimeDb: string;
	readonly trackerDb: string;
	readonly token: string;
	readonly env: Readonly<Record<string, string>>;
	cleanup(): void;
}

export interface GroupedChild {
	readonly child: SpawnedChild;
	readonly command: string;
	readonly stdout: () => string;
	readonly stderr: () => string;
}

export interface SemanticParityDiff {
	readonly equal: boolean;
	readonly changed_paths: readonly string[];
	readonly expected: unknown;
	readonly actual: unknown;
}

export interface HeadlessPage {
	goto(url: string, options?: unknown): Promise<unknown>;
	screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
}

export interface HeadlessContext {
	readonly tracing: {
		start(options?: unknown): Promise<unknown>;
		stop(options?: { path?: string }): Promise<unknown>;
	};
	newPage(): Promise<HeadlessPage>;
	close(): Promise<unknown>;
}

export interface HeadlessBrowser {
	newContext(options?: unknown): Promise<HeadlessContext>;
	close(): Promise<unknown>;
}

export type HeadlessLaunch = (options: {
	headless: true;
	executablePath?: string;
	args: readonly string[];
}) => Promise<HeadlessBrowser>;

const inheritedEnvironment = ["PATH", "LANG", "LC_ALL", "TZ"] as const;
const redactedValue =
	/\b(?:sk|ghp|xoxb)-[-_A-Za-z0-9.]{6,}\b|\bBearer\s+[-_A-Za-z0-9.]{6,}\b/giu;

function appendBounded(
	current: string,
	chunk: unknown,
	limit = 12_000,
): string {
	const next = current + String(chunk);
	return next.length <= limit ? next : `…[truncated]\n${next.slice(-limit)}`;
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, stableValue(child)]),
	);
}

function childExited(child: SpawnedChild): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null)
		return Promise.resolve();
	return new Promise((resolve) => child.once("exit", resolve));
}

function isErrno(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}

function terminateGroup(
	child: SpawnedChild,
	signal: "SIGTERM" | "SIGKILL",
): void {
	if (!child?.pid || child.exitCode !== null) return;
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch (error) {
		if (!isErrno(error, "ESRCH")) throw error;
	}
}

export function registerScenario(scenario: JourneyScenario): JourneyScenario {
	if (!journeyIds.includes(scenario.journey))
		throw new Error(`${scenario.id} must declare a J1–J8 journey id`);
	if (!scenario.regression.trim())
		throw new Error(`${scenario.id} must name its catastrophic regression`);
	if (!scenario.id.trim()) throw new Error("journey scenario id is required");
	return Object.freeze({ ...scenario });
}

export function summarizeJourneys(
	results: readonly JourneyResult[],
): JourneySummary {
	const normalized = results.map((result) => ({
		...registerScenario(result),
		status: result.status,
		evidence: result.evidence,
	}));
	const overall = normalized.some((result) => result.status === "FAIL")
		? "FAIL"
		: normalized.some((result) => result.status === "UNMET")
			? "UNMET"
			: "PASS";
	return Object.freeze({
		schema_version: "golem-journey-summary/v1",
		overall,
		results: normalized,
	});
}

export function stableSummaryJson(summary: JourneySummary): string {
	return `${JSON.stringify(stableValue(summary), null, 2)}\n`;
}

export function createLogicalClock(seed = "golem-journey-seed-v1"): {
	now(): number;
	advance(ms: number): number;
} {
	let tick = Number.parseInt(
		cryptoBoundary.createHash("sha256").update(seed).digest("hex").slice(0, 8),
		16,
	);
	return Object.freeze({
		now: () => tick,
		advance: (ms: number) => {
			if (!Number.isSafeInteger(ms) || ms < 0)
				throw new Error("logical clock advances by a non-negative integer");
			tick += ms;
			return tick;
		},
	});
}

export function createTemporaryHome(prefix = "golem-journey-"): TemporaryHome {
	const root = fsBoundary.mkdtempSync(
		pathBoundary.join(osBoundary.tmpdir(), prefix),
	);
	const home = pathBoundary.join(root, "home");
	const temporaryDir = pathBoundary.join(root, "tmp");
	const golemHome = pathBoundary.join(root, "golem-home");
	const xdgConfigHome = pathBoundary.join(root, "xdg-config");
	const runtimeDb = pathBoundary.join(root, "runtime.db");
	const trackerDb = pathBoundary.join(root, "tracker.db");
	for (const directory of [home, temporaryDir, golemHome, xdgConfigHome])
		fsBoundary.mkdirSync(directory, { recursive: true });
	const env: Record<string, string> = {};
	for (const key of inheritedEnvironment) {
		const value = process.env[key];
		if (typeof value === "string" && value) env[key] = value;
	}
	const token = cryptoBoundary.createHash("sha256").update(root).digest("hex");
	Object.assign(env, {
		HOME: home,
		TMPDIR: temporaryDir,
		TMP: temporaryDir,
		TEMP: temporaryDir,
		GOLEM_HOME: golemHome,
		XDG_CONFIG_HOME: xdgConfigHome,
		XDG_CACHE_HOME: pathBoundary.join(root, "xdg-cache"),
		GOLEM_RUNTIME_DB: runtimeDb,
		GOLEM_TRACKER_DB: trackerDb,
		GOLEM_TEST_TOKEN: token,
	});
	return Object.freeze({
		root,
		home,
		temporaryDir,
		golemHome,
		xdgConfigHome,
		runtimeDb,
		trackerDb,
		token,
		env: Object.freeze(env),
		cleanup: () => fsBoundary.rmSync(root, { recursive: true, force: true }),
	});
}

export function assertContained(root: string, candidate: string): void {
	const relative = pathBoundary.relative(root, candidate);
	if (relative.startsWith("..") || pathBoundary.isAbsolute(relative))
		throw new Error(`test artifact escaped its temporary root: ${candidate}`);
}

export function redactDiagnostic(
	value: string,
	temporaryRoot?: string,
	sensitiveValues: readonly string[] = [],
): string {
	let redacted = value.replace(redactedValue, "$REDACTED");
	for (const sensitiveValue of sensitiveValues) {
		if (sensitiveValue)
			redacted = redacted.split(sensitiveValue).join("$REDACTED");
	}
	if (temporaryRoot)
		redacted = redacted.split(temporaryRoot).join("$TEMP_ROOT");
	return redacted;
}

export function spawnGrouped(
	command: string,
	args: readonly string[],
	options: { cwd: string; env: Record<string, string> },
): GroupedChild {
	let stdout = "";
	let stderr = "";
	const child = childProcessBoundary.spawn(command, args, {
		cwd: options.cwd,
		env: options.env,
		detached: process.platform !== "win32",
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: unknown) => {
		stdout = appendBounded(stdout, chunk);
	});
	child.stderr?.on("data", (chunk: unknown) => {
		stderr = appendBounded(stderr, chunk);
	});
	return Object.freeze({
		child,
		command: [command, ...args].join(" "),
		stdout: () => stdout,
		stderr: () => stderr,
	});
}

export async function stopProcessGroup(
	group: GroupedChild,
	graceMs = 1_000,
): Promise<void> {
	terminateGroup(group.child, "SIGTERM");
	await Promise.race([
		childExited(group.child),
		new Promise((resolve) => setTimeout(resolve, graceMs)),
	]);
	if (group.child.exitCode === null) {
		terminateGroup(group.child, "SIGKILL");
		await childExited(group.child);
	}
}

export async function waitFor<T>(
	check: () => Promise<T | undefined> | T | undefined,
	label: string,
	timeoutMs = 8_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await check();
			if (value !== undefined) return value;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(
		`${label} timed out${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
	);
}

export function semanticParityDiff(
	legacy: unknown,
	replacement: unknown,
	normalize: (value: unknown) => unknown,
): SemanticParityDiff {
	const expected = normalize(legacy);
	const actual = normalize(replacement);
	const changed: string[] = [];
	function visit(left: unknown, right: unknown, current: string): void {
		if (JSON.stringify(left) === JSON.stringify(right)) return;
		if (
			!left ||
			!right ||
			typeof left !== "object" ||
			typeof right !== "object" ||
			Array.isArray(left) !== Array.isArray(right)
		) {
			changed.push(current || "$");
			return;
		}
		const keys = new Set([
			...Object.keys(left as object),
			...Object.keys(right as object),
		]);
		for (const key of [...keys].sort())
			visit(
				(left as Record<string, unknown>)[key],
				(right as Record<string, unknown>)[key],
				`${current}/${key}`,
			);
	}
	visit(expected, actual, "");
	return Object.freeze({
		equal: changed.length === 0,
		changed_paths: changed,
		expected,
		actual,
	});
}

export async function runHeadlessServiceFixture(options: {
	launch: HeadlessLaunch;
	origin: string;
	artifactRoot: string;
	executablePath?: string;
}): Promise<void> {
	const browser = await options.launch({
		headless: true,
		args: [
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-default-apps",
			"--no-sandbox",
		],
		...(options.executablePath
			? { executablePath: options.executablePath }
			: {}),
	});
	let context: HeadlessContext | undefined;
	let page: HeadlessPage | undefined;
	try {
		context = await browser.newContext();
		await context.tracing.start({ screenshots: true, snapshots: true });
		page = await context.newPage();
		await page.goto(`${options.origin}/health`, { waitUntil: "networkidle" });
		await context.tracing.stop();
	} catch (error) {
		fsBoundary.mkdirSync(options.artifactRoot, { recursive: true });
		if (page)
			await page.screenshot({
				path: pathBoundary.join(options.artifactRoot, "failure.png"),
				fullPage: true,
			});
		if (context)
			await context.tracing.stop({
				path: pathBoundary.join(options.artifactRoot, "failure.zip"),
			});
		throw error;
	} finally {
		try {
			await context?.close();
		} catch {
			/* cleanup only */
		}
		try {
			await browser.close();
		} catch {
			/* cleanup only */
		}
	}
}
