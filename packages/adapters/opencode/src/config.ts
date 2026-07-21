import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mergeOpenCodeManagedRegion } from "@golem/launcher";
import { type ParseError, parse } from "jsonc-parser";
import type {
	OpenCodeConfigPort,
	OpenCodeConfigSetup,
	OpenCodeProviderObservation,
} from "./types.js";

export const OPENCODE_PROVIDER_PATH = ["provider", "golem"] as const;
export const OPENCODE_PROVIDER_MARKER = "golem.opencode.providers/v1" as const;

export class OpenCodeConfigError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = "OpenCodeConfigError";
		this.code = code;
	}
}

function validJsonc(text: string): boolean {
	const errors: ParseError[] = [];
	const value = parse(text, errors, {
		allowTrailingComma: true,
		disallowComments: false,
	});
	return (
		errors.length === 0 &&
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value)
	);
}

export function openCodeManagedProviderRegion(
	observations: readonly OpenCodeProviderObservation[],
): Record<string, unknown> {
	const providers: Record<string, unknown> = {};
	for (const observation of [...observations].sort((left, right) =>
		left.provider.localeCompare(right.provider),
	)) {
		providers[observation.provider] = {
			enabled: observation.available,
			model:
				observation.modelPattern ??
				(observation.provider === "openai" ? "gpt-*" : "*"),
			qualification:
				observation.responseObserved && observation.deliveryObserved
					? "supported"
					: "unqualified",
			...(observation.version ? { version: observation.version } : {}),
		};
	}
	return {
		managed_by: OPENCODE_PROVIDER_MARKER,
		providers,
	};
}

export async function createFileConfigPort(): Promise<OpenCodeConfigPort> {
	return {
		readText: async (path) => {
			try {
				return await readFile(path, "utf8");
			} catch (error) {
				if (
					error &&
					typeof error === "object" &&
					"code" in error &&
					error.code === "ENOENT"
				)
					return undefined;
				throw new OpenCodeConfigError("adapter.opencode.config.read_failed");
			}
		},
		writeBackup: async (path, text) => {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, text, "utf8");
		},
		writeTemporary: async (path, text) => {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, text, "utf8");
		},
		commitTemporary: async (temporaryPath, targetPath) => {
			await mkdir(dirname(targetPath), { recursive: true });
			await rename(temporaryPath, targetPath);
		},
		rollback: async (targetPath, backupPath) => {
			await rename(backupPath, targetPath);
		},
		removeTemporary: async (path) => {
			await rm(path, { force: true });
		},
	};
}

/**
 * Compute an explicit provider-region diff.  This function is read-only: no
 * launch path calls it, and `apply` is required before any port mutation.
 */
export async function setupOpenCodeConfig(input: {
	readonly path: string;
	readonly observations: readonly OpenCodeProviderObservation[];
	readonly port?: OpenCodeConfigPort;
	readonly apply?: boolean;
}): Promise<OpenCodeConfigSetup> {
	const port = input.port ?? (await createFileConfigPort());
	const source = (await port.readText(input.path)) ?? "{}\n";
	if (!validJsonc(source))
		throw new OpenCodeConfigError("adapter.opencode.config.invalid");
	const next = mergeOpenCodeManagedRegion(
		source,
		OPENCODE_PROVIDER_PATH,
		openCodeManagedProviderRegion(input.observations),
	);
	const setup: OpenCodeConfigSetup = {
		targetPath: input.path,
		managedPath: OPENCODE_PROVIDER_PATH,
		sourceBytes: Buffer.byteLength(source),
		nextBytes: Buffer.byteLength(next),
		changed: source !== next,
		dryRun: !input.apply,
		text: next,
	};
	if (!input.apply || source === next) return setup;
	const backupPath = `${input.path}.golem-opencode.bak`;
	const temporaryPath = `${input.path}.golem-opencode.tmp`;
	let temporaryCleanupEligible = false;
	try {
		await port.writeBackup(backupPath, source);
		temporaryCleanupEligible = true;
		await port.writeTemporary(temporaryPath, next);
		await port.commitTemporary(temporaryPath, input.path);
	} catch {
		try {
			await port.rollback(input.path, backupPath);
		} catch {
			/* stable failure below */
		}
		if (temporaryCleanupEligible) {
			try {
				await port.removeTemporary(temporaryPath);
			} catch {
				/* subordinate cleanup failure */
			}
		}
		throw new OpenCodeConfigError(
			"adapter.opencode.config.atomic_write_failed",
		);
	}
	return setup;
}
