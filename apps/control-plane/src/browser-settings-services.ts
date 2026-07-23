import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
	type OpenCodeProvider,
	type OpenCodeProviderObservation,
	setupOpenCodeConfig,
} from "@golem/adapter-opencode";
import { inspectRender, type RenderTarget } from "@golem/compiler";
import {
	type BrowserSettingsCommandRequest,
	type BrowserSettingsCommandResponse,
	BrowserSettingsCommandResponseSchema,
	type BrowserSettingsCommandResult,
	BrowserSettingsCommandResultSchema,
	type BrowserSettingsSnapshot,
	BrowserSettingsSnapshotSchema,
	LauncherPresetBodySchema,
} from "@golem/contracts";
import {
	builtInPresets,
	type ConfigTextPort,
	type JsoncConfigDocument,
	type LaunchPreset,
	listLauncher,
	parseJsoncConfig,
	planConfigWrite,
	resolveLaunch,
	stableLaunchPlanJson,
	writeJsoncConfig,
} from "@golem/launcher";
import type { RuntimeProjectionStorage } from "@golem/persistence";
import { z } from "zod";

import {
	installLaunchAgent,
	type LaunchAgentDefinition,
	type LaunchAgentInstall,
	type LaunchctlBoundary,
	rollbackLaunchAgent,
	startLaunchAgent,
	statusLaunchAgent,
	stopLaunchAgent,
	updateLaunchAgent,
} from "./launch-agent.js";

const renderTargets = [
	"cc",
	"cc-marketplace",
	"codex",
	"opencode",
	"pi",
] as const satisfies readonly RenderTarget[];
const providers = [
	"openai",
	"ollama_cloud",
	"ollama_local",
] as const satisfies readonly OpenCodeProvider[];
const migrationActionSchema = z
	.object({
		id: z.string().min(1).max(512),
		kind: z.enum([
			"create",
			"attach",
			"review",
			"quarantine",
			"ignore",
			"retire",
		]),
	})
	.passthrough();
const migrationPlanOutputSchema = z
	.object({
		schema_version: z.literal("golem.compat-migration-plan/v1"),
		plan_hash: z.string().regex(/^[a-f0-9]{64}$/u),
		actions: z.array(migrationActionSchema).max(10_000),
	})
	.passthrough();
const migrationStatusOutputSchema = z
	.object({
		schema_version: z.literal("golem.compat-migration-status/v1"),
		status: z.enum(["applied", "rolled_back", "failed"]),
		plan_hash: z.string().regex(/^[a-f0-9]{64}$/u),
	})
	.passthrough()
	.nullable();

type SettingsErrorCode =
	| "browser.settings.invalid"
	| "browser.settings.conflict"
	| "browser.settings.unavailable"
	| "command.idempotency_mismatch";

export class BrowserSettingsServiceError extends Error {
	readonly code: SettingsErrorCode;
	readonly httpStatus: 400 | 409 | 503;

	constructor(code: SettingsErrorCode, httpStatus: 400 | 409 | 503) {
		super(code);
		this.name = "BrowserSettingsServiceError";
		this.code = code;
		this.httpStatus = httpStatus;
	}
}

interface StoredReceipt {
	readonly key_digest: string;
	readonly fingerprint: string;
	readonly command_id: string;
	readonly command_kind: BrowserSettingsCommandRequest["kind"];
	readonly status: "pending" | "completed" | "rejected" | "failed";
	readonly created_at: string;
	readonly completed_at?: string;
	readonly result?: BrowserSettingsCommandResult;
	readonly error_code?: SettingsErrorCode;
}

interface StoredSettingsState {
	readonly schema_version: "golem.browser-settings-state/v1";
	revision: number;
	receipts: StoredReceipt[];
}

interface RenderFacts {
	readonly target: RenderTarget;
	readonly status: "clean" | "drift" | "tamper" | "missing" | "error";
	readonly version?: string;
	readonly managedFiles: readonly string[];
	readonly manifestHash?: string;
	readonly actualHashes: readonly string[];
	readonly rollbackAvailable: boolean;
}

interface ManagedRenderLock {
	readonly target: RenderTarget;
	readonly version: string;
	readonly manifestHash: string;
	readonly files: readonly {
		readonly outputPath: string;
		readonly expectedHash: string;
		readonly beginMarker?: string;
		readonly endMarker?: string;
	}[];
}

interface SettingsServiceControl {
	readonly directory: string;
	readonly definition: LaunchAgentDefinition;
	readonly uid: number;
	readonly runner?: LaunchctlBoundary;
	readonly credentialPath?: string;
	readonly credential?: string;
}

export interface BrowserSettingsServicesOptions {
	readonly home: string;
	readonly runtimeProjection: RuntimeProjectionStorage;
	readonly cliEntry: string;
	readonly migrationEntry?: string;
	readonly launcherConfigPath?: string;
	readonly openCodeConfigPath: string;
	readonly service?: SettingsServiceControl;
	readonly environment?: NodeJS.ProcessEnv;
	readonly now?: () => string;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonical(child)]),
		);
	}
	return value;
}

function digest(value: unknown): string {
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(canonical(value)))
		.digest("hex");
}

function planHash(value: unknown): `sha256:${string}` {
	return `sha256:${digest(value)}`;
}

function isCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}

function readText(target: string): string | undefined {
	try {
		return fs.readFileSync(target, "utf8");
	} catch (error) {
		if (isCode(error, "ENOENT")) return undefined;
		throw error;
	}
}

function atomicWriteText(target: string, contents: string, mode = 0o600): void {
	fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	const temporary = path.join(
		path.dirname(target),
		`.${path.basename(target)}.${crypto.randomUUID()}.tmp`,
	);
	try {
		fs.writeFileSync(temporary, contents, { encoding: "utf8", mode });
		fs.renameSync(temporary, target);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

function atomicWriteJson(target: string, value: unknown): void {
	atomicWriteText(target, `${JSON.stringify(value, null, 2)}\n`);
}

function configPort(): ConfigTextPort {
	return {
		readText: async (target) => readText(target),
		writeBackup: async (target, text) => atomicWriteText(target, text),
		writeTemporary: async (target, text) => atomicWriteText(target, text),
		commitTemporary: async (temporary, target) => {
			fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
			fs.renameSync(temporary, target);
		},
		rollback: async (target, backup) => {
			const contents = readText(backup);
			if (contents === undefined)
				throw new Error("settings backup unavailable");
			atomicWriteText(target, contents);
		},
		removeTemporary: async (target) => {
			fs.rmSync(target, { force: true });
		},
	};
}

function safeText(value: string, maximum = 512): string {
	return (
		value
			.replace(
				/\b(prompt|cookie|csrf|bearer|fence|token|secret|password|credential)\s*[:=][^\r\n]*/giu,
				"$1: [REDACTED]",
			)
			.replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, "Bearer [REDACTED]")
			.replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY))=\S+/gu, "$1=[REDACTED]")
			.replace(/(?:^|\s)(?:~\/|\/)[^\s]+/gu, " [REDACTED_PATH]")
			.trim()
			.slice(0, maximum) || "No action is required."
	);
}

function hasExecutable(name: string, environment: NodeJS.ProcessEnv): boolean {
	const result = spawnSync("/usr/bin/env", ["which", name], {
		env: environment,
		stdio: "ignore",
		timeout: 5_000,
	});
	return result.status === 0;
}

function safeRelativePath(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 256 &&
		!path.isAbsolute(value) &&
		value !== ".." &&
		!value.startsWith(`..${path.sep}`) &&
		!value.split(path.sep).includes("..")
	);
}

function fileDigest(target: string): string | undefined {
	try {
		return crypto
			.createHash("sha256")
			.update(fs.readFileSync(target))
			.digest("hex");
	} catch (error) {
		if (isCode(error, "ENOENT")) return undefined;
		throw error;
	}
}

function managedFileDigest(
	target: string,
	file: ManagedRenderLock["files"][number],
): string | undefined {
	if (!file.beginMarker || !file.endMarker) return fileDigest(target);
	try {
		const text = fs.readFileSync(target, "utf8");
		if (
			text.split(file.beginMarker).length !== 2 ||
			text.split(file.endMarker).length !== 2
		)
			return undefined;
		const start = text.indexOf(file.beginMarker) + file.beginMarker.length;
		const contentStart = text.startsWith("\r\n", start)
			? start + 2
			: text.startsWith("\n", start)
				? start + 1
				: start;
		const end = text.indexOf(file.endMarker, contentStart);
		if (end < contentStart) return undefined;
		return crypto
			.createHash("sha256")
			.update(text.slice(contentStart, end))
			.digest("hex");
	} catch (error) {
		if (isCode(error, "ENOENT")) return undefined;
		throw error;
	}
}

function storedState(value: unknown): StoredSettingsState | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const row = value as Record<string, unknown>;
	if (
		row.schema_version !== "golem.browser-settings-state/v1" ||
		!Number.isInteger(row.revision) ||
		(row.revision as number) < 0 ||
		!Array.isArray(row.receipts)
	)
		return undefined;
	const receipts: StoredReceipt[] = [];
	for (const candidate of row.receipts.slice(-200)) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
			return undefined;
		const receipt = candidate as Record<string, unknown>;
		if (
			typeof receipt.key_digest !== "string" ||
			typeof receipt.fingerprint !== "string" ||
			typeof receipt.command_id !== "string" ||
			typeof receipt.command_kind !== "string" ||
			!["pending", "completed", "rejected", "failed"].includes(
				String(receipt.status),
			) ||
			typeof receipt.created_at !== "string"
		)
			return undefined;
		const parsedResult =
			receipt.result === undefined
				? undefined
				: BrowserSettingsCommandResultSchema.safeParse(receipt.result);
		if (parsedResult && !parsedResult.success) return undefined;
		receipts.push({
			key_digest: receipt.key_digest,
			fingerprint: receipt.fingerprint,
			command_id: receipt.command_id,
			command_kind:
				receipt.command_kind as BrowserSettingsCommandRequest["kind"],
			status: receipt.status as StoredReceipt["status"],
			created_at: receipt.created_at,
			...(typeof receipt.completed_at === "string"
				? { completed_at: receipt.completed_at }
				: {}),
			...(parsedResult?.success ? { result: parsedResult.data } : {}),
			...(typeof receipt.error_code === "string"
				? { error_code: receipt.error_code as SettingsErrorCode }
				: {}),
		});
	}
	return {
		schema_version: "golem.browser-settings-state/v1",
		revision: row.revision as number,
		receipts,
	};
}

function commandFingerprint(input: BrowserSettingsCommandRequest): string {
	const { idempotency_key: _idempotencyKey, ...safeInput } = input;
	return digest(safeInput);
}

function keyDigest(key: string): string {
	return digest({ idempotency_key: key });
}

function endpointDelivery(
	endpoints: ReturnType<RuntimeProjectionStorage["endpoints"]>,
): "ready" | "held" | "pull_only" | "next_turn" | "unavailable" {
	if (
		endpoints.some(
			(endpoint) =>
				endpoint.state === "healthy" &&
				endpoint.controlState === "enabled" &&
				endpoint.consumerReady &&
				endpoint.consumptionObserved &&
				endpoint.deliveryObserved &&
				!endpoint.deliveryFailed,
		)
	)
		return "ready";
	if (endpoints.some((endpoint) => endpoint.controlState === "held"))
		return "held";
	if (endpoints.some((endpoint) => endpoint.deliveryMode === "next_turn"))
		return "next_turn";
	if (endpoints.some((endpoint) => endpoint.deliveryMode === "pull"))
		return "pull_only";
	return "unavailable";
}

function providerCapabilityId(provider: OpenCodeProvider): string {
	return `opencode.${
		provider === "ollama_local"
			? "ollama-local"
			: provider === "ollama_cloud"
				? "ollama-cloud"
				: "openai"
	}.direct`;
}

export interface BrowserSettingsServices {
	snapshot(): Promise<BrowserSettingsSnapshot>;
	command(
		input: BrowserSettingsCommandRequest,
	): Promise<BrowserSettingsCommandResponse>;
}

class BrowserSettingsServicesImpl implements BrowserSettingsServices {
	readonly #options: BrowserSettingsServicesOptions;
	readonly #statePath: string;
	readonly #backupRoot: string;
	readonly #launcherConfigPath: string;
	readonly #migrationEntry: string;
	readonly #environment: NodeJS.ProcessEnv;
	readonly #now: () => string;
	readonly #inFlight = new Map<
		string,
		Promise<BrowserSettingsCommandResponse>
	>();
	#state: StoredSettingsState;

	constructor(options: BrowserSettingsServicesOptions) {
		this.#options = options;
		this.#statePath = path.join(
			options.home,
			"control-plane",
			"settings-command-receipts.json",
		);
		this.#backupRoot = path.join(
			options.home,
			"control-plane",
			"settings-backups",
		);
		this.#launcherConfigPath =
			options.launcherConfigPath ?? path.join(options.home, "launcher.jsonc");
		this.#migrationEntry =
			options.migrationEntry ??
			path.resolve(
				path.dirname(options.cliEntry),
				"../packages/compat/bin/migration-plan.mjs",
			);
		this.#environment = options.environment ?? process.env;
		this.#now = options.now ?? (() => new Date().toISOString());
		const persisted = readText(this.#statePath);
		if (persisted === undefined) {
			this.#state = {
				schema_version: "golem.browser-settings-state/v1",
				revision: 0,
				receipts: [],
			};
		} else {
			try {
				const parsed = storedState(JSON.parse(persisted));
				if (!parsed) throw new Error("invalid settings receipt store");
				this.#state = parsed;
			} catch {
				throw new BrowserSettingsServiceError(
					"browser.settings.unavailable",
					503,
				);
			}
		}
	}

	#persist(): void {
		this.#state.receipts = this.#state.receipts.slice(-200);
		atomicWriteJson(this.#statePath, this.#state);
	}

	#renderDirectory(target: RenderTarget): string {
		return path.join(
			this.#options.home,
			"renders",
			target === "cc" ? "cc-plugin" : target,
		);
	}

	#renderBackup(target: RenderTarget): string {
		return path.join(this.#backupRoot, `render-${target}`);
	}

	#renderLockBackup(target: RenderTarget): string {
		return path.join(this.#backupRoot, `render-${target}.legacy-lock.json`);
	}

	#legacyRenderLock(
		target: RenderTarget,
		directory: string,
	): ManagedRenderLock | undefined {
		const source = readText(path.join(this.#options.home, "substrate.lock"));
		if (source === undefined) return undefined;
		let root: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(source);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				return undefined;
			root = parsed as Record<string, unknown>;
		} catch {
			return undefined;
		}
		const targets = root.targets;
		if (!targets || typeof targets !== "object" || Array.isArray(targets))
			return undefined;
		const key = `${target}::${directory}`;
		const value = (targets as Record<string, unknown>)[key];
		if (!value || typeof value !== "object" || Array.isArray(value))
			return undefined;
		const entry = value as Record<string, unknown>;
		if (entry.target !== target || entry.out_dir !== directory)
			return undefined;
		const rows = entry.files;
		if (!rows || typeof rows !== "object" || Array.isArray(rows))
			return undefined;
		const files: ManagedRenderLock["files"][number][] = [];
		for (const row of Object.values(rows as Record<string, unknown>).slice(
			0,
			500,
		)) {
			if (!row || typeof row !== "object" || Array.isArray(row))
				return undefined;
			const file = row as Record<string, unknown>;
			if (
				typeof file.output_path !== "string" ||
				typeof file.output_sha256 !== "string" ||
				!/^[a-f0-9]{64}$/u.test(file.output_sha256)
			)
				return undefined;
			files.push({
				outputPath: file.output_path,
				expectedHash: file.output_sha256,
				...(file.kind === "block" &&
				typeof file.begin_marker === "string" &&
				typeof file.end_marker === "string"
					? {
							beginMarker: file.begin_marker,
							endMarker: file.end_marker,
						}
					: {}),
			});
		}
		return {
			target,
			version:
				typeof root.package_version === "string"
					? root.package_version
					: "legacy-lock-v1",
			manifestHash: digest({ target, files }),
			files,
		};
	}

	#runSync(target: RenderTarget, apply: boolean): number | undefined {
		const result = spawnSync(
			process.execPath,
			[
				this.#options.cliEntry,
				"sync",
				...(apply ? [] : ["--check"]),
				"--target",
				target,
			],
			{
				cwd: path.dirname(path.dirname(this.#options.cliEntry)),
				env: {
					...this.#environment,
					GOLEM_HOME: this.#options.home,
				},
				stdio: "ignore",
				timeout: 120_000,
			},
		);
		return result.status ?? undefined;
	}

	#renderFacts(target: RenderTarget, checkSource: boolean): RenderFacts {
		const directory = this.#renderDirectory(target);
		const rollbackAvailable = fs.existsSync(this.#renderBackup(target));
		let lock: ManagedRenderLock | undefined;
		try {
			const typed = inspectRender(directory);
			lock = typed
				? {
						target: typed.target,
						version: typed.version,
						manifestHash: typed.manifestSha256,
						files: typed.files.map((file) => ({
							outputPath: file.outputPath,
							expectedHash: file.sha256,
						})),
					}
				: this.#legacyRenderLock(target, directory);
		} catch {
			return {
				target,
				status: "error",
				managedFiles: [],
				actualHashes: [],
				rollbackAvailable,
			};
		}
		if (!lock)
			return {
				target,
				status: "missing",
				managedFiles: [],
				actualHashes: [],
				rollbackAvailable,
			};
		const files = lock.files.map((file) => file.outputPath);
		if (lock.target !== target || files.some((file) => !safeRelativePath(file)))
			return {
				target,
				status: "error",
				version: lock.version,
				managedFiles: [],
				manifestHash: lock.manifestHash,
				actualHashes: [],
				rollbackAvailable,
			};
		const actualHashes = lock.files.map(
			(file) =>
				managedFileDigest(path.join(directory, file.outputPath), file) ??
				"missing",
		);
		const tamper = lock.files.some(
			(file, index) => actualHashes[index] !== file.expectedHash,
		);
		let status: RenderFacts["status"] = tamper ? "tamper" : "clean";
		if (checkSource && status === "clean") {
			const exit = this.#runSync(target, false);
			status = exit === 0 ? "clean" : exit === 1 ? "drift" : "error";
		}
		return {
			target,
			status,
			version: lock.version,
			managedFiles: files,
			manifestHash: lock.manifestHash,
			actualHashes,
			rollbackAvailable,
		};
	}

	#renderPlan(target: RenderTarget): {
		readonly facts: RenderFacts;
		readonly hash: `sha256:${string}`;
	} {
		const facts = this.#renderFacts(target, true);
		return {
			facts,
			hash: planHash({
				kind: "render",
				target,
				status: facts.status,
				version: facts.version,
				manifest: facts.manifestHash,
				files: facts.managedFiles.map((file, index) => ({
					file,
					actual: facts.actualHashes[index],
				})),
			}),
		};
	}

	#backupRender(target: RenderTarget): boolean {
		const source = this.#renderDirectory(target);
		const backup = this.#renderBackup(target);
		const lockBackup = this.#renderLockBackup(target);
		fs.mkdirSync(this.#backupRoot, { recursive: true, mode: 0o700 });
		fs.rmSync(backup, { recursive: true, force: true });
		fs.rmSync(lockBackup, { force: true });
		if (!fs.existsSync(source)) return false;
		fs.cpSync(source, backup, {
			recursive: true,
			errorOnExist: true,
			preserveTimestamps: true,
		});
		const legacyLock = readText(
			path.join(this.#options.home, "substrate.lock"),
		);
		if (legacyLock !== undefined) {
			try {
				const root = JSON.parse(legacyLock) as {
					targets?: Record<string, unknown>;
				};
				const key = `${target}::${source}`;
				atomicWriteJson(lockBackup, {
					key,
					entry: root.targets?.[key] ?? null,
				});
			} catch {
				// A malformed legacy lock cannot become rollback authority.
			}
		}
		return true;
	}

	#restoreRender(target: RenderTarget): void {
		const source = this.#renderBackup(target);
		if (!fs.existsSync(source))
			throw new BrowserSettingsServiceError("browser.settings.conflict", 409);
		const destination = this.#renderDirectory(target);
		fs.rmSync(destination, { recursive: true, force: true });
		fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
		fs.cpSync(source, destination, {
			recursive: true,
			errorOnExist: true,
			preserveTimestamps: true,
		});
		const lockBackup = readText(this.#renderLockBackup(target));
		if (lockBackup !== undefined) {
			try {
				const stored = JSON.parse(lockBackup) as {
					key?: unknown;
					entry?: unknown;
				};
				const lockPath = path.join(this.#options.home, "substrate.lock");
				const currentText = readText(lockPath);
				const current = currentText
					? (JSON.parse(currentText) as {
							version?: number;
							targets?: Record<string, unknown>;
						})
					: { version: 1, targets: {} };
				if (typeof stored.key === "string") {
					current.targets ??= {};
					if (stored.entry === null) delete current.targets[stored.key];
					else current.targets[stored.key] = stored.entry;
					atomicWriteJson(lockPath, current);
				}
			} catch {
				throw new BrowserSettingsServiceError(
					"browser.settings.unavailable",
					503,
				);
			}
		}
	}

	#serviceStatus() {
		const service = this.#options.service;
		if (!service)
			return {
				installed: false,
				loaded: false,
				backup: false,
			};
		try {
			const status = statusLaunchAgent({
				directory: service.directory,
				label: service.definition.label,
				uid: service.uid,
				...(service.runner ? { runner: service.runner } : {}),
			});
			const target = path.join(
				service.directory,
				`${service.definition.label}.plist`,
			);
			return {
				installed: status.installed,
				loaded: status.loaded,
				backup: fs.existsSync(`${target}.previous`),
			};
		} catch {
			return {
				installed: fs.existsSync(
					path.join(service.directory, `${service.definition.label}.plist`),
				),
				loaded: false,
				backup: false,
			};
		}
	}

	#servicePlan(
		action: "start" | "stop" | "restart" | "install" | "update" | "rollback",
	) {
		const status = this.#serviceStatus();
		return {
			status,
			hash: planHash({ kind: "service", action, status }),
		};
	}

	#serviceInstall(): LaunchAgentInstall {
		const service = this.#options.service;
		if (!service)
			throw new BrowserSettingsServiceError(
				"browser.settings.unavailable",
				503,
			);
		const target = path.join(
			service.directory,
			`${service.definition.label}.plist`,
		);
		return {
			path: target,
			...(fs.existsSync(`${target}.previous`)
				? { backupPath: `${target}.previous` }
				: {}),
		};
	}

	#ensureServiceCredential(): void {
		const service = this.#options.service;
		if (!service?.credentialPath) return;
		if (service.credential) {
			atomicWriteText(service.credentialPath, `${service.credential}\n`);
			return;
		}
		if (!fs.existsSync(service.credentialPath))
			throw new BrowserSettingsServiceError(
				"browser.settings.unavailable",
				503,
			);
	}

	#runServiceAction(
		action: "start" | "stop" | "restart" | "install" | "update" | "rollback",
	): void {
		const service = this.#options.service;
		if (!service)
			throw new BrowserSettingsServiceError(
				"browser.settings.unavailable",
				503,
			);
		const commandOptions = {
			uid: service.uid,
			...(service.runner ? { runner: service.runner } : {}),
		};
		if (action === "install" || action === "update")
			this.#ensureServiceCredential();
		switch (action) {
			case "install":
				installLaunchAgent(
					service.directory,
					service.definition,
					commandOptions,
				);
				return;
			case "update":
				updateLaunchAgent(
					service.directory,
					service.definition,
					commandOptions,
				);
				return;
			case "rollback":
				rollbackLaunchAgent(this.#serviceInstall(), commandOptions);
				return;
			case "start": {
				const result = startLaunchAgent({
					label: service.definition.label,
					...commandOptions,
				});
				if (result.status !== 0)
					throw new BrowserSettingsServiceError(
						"browser.settings.unavailable",
						503,
					);
				return;
			}
			case "stop": {
				const result = stopLaunchAgent({
					label: service.definition.label,
					...commandOptions,
				});
				if (result.status !== 0)
					throw new BrowserSettingsServiceError(
						"browser.settings.unavailable",
						503,
					);
				return;
			}
			case "restart": {
				const stopped = stopLaunchAgent({
					label: service.definition.label,
					...commandOptions,
				});
				if (stopped.status !== 0)
					throw new BrowserSettingsServiceError(
						"browser.settings.unavailable",
						503,
					);
				const started = startLaunchAgent({
					label: service.definition.label,
					...commandOptions,
				});
				if (started.status !== 0)
					throw new BrowserSettingsServiceError(
						"browser.settings.unavailable",
						503,
					);
			}
		}
	}

	#providerObservation(
		provider: OpenCodeProvider,
	): OpenCodeProviderObservation {
		const endpoints = this.#options.runtimeProjection.endpoints();
		const capabilityId = providerCapabilityId(provider);
		const matches = endpoints.flatMap((endpoint) =>
			endpoint.capabilities
				.filter((capability) => capability.capability === capabilityId)
				.map((capability) => ({ endpoint, capability })),
		);
		const delivered = matches.some(
			({ endpoint }) =>
				endpoint.consumptionObserved &&
				endpoint.deliveryObserved &&
				!endpoint.deliveryFailed,
		);
		const evidence = matches
			.map(({ capability }) => capability.observedAt)
			.sort()
			.at(-1);
		const openAiCredentials = Boolean(
			this.#environment.OPENAI_API_KEY ??
				this.#environment.OPENCODE_OPENAI_API_KEY,
		);
		const cloudCredentials = Boolean(
			this.#environment.OLLAMA_API_KEY ??
				this.#environment.OLLAMA_CLOUD_API_KEY,
		);
		const localDaemon =
			Boolean(this.#environment.OLLAMA_HOST) ||
			hasExecutable("ollama", this.#environment);
		const credentials =
			provider === "openai"
				? openAiCredentials
				: provider === "ollama_cloud"
					? cloudCredentials
					: false;
		const daemon = provider === "ollama_local" && localDaemon;
		return {
			provider,
			available: credentials || daemon,
			credentials,
			daemon,
			responseObserved: delivered,
			deliveryObserved: delivered,
			evidenceSource: matches.length ? "real_journey" : "registration",
			evidencePolicy: matches.length ? "observed" : "version_qualified",
			...(evidence ? { observedAt: evidence } : {}),
		};
	}

	async #providerPlan(provider: OpenCodeProvider) {
		const source = readText(this.#options.openCodeConfigPath) ?? "{}\n";
		const setup = await setupOpenCodeConfig({
			path: this.#options.openCodeConfigPath,
			observations: providers.map((candidate) =>
				this.#providerObservation(candidate),
			),
		});
		return {
			hash: planHash({
				kind: "provider",
				provider,
				source: digest(source),
				next: digest(setup.text),
				changed: setup.changed,
			}),
			changed: setup.changed,
		};
	}

	#launcherDocument(): JsoncConfigDocument {
		const source = readText(this.#launcherConfigPath) ?? "{}\n";
		try {
			return parseJsoncConfig(source, "user");
		} catch {
			throw new BrowserSettingsServiceError("browser.settings.invalid", 400);
		}
	}

	#presetPlan(
		input: Extract<
			BrowserSettingsCommandRequest,
			{ kind: "preset.preview" | "preset.apply" }
		>["preset"],
	) {
		const document = this.#launcherDocument();
		const preset = LauncherPresetBodySchema.parse({
			...input,
			native_args: [],
			env_key_refs: [],
		}) as LaunchPreset;
		const nextConfig = {
			...document.config,
			presets: [
				...document.config.presets.filter(
					(candidate) =>
						!(
							candidate.harness === preset.harness &&
							candidate.name === preset.name
						),
				),
				preset,
			],
		};
		const nextDocument: JsoncConfigDocument = {
			...document,
			config: nextConfig,
		};
		const resolution = resolveLaunch({
			harness: preset.harness,
			preset: preset.name,
			isTTY: true,
			now: this.#now(),
			user: nextDocument,
		});
		const plan = planConfigWrite(
			this.#launcherConfigPath,
			document,
			nextConfig,
		);
		const prior = document.config.presets.find(
			(candidate) =>
				candidate.harness === preset.harness && candidate.name === preset.name,
		);
		const changed = !prior || digest(prior) !== digest(preset);
		return {
			document,
			nextConfig,
			plan,
			changed,
			hash: planHash({
				kind: "preset",
				source: digest(document.text),
				preset,
				launch_plan: digest(stableLaunchPlanJson(resolution)),
				next_bytes: plan.nextBytes,
			}),
		};
	}

	#runMigration(
		command: "plan" | "apply" | "status" | "rollback",
		planHash?: string,
	): unknown {
		const result = spawnSync(
			process.execPath,
			[
				this.#migrationEntry,
				command,
				"--home",
				this.#options.home,
				"--json",
				...(planHash ? ["--plan-hash", planHash] : []),
			],
			{
				cwd: path.dirname(this.#options.cliEntry),
				env: this.#environment,
				encoding: "utf8",
				maxBuffer: 16 * 1024 * 1024,
				timeout: 120_000,
			},
		);
		if (result.status !== 0 || result.error) {
			const diagnostic = result.stderr.trim();
			if (
				/^(migration\.(?:not_applied|plan_hash_mismatch|review_required|source_changed)):/u.test(
					diagnostic,
				)
			)
				throw new BrowserSettingsServiceError("browser.settings.conflict", 409);
			throw new BrowserSettingsServiceError(
				"browser.settings.unavailable",
				503,
			);
		}
		try {
			return JSON.parse(result.stdout);
		} catch {
			throw new BrowserSettingsServiceError(
				"browser.settings.unavailable",
				503,
			);
		}
	}

	#migrationPlanOutput(): z.infer<typeof migrationPlanOutputSchema> {
		const parsed = migrationPlanOutputSchema.safeParse(
			this.#runMigration("plan"),
		);
		if (!parsed.success)
			throw new BrowserSettingsServiceError(
				"browser.settings.unavailable",
				503,
			);
		return parsed.data;
	}

	#migrationStatusOutput(): z.infer<typeof migrationStatusOutputSchema> {
		const parsed = migrationStatusOutputSchema.safeParse(
			this.#runMigration("status"),
		);
		if (!parsed.success)
			throw new BrowserSettingsServiceError(
				"browser.settings.unavailable",
				503,
			);
		return parsed.data;
	}

	async #migrationView(): Promise<BrowserSettingsSnapshot["migration"]> {
		try {
			const plan = this.#migrationPlanOutput();
			const status = this.#migrationStatusOutput();
			const count = (kind: "create" | "attach" | "review" | "quarantine") =>
				plan.actions.filter((action) => action.kind === kind).length;
			const review = count("review");
			const quarantine = count("quarantine");
			return {
				status:
					status?.status === "applied"
						? "applied"
						: status?.status === "rolled_back"
							? "rolled_back"
							: review || quarantine
								? "review_required"
								: "ready",
				plan_hash: `sha256:${plan.plan_hash}`,
				create: count("create"),
				attach: count("attach"),
				review,
				quarantine,
				backup_available: status !== undefined,
				rollback_available: status?.status === "applied",
			};
		} catch {
			return {
				status: "failed",
				create: 0,
				attach: 0,
				review: 0,
				quarantine: 0,
				backup_available: false,
				rollback_available: false,
			};
		}
	}

	async #migrationPlan() {
		const plan = this.#migrationPlanOutput();
		return {
			plan,
			hash: `sha256:${plan.plan_hash}` as `sha256:${string}`,
			review: plan.actions.filter((action) => action.kind === "review").length,
			quarantine: plan.actions.filter((action) => action.kind === "quarantine")
				.length,
			affected: plan.actions
				.filter((action) =>
					["create", "attach", "review", "quarantine"].includes(action.kind),
				)
				.map((action) => `migration:${action.kind}:${action.id}`)
				.slice(0, 500),
		};
	}

	async snapshot(): Promise<BrowserSettingsSnapshot> {
		const document = (() => {
			try {
				return this.#launcherDocument();
			} catch {
				return undefined;
			}
		})();
		const launcher = listLauncher({
			now: this.#now(),
			...(document ? { user: document } : {}),
		});
		const endpoints = this.#options.runtimeProjection.endpoints();
		const service = this.#serviceStatus();
		const endpointByCapability = (id: string) =>
			endpoints.filter((endpoint) =>
				endpoint.capabilities.some(
					(capability) => capability.capability === id,
				),
			);
		const configuredBackend = (backend: string) => {
			if (backend === "native") return "not_applicable" as const;
			if (backend === "openai")
				return this.#environment.OPENAI_API_KEY
					? ("configured" as const)
					: ("unconfigured" as const);
			if (backend === "anthropic")
				return this.#environment.ANTHROPIC_API_KEY
					? ("configured" as const)
					: ("unconfigured" as const);
			if (backend === "ollama_cloud")
				return (this.#environment.OLLAMA_API_KEY ??
					this.#environment.OLLAMA_CLOUD_API_KEY)
					? ("configured" as const)
					: ("unconfigured" as const);
			return this.#environment.OLLAMA_HOST ||
				hasExecutable("ollama", this.#environment)
				? ("configured" as const)
				: ("unconfigured" as const);
		};
		const userPresetKeys = new Set(
			document?.config.presets.map(
				(preset) => `${preset.harness}:${preset.name}`,
			) ?? [],
		);
		const builtInPresetKeys = new Set(
			builtInPresets.map((preset) => `${preset.harness}:${preset.name}`),
		);
		const providerViews = providers.map((provider) => {
			const observation = this.#providerObservation(provider);
			const matched = endpointByCapability(providerCapabilityId(provider));
			const delivered = matched.some(
				(endpoint) =>
					endpoint.consumptionObserved &&
					endpoint.deliveryObserved &&
					!endpoint.deliveryFailed,
			);
			const qualification = delivered
				? "supported"
				: observation.available
					? "experimental"
					: "unknown";
			return {
				provider,
				configured: observation.credentials || observation.daemon,
				qualification,
				delivery_ready: delivered,
				rollback_available: fs.existsSync(
					`${this.#options.openCodeConfigPath}.golem-opencode.bak`,
				),
			};
		});
		const migration = await this.#migrationView();
		return BrowserSettingsSnapshotSchema.parse({
			schema_version: "golem.browser-settings/v1",
			revision: this.#state.revision,
			service: {
				installed: service.installed,
				process: service.loaded ? "running" : "stopped",
				api: "ready",
				delivery: endpointDelivery(endpoints),
				actions: [
					...(service.installed
						? (["start", "update"] as const)
						: (["install"] as const)),
					...(service.loaded ? (["stop", "restart"] as const) : []),
					...(service.backup ? (["rollback"] as const) : []),
				],
			},
			renders: renderTargets.map((target) => {
				const facts = this.#renderFacts(target, false);
				return {
					target,
					status: facts.status,
					...(facts.version ? { version: facts.version } : {}),
					managed_files: facts.managedFiles,
					rollback_available: facts.rollbackAvailable,
				};
			}),
			capabilities: launcher.capabilities.map((capability) => {
				const matched = endpointByCapability(capability.id);
				const healthy = matched.some(
					(endpoint) =>
						endpoint.state === "healthy" &&
						endpoint.controlState !== "disabled",
				);
				const degraded = matched.some(
					(endpoint) =>
						endpoint.state === "degraded" || endpoint.deliveryFailed,
				);
				const delivered = matched.some(
					(endpoint) =>
						endpoint.consumptionObserved &&
						endpoint.deliveryObserved &&
						!endpoint.deliveryFailed,
				);
				return {
					opaque_id: `cap_${digest(capability.id).slice(0, 24)}`,
					harness: capability.harness,
					backend: capability.backend,
					model_pattern: builtInCapabilitiesModelPattern(capability.id) ?? "*",
					binary: hasExecutable(
						capability.harness === "claude" ? "claude" : capability.harness,
						this.#environment,
					)
						? "available"
						: "unavailable",
					provider: configuredBackend(capability.backend),
					model:
						capability.qualification === "supported"
							? "supported"
							: capability.qualification === "experimental"
								? "experimental"
								: capability.qualification === "unsupported"
									? "unsupported"
									: "unknown",
					qualification: capability.qualification,
					endpoint: healthy ? "healthy" : degraded ? "degraded" : "absent",
					delivery:
						capability.deliveryMode === "next_turn"
							? "next_turn"
							: capability.deliveryMode === "pull"
								? "pull_only"
								: delivered
									? "ready"
									: capability.delivery.readiness === "ineligible"
										? "ineligible"
										: "not_ready",
					...(capability.evidenceVersion
						? { evidence_version: capability.evidenceVersion }
						: {}),
					...(capability.observedAt
						? { evidence_at: capability.observedAt }
						: {}),
					remedy: safeText(
						capability.delivery.remediation || capability.launch.remediation,
					),
				};
			}),
			providers: providerViews,
			presets: launcher.presets.map((preset) => {
				const key = `${preset.harness}:${preset.name}`;
				return {
					name: preset.name,
					harness: preset.harness,
					backend: preset.backend,
					model_selector: preset.modelSelector,
					source: userPresetKeys.has(key)
						? "user"
						: builtInPresetKeys.has(key)
							? "built_in"
							: "user",
				};
			}),
			migration,
			unknown_config_keys_preserved: document !== undefined,
			unknown_config_key_count: document
				? Object.keys(document.userOwned).length
				: 0,
			audit: [...this.#state.receipts]
				.reverse()
				.slice(0, 50)
				.map((receipt) => ({
					command_id: receipt.command_id,
					command_kind: receipt.command_kind,
					status: receipt.status,
					created_at: receipt.created_at,
					...(receipt.completed_at
						? { completed_at: receipt.completed_at }
						: {}),
				})),
		});
	}

	async #execute(
		input: BrowserSettingsCommandRequest,
	): Promise<BrowserSettingsCommandResult> {
		const nextRevision = this.#state.revision + 1;
		switch (input.kind) {
			case "render.preview": {
				const plan = this.#renderPlan(input.target);
				return BrowserSettingsCommandResultSchema.parse({
					command_kind: input.kind,
					outcome: "previewed",
					summary: `Render ${input.target} is ${plan.facts.status}.`,
					plan_hash: plan.hash,
					changed: plan.facts.status !== "clean",
					affected: plan.facts.managedFiles.map(
						(file) => `render:${input.target}/${file}`,
					),
					rollback_available: plan.facts.rollbackAvailable,
					snapshot_revision: nextRevision,
				});
			}
			case "render.apply": {
				const plan = this.#renderPlan(input.target);
				if (plan.hash !== input.plan_hash)
					throw new BrowserSettingsServiceError(
						"browser.settings.conflict",
						409,
					);
				if (plan.facts.status === "tamper" || plan.facts.status === "error")
					throw new BrowserSettingsServiceError(
						"browser.settings.conflict",
						409,
					);
				const backup = this.#backupRender(input.target);
				const exit = this.#runSync(input.target, true);
				if (exit !== 0) {
					if (backup) this.#restoreRender(input.target);
					throw new BrowserSettingsServiceError(
						"browser.settings.unavailable",
						503,
					);
				}
				const current = this.#renderFacts(input.target, false);
				return BrowserSettingsCommandResultSchema.parse({
					command_kind: input.kind,
					outcome: "applied",
					summary: `Render ${input.target} was compiled from canonical substrate.`,
					changed: plan.facts.status !== "clean",
					affected: current.managedFiles.map(
						(file) => `render:${input.target}/${file}`,
					),
					rollback_available: backup,
					snapshot_revision: nextRevision,
				});
			}
			case "render.rollback": {
				this.#restoreRender(input.target);
				const current = this.#renderFacts(input.target, false);
				return BrowserSettingsCommandResultSchema.parse({
					command_kind: input.kind,
					outcome: "rolled_back",
					summary: `Render ${input.target} was restored from its managed backup.`,
					changed: true,
					affected: current.managedFiles.map(
						(file) => `render:${input.target}/${file}`,
					),
					rollback_available: true,
					snapshot_revision: nextRevision,
				});
			}
			case "service.preview": {
				const plan = this.#servicePlan(input.action);
				return BrowserSettingsCommandResultSchema.parse({
					command_kind: input.kind,
					outcome: "previewed",
					summary: `Service ${input.action} is ready for explicit confirmation.`,
					plan_hash: plan.hash,
					changed: true,
					affected: ["service:control-plane"],
					rollback_available: plan.status.backup,
					snapshot_revision: nextRevision,
				});
			}
			case "service.apply": {
				const plan = this.#servicePlan(input.action);
				if (plan.hash !== input.plan_hash)
					throw new BrowserSettingsServiceError(
						"browser.settings.conflict",
						409,
					);
				this.#runServiceAction(input.action);
				return BrowserSettingsCommandResultSchema.parse({
					command_kind: input.kind,
					outcome: "applied",
					summary: `Service ${input.action} completed.`,
					changed: true,
					affected: ["service:control-plane"],
					rollback_available: this.#serviceStatus().backup,
					snapshot_revision: nextRevision,
				});
			}
			case "provider.preview": {
				const plan = await this.#providerPlan(input.provider);
				return BrowserSettingsCommandResultSchema.parse({
					command_kind: input.kind,
					outcome: "previewed",
					summary: `OpenCode ${input.provider} managed setup is ready for review.`,
					plan_hash: plan.hash,
					changed: plan.changed,
					affected: [`provider:opencode/${input.provider}`],
					rollback_available: fs.existsSync(
						`${this.#options.openCodeConfigPath}.golem-opencode.bak`,
					),
					snapshot_revision: nextRevision,
				});
			}
			case "provider.apply": {
				const plan = await this.#providerPlan(input.provider);
				if (plan.hash !== input.plan_hash)
					throw new BrowserSettingsServiceError(
						"browser.settings.conflict",
						409,
					);
				await setupOpenCodeConfig({
					path: this.#options.openCodeConfigPath,
					observations: providers.map((candidate) =>
						this.#providerObservation(candidate),
					),
					apply: true,
				});
				return BrowserSettingsCommandResultSchema.parse({
					command_kind: input.kind,
					outcome: "applied",
					summary: `OpenCode ${input.provider} managed setup was applied without replacing other providers.`,
					changed: plan.changed,
					affected: [`provider:opencode/${input.provider}`],
					rollback_available: true,
					snapshot_revision: nextRevision,
				});
			}
			case "provider.rollback": {
				const backup = `${this.#options.openCodeConfigPath}.golem-opencode.bak`;
				const source = readText(backup);
				if (source === undefined)
					throw new BrowserSettingsServiceError(
						"browser.settings.conflict",
						409,
					);
				atomicWriteText(this.#options.openCodeConfigPath, source);
				return BrowserSettingsCommandResultSchema.parse({
					command_kind: input.kind,
					outcome: "rolled_back",
					summary: "OpenCode managed provider setup was restored.",
					changed: true,
					affected: ["provider:opencode"],
					rollback_available: true,
					snapshot_revision: nextRevision,
				});
			}
			case "preset.preview": {
				const plan = this.#presetPlan(input.preset);
				return BrowserSettingsCommandResultSchema.parse({
					command_kind: input.kind,
					outcome: "previewed",
					summary: `Preset ${input.preset.name} resolves through the canonical launch plan.`,
					plan_hash: plan.hash,
					changed: plan.changed,
					affected: [`preset:${input.preset.harness}/${input.preset.name}`],
					rollback_available: fs.existsSync(plan.plan.backupPath),
					snapshot_revision: nextRevision,
				});
			}
			case "preset.apply": {
				const plan = this.#presetPlan(input.preset);
				if (plan.hash !== input.plan_hash)
					throw new BrowserSettingsServiceError(
						"browser.settings.conflict",
						409,
					);
				await writeJsoncConfig(
					configPort(),
					plan.plan,
					plan.document,
					plan.nextConfig,
					"save_launcher_config",
				);
				return BrowserSettingsCommandResultSchema.parse({
					command_kind: input.kind,
					outcome: "applied",
					summary: `Preset ${input.preset.name} was saved while preserving unknown configuration.`,
					changed: plan.changed,
					affected: [`preset:${input.preset.harness}/${input.preset.name}`],
					rollback_available: true,
					snapshot_revision: nextRevision,
				});
			}
			case "preset.rollback": {
				const backup = `${this.#launcherConfigPath}.golem-launcher.bak`;
				const source = readText(backup);
				if (source === undefined)
					throw new BrowserSettingsServiceError(
						"browser.settings.conflict",
						409,
					);
				atomicWriteText(this.#launcherConfigPath, source);
				return BrowserSettingsCommandResultSchema.parse({
					command_kind: input.kind,
					outcome: "rolled_back",
					summary: "Launcher presets were restored from the managed backup.",
					changed: true,
					affected: ["preset:launcher"],
					rollback_available: true,
					snapshot_revision: nextRevision,
				});
			}
			case "migration.preview": {
				const plan = await this.#migrationPlan();
				return BrowserSettingsCommandResultSchema.parse({
					command_kind: input.kind,
					outcome: "previewed",
					summary:
						plan.review || plan.quarantine
							? "Migration requires explicit review or quarantine decisions."
							: "Migration dry-run is ready for exact-hash confirmation.",
					plan_hash: plan.hash,
					changed: plan.affected.length > 0,
					affected: plan.affected,
					rollback_available: false,
					snapshot_revision: nextRevision,
				});
			}
			case "migration.apply": {
				const plan = await this.#migrationPlan();
				if (plan.hash !== input.plan_hash)
					throw new BrowserSettingsServiceError(
						"browser.settings.conflict",
						409,
					);
				if (plan.review || plan.quarantine)
					throw new BrowserSettingsServiceError(
						"browser.settings.conflict",
						409,
					);
				this.#runMigration("apply", plan.plan.plan_hash);
				return BrowserSettingsCommandResultSchema.parse({
					command_kind: input.kind,
					outcome: "applied",
					summary:
						"Legacy state was migrated from the confirmed dry-run with backups.",
					changed: true,
					affected: plan.affected,
					rollback_available: true,
					snapshot_revision: nextRevision,
				});
			}
			case "migration.rollback": {
				this.#runMigration("rollback");
				return BrowserSettingsCommandResultSchema.parse({
					command_kind: input.kind,
					outcome: "rolled_back",
					summary: "Legacy migration was restored from its canonical backup.",
					changed: true,
					affected: ["migration:canonical-state"],
					rollback_available: false,
					snapshot_revision: nextRevision,
				});
			}
		}
	}

	async command(
		input: BrowserSettingsCommandRequest,
	): Promise<BrowserSettingsCommandResponse> {
		const key = keyDigest(input.idempotency_key);
		const fingerprint = commandFingerprint(input);
		const existing = this.#state.receipts.find(
			(receipt) => receipt.key_digest === key,
		);
		if (existing) {
			if (existing.fingerprint !== fingerprint)
				throw new BrowserSettingsServiceError(
					"command.idempotency_mismatch",
					409,
				);
			if (existing.status === "completed" && existing.result)
				return BrowserSettingsCommandResponseSchema.parse({
					schema_version: "golem.browser-settings-command/v1",
					command_id: existing.command_id,
					status: "completed",
					result: existing.result,
				});
			if (existing.status === "pending") {
				const running = this.#inFlight.get(key);
				if (running) return running;
				return BrowserSettingsCommandResponseSchema.parse({
					schema_version: "golem.browser-settings-command/v1",
					command_id: existing.command_id,
					status: "pending",
				});
			}
			throw new BrowserSettingsServiceError(
				existing.error_code ?? "browser.settings.unavailable",
				existing.status === "rejected" ? 409 : 503,
			);
		}

		const receipt: StoredReceipt = {
			key_digest: key,
			fingerprint,
			command_id: `set_${crypto.randomUUID()}`,
			command_kind: input.kind,
			status: "pending",
			created_at: this.#now(),
		};
		this.#state.receipts.push(receipt);
		this.#persist();
		const operation = (async () => {
			try {
				const result = await this.#execute(input);
				const completed: StoredReceipt = {
					...receipt,
					status: "completed",
					completed_at: this.#now(),
					result,
				};
				this.#state.receipts = this.#state.receipts.map((candidate) =>
					candidate.command_id === receipt.command_id ? completed : candidate,
				);
				this.#state.revision += 1;
				this.#persist();
				return BrowserSettingsCommandResponseSchema.parse({
					schema_version: "golem.browser-settings-command/v1",
					command_id: receipt.command_id,
					status: "completed",
					result,
				});
			} catch (error) {
				const serviceError =
					error instanceof BrowserSettingsServiceError
						? error
						: new BrowserSettingsServiceError(
								"browser.settings.unavailable",
								503,
							);
				const failed: StoredReceipt = {
					...receipt,
					status:
						serviceError.code === "browser.settings.conflict" ||
						serviceError.code === "browser.settings.invalid" ||
						serviceError.code === "command.idempotency_mismatch"
							? "rejected"
							: "failed",
					completed_at: this.#now(),
					error_code: serviceError.code,
				};
				this.#state.receipts = this.#state.receipts.map((candidate) =>
					candidate.command_id === receipt.command_id ? failed : candidate,
				);
				this.#state.revision += 1;
				this.#persist();
				throw serviceError;
			} finally {
				this.#inFlight.delete(key);
			}
		})();
		this.#inFlight.set(key, operation);
		return operation;
	}
}

function builtInCapabilitiesModelPattern(id: string): string | undefined {
	const patterns: Readonly<Record<string, string>> = {
		"codex.openai.managed": "gpt-*",
		"codex.openai.direct": "gpt-*",
		"opencode.openai.direct": "gpt-*",
		"opencode.ollama-local.direct": "*",
		"opencode.ollama-cloud.direct": "*",
		"claude.anthropic.direct": "claude-*",
		"claude.ollama-local.direct": "*",
		"claude.ollama-cloud.direct": "*",
		"pi.next-turn.pull": "*",
	};
	return patterns[id];
}

export function createBrowserSettingsServices(
	options: BrowserSettingsServicesOptions,
): BrowserSettingsServices {
	return new BrowserSettingsServicesImpl(options);
}
