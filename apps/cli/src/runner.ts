import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	openCodeManagedProviderRegion,
	openCodeProviderCapabilities,
	openCodeRuntimeProjectId,
	probeOpenCodeProviders,
	setupOpenCodeConfig,
} from "@golem/adapter-opencode";
import type { Harness } from "@golem/contracts";
import {
	executeLaunch,
	LauncherExecutionError,
	LauncherResolutionError,
	type LaunchPlanBridge,
	type LaunchResolution,
	launchPlanBridge,
	parseJsoncConfig,
	resolveLaunch,
} from "@golem/launcher";
import { runAliases } from "./commands/aliases.js";
import { runCompletions } from "./commands/completions.js";
import { choosePreset } from "./commands/picker.js";
import {
	pickerCandidates,
	recordRecentPreset,
	runPresets,
} from "./commands/presets.js";
import { CLI_EXIT_CODES, CliResolutionError, CliUsageError } from "./errors.js";
import { conciseSelection, stableCliJson } from "./format.js";
import {
	commandDefinition,
	commandMetadata,
	commandRegistry,
	createProgram,
} from "./registry.js";

export interface CliIo {
	readonly stdout?: (line: string) => void;
	readonly stderr?: (line: string) => void;
	readonly isTTY?: boolean;
	readonly now?: string;
	/** Injectable only for the TTY picker journey; production reads standard input. */
	readonly readLine?: (prompt: string) => Promise<string>;
}

export interface ParsedCliInput {
	readonly command: string;
	readonly globalPreset?: string;
	readonly scopedPreset?: string;
	readonly model?: string;
	readonly backend?: string;
	readonly session?: string;
	readonly cwd?: string;
	readonly dryRun: boolean;
	readonly apply: boolean;
	readonly config?: string;
	readonly delivery?: string;
	readonly scope?: string;
	readonly shell?: string;
	readonly name?: string;
	readonly explain: boolean;
	readonly json: boolean;
	readonly passthrough: readonly string[];
	readonly help: boolean;
	readonly positionals: readonly string[];
}

const harnesses = new Set<Harness>(["codex", "opencode", "claude", "pi"]);
const backends = new Set([
	"openai",
	"anthropic",
	"ollama_local",
	"ollama_cloud",
	"native",
]);

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

interface ManagedOpenCodeIngress {
	readonly projectId: string;
	readonly origin: string;
	readonly token: string;
	stop(): Promise<void>;
}

class OpenCodeControlPlaneError extends Error {
	readonly code: string;

	constructor() {
		super("adapter.opencode.control_plane.unavailable");
		this.name = "OpenCodeControlPlaneError";
		this.code = "adapter.opencode.control_plane.unavailable";
	}
}

function controlPlaneArtifact(relative: string): string | undefined {
	const candidate = resolve(moduleDirectory, relative);
	return existsSync(candidate) ? candidate : undefined;
}

function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null)
		return Promise.resolve();
	return new Promise((resolveStop) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(force);
			resolveStop();
		};
		const force = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// The owned control plane is already gone.
			}
		}, 1_000);
		child.once("exit", finish);
		try {
			child.kill("SIGTERM");
		} catch {
			finish();
		}
	});
}

/**
 * Direct OpenCode launch owns its private control-plane process for the exact
 * lifetime of the native child. This is deliberately not a config mutation or
 * a global daemon: the only credentials exposed are the short-lived bearer and
 * the standard, sanitized launcher environment.
 */
async function startManagedOpenCodeIngress(
	projectPath: string,
): Promise<ManagedOpenCodeIngress> {
	const main = controlPlaneArtifact("../../../apps/control-plane/dist/main.js");
	const staticDirectory = controlPlaneArtifact(
		"../../../dashboard/dist/control-plane",
	);
	if (!main || !staticDirectory) throw new OpenCodeControlPlaneError();
	const projectId = openCodeRuntimeProjectId(projectPath);
	const token = randomBytes(32).toString("base64url");
	const child = spawn(process.execPath, [main], {
		cwd: projectPath,
		env: {
			...process.env,
			GOLEM_CONTROL_PLANE_PORT: "0",
			GOLEM_CONTROL_PLANE_STATIC_ROOT: staticDirectory,
			GOLEM_CONTROL_PLANE_TOKEN: token,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	return new Promise((resolveIngress, rejectIngress) => {
		let settled = false;
		let buffered = "";
		const fail = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			void stopChild(child);
			rejectIngress(new OpenCodeControlPlaneError());
		};
		const ready = (origin: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolveIngress({
				projectId,
				origin,
				token,
				stop: () => stopChild(child),
			});
		};
		const timeout = setTimeout(fail, 3_000);
		child.once("error", fail);
		child.once("exit", () => {
			if (!settled) fail();
		});
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			buffered += chunk;
			let newline = buffered.indexOf("\n");
			while (newline !== -1) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				try {
					const message = JSON.parse(line) as {
						type?: unknown;
						origin?: unknown;
					};
					if (
						message.type === "ready" &&
						typeof message.origin === "string" &&
						message.origin.startsWith("http://127.0.0.1:")
					)
						ready(message.origin);
				} catch {
					// Control-plane warnings are not part of the ready protocol.
				}
				newline = buffered.indexOf("\n");
			}
		});
	});
}

function output(io: CliIo, line: string): void {
	(io.stdout ?? ((value: string) => process.stdout.write(`${value}\n`)))(line);
}

function errorOutput(io: CliIo, line: string): void {
	(io.stderr ?? ((value: string) => process.stderr.write(`${value}\n`)))(line);
}

function splitPassthrough(argv: readonly string[]): {
	readonly known: readonly string[];
	readonly passthrough: readonly string[];
} {
	const marker = argv.indexOf("--");
	return marker === -1
		? { known: argv, passthrough: [] }
		: { known: argv.slice(0, marker), passthrough: argv.slice(marker + 1) };
}

function normalizeGlobalPreset(argv: readonly string[]): {
	readonly argv: readonly string[];
	readonly globalPreset?: string;
} {
	const first = argv[0];
	if (!first?.startsWith("@") || first.length < 2) return { argv };
	return {
		argv: ["global-preset", first.slice(1), ...argv.slice(1)],
		globalPreset: first.slice(1),
	};
}

function commanderParse(known: readonly string[]): {
	readonly command: string;
	readonly commandArgs: readonly string[];
	readonly options: Record<string, unknown>;
} {
	const commandName = known[0] ?? "help";
	const definition = commandDefinition(commandName);
	if (!definition) throw new CliUsageError(`unknown command: ${commandName}`);
	if (known.includes("--help") || known.includes("-h"))
		return { command: commandName, commandArgs: [], options: { help: true } };
	const program = createProgram();
	try {
		program.parse(["node", "golem", ...known], { from: "node" });
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "invalid command arguments";
		throw new CliUsageError(message.replace(/^error:\s*/iu, ""));
	}
	const command = program.commands.find(
		(entry) => entry.name() === commandName,
	);
	return {
		command: commandName,
		commandArgs: command?.args ?? [],
		options: command?.opts() ?? {},
	};
}

export function parseCliInput(argv: readonly string[]): ParsedCliInput {
	const normalized = normalizeGlobalPreset(argv);
	const split = splitPassthrough(normalized.argv);
	const parsed = commanderParse(split.known);
	const commandArgs = parsed.commandArgs;
	if (parsed.command === "help" || parsed.options.help === true) {
		return {
			command: parsed.command,
			dryRun: false,
			apply: false,
			explain: false,
			json: false,
			passthrough: split.passthrough,
			help: true,
			positionals: [],
		};
	}
	const administrative = new Set(["presets", "completions", "aliases"]);
	if (administrative.has(parsed.command)) {
		const options = parsed.options;
		return {
			command: parsed.command,
			...(typeof options.backend === "string"
				? { backend: options.backend }
				: {}),
			...(typeof options.model === "string" ? { model: options.model } : {}),
			...(typeof options.delivery === "string"
				? { delivery: options.delivery }
				: {}),
			...(typeof options.scope === "string" ? { scope: options.scope } : {}),
			...(typeof options.shell === "string" ? { shell: options.shell } : {}),
			...(typeof options.name === "string" ? { name: options.name } : {}),
			dryRun: false,
			apply: options.apply === true,
			explain: false,
			json: options.json === true,
			passthrough: split.passthrough,
			help: false,
			positionals: commandArgs,
		};
	}
	const globalPreset = normalized.globalPreset;
	const optionPreset =
		typeof parsed.options.preset === "string"
			? parsed.options.preset
			: undefined;
	const scopedPreset = globalPreset
		? undefined
		: (optionPreset ?? (commandArgs[0] as string | undefined));
	if (commandArgs.length > (globalPreset ? 1 : 1))
		throw new CliUsageError(
			`unexpected positional argument: ${commandArgs[1]}`,
		);
	const options = parsed.options;
	const result: ParsedCliInput = {
		command: parsed.command,
		...(globalPreset ? { globalPreset } : {}),
		...(scopedPreset ? { scopedPreset } : {}),
		...(typeof options.model === "string" ? { model: options.model } : {}),
		...(typeof options.backend === "string"
			? { backend: options.backend }
			: {}),
		...(typeof options.session === "string"
			? { session: options.session }
			: {}),
		...(typeof options.cwd === "string" ? { cwd: options.cwd } : {}),
		dryRun: options.dryRun === true,
		apply: options.apply === true,
		...(typeof options.config === "string" ? { config: options.config } : {}),
		explain: options.explain === true,
		json: options.json === true,
		passthrough: split.passthrough,
		help: false,
		positionals: [],
	};
	return result;
}

function openCodeConfigPath(input: ParsedCliInput): string {
	if (input.config) return resolve(input.config);
	if (process.env.OPENCODE_CONFIG_PATH)
		return resolve(process.env.OPENCODE_CONFIG_PATH);
	return join(
		process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
		"opencode",
		"opencode.jsonc",
	);
}

function publicCapabilities(
	observations: ReturnType<typeof probeOpenCodeProviders>["observations"],
) {
	return openCodeProviderCapabilities(observations).map((entry) => ({
		id: entry.capability.capability_id,
		backend: entry.backend,
		qualification: entry.capability.qualification,
		launch: entry.launchContribution?.status,
		delivery: entry.deliveryFlow,
	}));
}

async function runOpenCodeOperation(
	input: ParsedCliInput,
	io: CliIo,
): Promise<number> {
	const probe = probeOpenCodeProviders();
	if (input.command === "opencode:setup") {
		try {
			const setup = await setupOpenCodeConfig({
				path: openCodeConfigPath(input),
				observations: probe.observations,
				apply: input.apply,
			});
			const result = {
				operation: "opencode:setup",
				setup: {
					targetPath: setup.targetPath,
					managedPath: setup.managedPath,
					sourceBytes: setup.sourceBytes,
					nextBytes: setup.nextBytes,
					changed: setup.changed,
					dryRun: setup.dryRun,
				},
				managedRegion: openCodeManagedProviderRegion(probe.observations),
				probes: probe.records,
			};
			if (input.json) output(io, stableCliJson(result));
			else {
				output(
					io,
					`${setup.dryRun ? "dry-run" : "applied"} OpenCode provider.golem (${setup.changed ? "changed" : "unchanged"})`,
				);
				output(io, JSON.stringify(result.managedRegion, null, 2));
			}
			return CLI_EXIT_CODES.ok;
		} catch {
			errorOutput(
				io,
				"adapter.opencode.config.atomic_write_failed: OpenCode configuration was not changed safely",
			);
			return CLI_EXIT_CODES.runtime;
		}
	}
	const result = {
		operation: input.command,
		probes: probe.records,
		capabilities: publicCapabilities(probe.observations),
	};
	if (input.json) output(io, stableCliJson(result));
	else {
		for (const capability of result.capabilities)
			output(
				io,
				`${capability.id}: launch ${capability.launch ?? "unavailable"}; delivery ${capability.delivery}; ${capability.qualification}`,
			);
	}
	return CLI_EXIT_CODES.ok;
}

async function launchOpenCode(
	result: Extract<LaunchResolution, { readonly ok: true }>,
	input: ParsedCliInput,
	io: CliIo,
): Promise<number | undefined> {
	if (input.command !== "opencode" || input.dryRun || input.json)
		return undefined;
	let ingress: ManagedOpenCodeIngress | undefined;
	try {
		const cwd = resolve(input.cwd ?? process.cwd());
		ingress = await startManagedOpenCodeIngress(cwd);
		const execution = await executeLaunch({
			plan: result,
			discovery: {
				commandName: "opencode",
				golemExecutable: process.argv[1] ?? process.execPath,
				compatibilityShims: [],
			},
			adapter: {
				cwd,
				...(input.model ? { argv: ["--model", input.model] } : { argv: [] }),
				environment: {
					values: {
						GOLEM_RUNTIME_PROJECT_ID: ingress.projectId,
						GOLEM_RUNTIME_PROJECT_PATH: cwd,
						GOLEM_CONTROL_PLANE_URL: ingress.origin,
						GOLEM_CONTROL_PLANE_TOKEN: ingress.token,
						// There is no endpoint claim owner in a direct process. State the
						// real transport truth instead of advertising an unfenced push.
						GOLEM_OPENCODE_DELIVERY_MODE: "pull_only",
					},
				},
			},
			resolveSecret: (reference) => process.env[reference],
			interactive: io.isTTY ?? Boolean(process.stdin.isTTY),
			isTTY: io.isTTY ?? Boolean(process.stdin.isTTY),
		});
		if (execution.kind === "dry_run") return CLI_EXIT_CODES.ok;
		const removeSignalForwarding = execution.running.installSignalForwarding();
		try {
			const exited = await execution.running.wait();
			const exitCode = exited.code ?? CLI_EXIT_CODES.runtime;
			if (exitCode === CLI_EXIT_CODES.ok)
				recordRecentPreset(result.preset.name);
			return exitCode;
		} finally {
			removeSignalForwarding();
		}
	} catch (error) {
		const code =
			error instanceof LauncherExecutionError ||
			error instanceof OpenCodeControlPlaneError
				? error.code
				: "launcher.process.failed";
		errorOutput(io, `${code}: OpenCode was not launched`);
		return CLI_EXIT_CODES.runtime;
	} finally {
		if (ingress) await ingress.stop();
	}
}

/**
 * The CLI never opens a runtime/tracker database. The managed host is a
 * foreground control-plane composition process, so the Codex adapter receives
 * the same durable endpoint and delivery ports as every other producer.
 */
async function launchManagedCodex(
	result: Extract<LaunchResolution, { readonly ok: true }>,
	input: ParsedCliInput,
	io: CliIo,
): Promise<number | undefined> {
	if (input.command !== "codex" || input.dryRun || input.json) return undefined;
	const host = controlPlaneArtifact(
		"../../../apps/control-plane/dist/managed-codex-host.js",
	);
	if (!host) {
		errorOutput(
			io,
			"adapter.codex.managed.host_unavailable: managed Codex was not launched",
		);
		return CLI_EXIT_CODES.runtime;
	}
	const cwd = resolve(input.cwd ?? process.cwd());
	const child = spawn(process.execPath, [host], {
		cwd,
		stdio: "inherit",
		env: {
			...process.env,
			GOLEM_HOME: process.env.GOLEM_HOME ?? join(homedir(), ".golem"),
			GOLEM_MANAGED_CODEX_CWD: cwd,
			GOLEM_MANAGED_CODEX_BACKEND: input.backend ?? "openai",
			GOLEM_MANAGED_CODEX_MODEL: input.model ?? "gpt-4o",
			...(input.session ? { GOLEM_MANAGED_CODEX_SESSION: input.session } : {}),
			...(process.env.GOLEM_CODEX_COMMAND
				? { GOLEM_MANAGED_CODEX_COMMAND: process.env.GOLEM_CODEX_COMMAND }
				: {}),
		},
	});
	const exited = await new Promise<{ readonly code: number | null }>(
		(resolveExit) => {
			child.once("error", () => resolveExit({ code: CLI_EXIT_CODES.runtime }));
			child.once("exit", (code) => resolveExit({ code }));
		},
	);
	const exitCode = exited.code ?? CLI_EXIT_CODES.runtime;
	if (exitCode === CLI_EXIT_CODES.ok) recordRecentPreset(result.preset.name);
	return exitCode;
}

function renderFailure(
	result: Extract<LaunchResolution, { readonly ok: false }>,
	input: ParsedCliInput,
	io: CliIo,
): number {
	if (input.json) output(io, stableCliJson(result));
	else {
		errorOutput(io, `${result.error.code}: ${result.error.message}`);
		for (const remedy of result.error.remediation)
			errorOutput(io, `remedy: ${remedy}`);
	}
	return result.error.code.includes("unqualified") ||
		result.error.code.includes("registration") ||
		result.error.code.includes("stale")
		? CLI_EXIT_CODES.unqualified
		: CLI_EXIT_CODES.resolution;
}

function renderSuccess(
	result: Extract<LaunchResolution, { readonly ok: true }>,
	input: ParsedCliInput,
	io: CliIo,
): number {
	// The immutable bridge is the sole public source for launchability and
	// delivery truth. Keep JSON, explain, and human output on that projection
	// instead of deriving eligibility or advertising push from adapter details.
	const bridge: LaunchPlanBridge = launchPlanBridge(result);
	const publicPlan = {
		...result,
		launch: bridge.launch,
		delivery: bridge.delivery,
	};
	if (input.json) {
		output(io, stableCliJson(publicPlan));
		return CLI_EXIT_CODES.ok;
	}
	output(
		io,
		`selected ${conciseSelection(result)}; launch ${bridge.launch.status}; delivery ${bridge.delivery.mode}/${bridge.delivery.qualification}/${bridge.delivery.readiness}`,
	);
	if (result.warnings[0])
		output(
			io,
			`warning: ${result.warnings[0].message} Remedy: ${result.warnings[0].remediation}`,
		);
	if (input.explain) {
		for (const trace of result.trace)
			output(io, `${trace.code}: ${trace.detail}`);
	}
	return CLI_EXIT_CODES.ok;
}

async function runPicker(io: CliIo): Promise<number> {
	const documents = launcherDocuments();
	const entries = pickerCandidates({
		now: io.now ?? new Date().toISOString(),
		...(documents.user ? { user: documents.user } : {}),
		...(documents.project ? { project: documents.project } : {}),
	});
	const chosen = await choosePreset(entries, {
		stdout: (line) => output(io, line),
		...(io.readLine ? { readLine: io.readLine } : {}),
	});
	if (!chosen) return CLI_EXIT_CODES.ok;
	return runCli([chosen.harness, chosen.name], io);
}

function launcherDocuments(): {
	readonly user?: ReturnType<typeof parseJsoncConfig>;
	readonly project?: ReturnType<typeof parseJsoncConfig>;
} {
	const userPath =
		process.env.GOLEM_LAUNCHER_CONFIG ??
		(process.env.GOLEM_HOME
			? join(process.env.GOLEM_HOME, "launcher.jsonc")
			: undefined);
	const projectRoot = process.env.GOLEM_PROJECT_ROOT ?? process.cwd();
	const projectPath = join(projectRoot, ".golem", "launcher.jsonc");
	const read = (file: string | undefined, scope: "user" | "project") => {
		if (!file || !existsSync(file)) return undefined;
		try {
			return parseJsoncConfig(readFileSync(file, "utf8"), scope);
		} catch (error) {
			if (error instanceof LauncherResolutionError)
				throw new CliResolutionError(
					error.issue.code,
					error.issue.message,
					error.issue.remediation,
				);
			throw error;
		}
	};
	const user = read(userPath, "user");
	const project = read(
		existsSync(projectPath) ? projectPath : undefined,
		"project",
	);
	return {
		...(user ? { user } : {}),
		...(project ? { project } : {}),
	};
}

function resolveForInput(input: ParsedCliInput, io: CliIo): LaunchResolution {
	const command = input.command;
	if (!harnesses.has(command as Harness) && command !== "global-preset")
		throw new CliUsageError(
			`command ${command} is a compatibility command; invoke it through the root golem entrypoint`,
		);
	const harness =
		command === "global-preset" ? undefined : (command as Harness);
	const explicit = {
		...(harness ? { harness } : {}),
		...(input.backend ? { backend: input.backend as never } : {}),
		...(input.model ? { modelSelector: input.model } : {}),
	};
	if (input.backend && !backends.has(input.backend)) {
		return {
			schemaVersion: "golem.launch-plan/v1",
			ok: false,
			error: {
				code: "launcher.selection.invalid",
				severity: "error",
				message: "Harness, mode, or backend is not supported.",
				remediation: [
					"Use a configured harness/backend preset or explicit supported value.",
				],
			},
			trace: [],
		};
	}
	const documents = launcherDocuments();
	return resolveLaunch({
		...(harness ? { harness } : {}),
		...(input.scopedPreset ? { preset: input.scopedPreset } : {}),
		...(input.globalPreset ? { globalPreset: input.globalPreset } : {}),
		explicit,
		passthrough: input.passthrough,
		...(documents.user ? { user: documents.user } : {}),
		...(documents.project ? { project: documents.project } : {}),
		isTTY: io.isTTY ?? Boolean(process.stdin.isTTY),
		now: io.now ?? new Date().toISOString(),
	});
}

export async function runCli(
	argv: readonly string[] = process.argv.slice(2),
	io: CliIo = {},
): Promise<number> {
	if (argv.includes("--json-schema")) {
		output(
			io,
			stableCliJson({
				schemaVersion: "golem.cli-registry/v1",
				commands: commandMetadata(),
			}),
		);
		return CLI_EXIT_CODES.ok;
	}
	if (argv.length === 0) {
		if (!(io.isTTY ?? Boolean(process.stdin.isTTY))) {
			return runCli(["help"], io);
		}
		try {
			return await runPicker(io);
		} catch (error) {
			const message = error instanceof Error ? error.message : "picker failed";
			errorOutput(io, `launcher.picker.unavailable: ${message}`);
			return CLI_EXIT_CODES.runtime;
		}
	}
	let input: ParsedCliInput;
	try {
		input = parseCliInput(argv);
	} catch (error) {
		const message = error instanceof Error ? error.message : "invalid command";
		errorOutput(io, `cli.usage: ${message}`);
		return CLI_EXIT_CODES.usage;
	}
	if (input.help || input.command === "help") {
		const program = createProgram();
		const command = program.commands.find(
			(entry) => entry.name() === input.command,
		);
		const help =
			command && input.command !== "help"
				? command.helpInformation()
				: program.helpInformation();
		output(
			io,
			`${help}\nUsage: golem codex [--session <canonical-id>] [--cwd <dir>]\n` +
				"With no flags it uses the current directory and creates one canonical tracker session.\n" +
				"The installed `golem codex` command opens the interactive Codex TUI through Golem's private supervisor bridge.\n",
		);
		return CLI_EXIT_CODES.ok;
	}
	if (input.cwd === "") {
		errorOutput(io, "cli.usage: --cwd requires a non-empty path");
		return CLI_EXIT_CODES.usage;
	}
	if (input.session !== undefined && !input.session.trim()) {
		errorOutput(io, "cli.usage: --session requires a non-empty canonical id");
		return CLI_EXIT_CODES.usage;
	}
	if (input.command === "codex" && input.passthrough.length > 0) {
		errorOutput(
			io,
			"cli.usage: managed codex does not accept native passthrough arguments; use `golem codex --legacy -- …` explicitly",
		);
		return CLI_EXIT_CODES.usage;
	}
	try {
		if (input.command === "presets")
			return await runPresets(
				{
					positionals: input.positionals,
					...(input.scope ? { scope: input.scope } : {}),
					...(input.backend ? { backend: input.backend } : {}),
					...(input.model ? { model: input.model } : {}),
					...(input.delivery ? { delivery: input.delivery } : {}),
					apply: input.apply,
					json: input.json,
					now: io.now ?? new Date().toISOString(),
				},
				{
					stdout: (line) => output(io, line),
					stderr: (line) => errorOutput(io, line),
				},
			);
		if (input.command === "completions")
			return await runCompletions(
				{
					positionals: input.positionals,
					...(input.shell ? { shell: input.shell } : {}),
					apply: input.apply,
					json: input.json,
				},
				{
					stdout: (line) => output(io, line),
					stderr: (line) => errorOutput(io, line),
				},
				commandRegistry,
			);
		if (input.command === "aliases")
			return await runAliases(
				{
					positionals: input.positionals,
					...(input.shell ? { shell: input.shell } : {}),
					...(input.name ? { name: input.name } : {}),
					apply: input.apply,
					json: input.json,
				},
				{
					stdout: (line) => output(io, line),
					stderr: (line) => errorOutput(io, line),
				},
			);
		if (
			input.command === "opencode:setup" ||
			input.command === "opencode:refresh" ||
			input.command === "opencode:doctor"
		)
			return await runOpenCodeOperation(input, io);
		// This closed predicate is deliberately evaluated before resolver or host
		// construction. The fallback is direct Codex, never a local/OSS process
		// hidden behind a managed endpoint claim.
		if (
			input.command === "codex" &&
			((input.backend !== undefined && input.backend !== "openai") ||
				(input.model !== undefined &&
					!/^gpt(?:-|$)/iu.test(input.model.trim())))
		)
			return renderFailure(
				{
					schemaVersion: "golem.launch-plan/v1",
					ok: false,
					error: {
						code: "adapter.codex.managed.qualification_required",
						severity: "error",
						message: "Managed Codex requires a qualified OpenAI/GPT model.",
						remediation: [
							"Use direct Codex for local/OSS models, or select a qualified OpenAI/GPT managed preset.",
						],
					},
					trace: [],
				},
				input,
				io,
			);
		const result = resolveForInput(input, io);
		if (!result.ok) {
			// Managed Codex has a deliberately closed backend/model gate. Keep the
			// resolver's generic capability diagnostics private to the launcher and
			// expose one stable direct-Codex remedy before any process can spawn.
			if (
				input.command === "codex" &&
				((input.backend !== undefined && input.backend !== "openai") ||
					(input.model !== undefined &&
						!/^gpt(?:-|$)/iu.test(input.model.trim())))
			) {
				return renderFailure(
					{
						schemaVersion: "golem.launch-plan/v1",
						ok: false,
						error: {
							code: "adapter.codex.managed.qualification_required",
							severity: "error",
							message: "Managed Codex requires a qualified OpenAI/GPT model.",
							remediation: [
								"Use direct Codex for local/OSS models, or select a qualified OpenAI/GPT managed preset.",
							],
						},
						trace: result.trace,
					},
					input,
					io,
				);
			}
			return renderFailure(result, input, io);
		}
		const bridge = launchPlanBridge(result);
		// A canonical launchable plan is a valid foundation result even when its
		// delivery fact is pull-only/not-ready. Only an actually unavailable
		// contribution uses the legacy pre-spawn qualification failure.
		if (
			!input.dryRun &&
			input.command !== "codex" &&
			bridge.launch.status !== "launchable"
		) {
			return renderFailure(
				{
					schemaVersion: "golem.launch-plan/v1",
					ok: false,
					error: {
						code: "launcher.adapter.unqualified",
						severity: "error",
						message:
							"This adapter is resolution-only until its real process qualification journey passes.",
						remediation: [
							"Use --dry-run or run the adapter qualification journey before spawning.",
						],
					},
					trace: result.trace,
				},
				input,
				io,
			);
		}
		const launched = await launchManagedCodex(result, input, io);
		if (launched !== undefined) return launched;
		const openCodeLaunched = await launchOpenCode(result, input, io);
		return openCodeLaunched ?? renderSuccess(result, input, io);
	} catch (error) {
		if (error instanceof CliResolutionError) {
			errorOutput(io, `${error.code}: ${error.message}`);
			for (const remedy of error.remediation)
				errorOutput(io, `remedy: ${remedy}`);
			return error.exitCode;
		}
		if (error instanceof CliUsageError) {
			errorOutput(io, `cli.usage: ${error.message}`);
			return error.exitCode;
		}
		throw error;
	}
}

export const cliBoundary = Object.freeze({
	parse: parseCliInput,
	run: runCli,
	registry: commandMetadata,
});
