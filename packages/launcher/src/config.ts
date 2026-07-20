import { LauncherConfigV1Schema } from "@golem/contracts";
import {
	applyEdits,
	modify,
	type ParseError,
	parse,
	printParseErrorCode,
} from "jsonc-parser";

import { issue, LauncherResolutionError } from "./explain.js";
import { asPreset } from "./presets.js";
import type {
	ConfigScope,
	ConfigTextPort,
	ConfigWritePlan,
	JsoncConfigDocument,
	LauncherConfig,
} from "./types.js";
import { deepFreeze, harnesses, isRecord } from "./types.js";

function compactHarnessDefaults(
	defaults: Readonly<Record<string, string | undefined>>,
): LauncherConfig["harnessDefaults"] {
	const compact: Partial<
		Record<typeof harnesses extends Set<infer T> ? T : never, string>
	> = {};
	for (const harness of harnesses) {
		const value = defaults[harness];
		if (value) compact[harness] = value;
	}
	return compact;
}

function adaptV0(root: Record<string, unknown>): LauncherConfig {
	const legacyHarnesses = isRecord(root.harnesses) ? root.harnesses : {};
	const harnessDefaults: Record<string, string> = {};
	if (isRecord(legacyHarnesses.codex)) harnessDefaults.codex = "default";
	if (isRecord(legacyHarnesses.opencode)) harnessDefaults.opencode = "default";
	if (isRecord(legacyHarnesses.claudecode)) harnessDefaults.claude = "default";
	return deepFreeze({
		schemaVersion: "golem.launcher-config/v1",
		harnessDefaults: compactHarnessDefaults(harnessDefaults),
		presets: [],
	});
}

export function parseJsoncConfig(
	text: string,
	scope: ConfigScope,
): JsoncConfigDocument {
	const errors: ParseError[] = [];
	const root = parse(text, errors, {
		allowTrailingComma: true,
		disallowComments: false,
	});
	if (errors.length || !isRecord(root))
		throw new LauncherResolutionError(
			issue(
				"launcher.config.jsonc_invalid",
				`The ${scope} configuration is not a valid JSONC object (${errors.map((error) => printParseErrorCode(error.error)).join(",") || "object required"}).`,
				["Fix the JSONC syntax without removing user-owned keys."],
			),
		);
	const userOwned = Object.fromEntries(
		Object.entries(root).filter(
			([key]) => key !== "schema_version" && key !== "launch",
		),
	);
	if (root.schema_version === undefined)
		return deepFreeze({
			scope,
			text,
			config: adaptV0(root),
			userOwned,
			warnings: [
				issue(
					"launcher.config.v0_adapted",
					"Legacy config was read through the explicit v0 adapter and was not rewritten.",
					[
						"Use an intentional launcher config save to create versioned JSONC.",
					],
					"warning",
				),
			],
		});
	const validated = LauncherConfigV1Schema.safeParse({
		schema_version: root.schema_version,
		launch: root.launch,
	});
	if (!validated.success)
		throw new LauncherResolutionError(
			issue(
				"launcher.config.managed_invalid",
				`The ${scope} launch section has an unknown or invalid managed field.`,
				[
					"Correct the versioned launch section; user-owned keys outside it are preserved.",
				],
			),
		);
	const config = validated.data;
	return deepFreeze({
		scope,
		text,
		config: {
			schemaVersion: "golem.launcher-config/v1",
			harnessDefaults: compactHarnessDefaults(config.launch.harness_defaults),
			presets: config.launch.presets.map((preset) => asPreset(preset, scope)),
		},
		userOwned,
		warnings: [],
	});
}

export async function loadJsoncConfig(
	port: Pick<ConfigTextPort, "readText">,
	path: string,
	scope: ConfigScope,
): Promise<JsoncConfigDocument> {
	const text = await port.readText(path);
	return parseJsoncConfig(text ?? "{}\n", scope);
}

function renderConfigText(
	document: JsoncConfigDocument,
	config: LauncherConfig,
): string {
	let nextText = document.text || "{}\n";
	const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
	for (const [jsonPath, value] of [
		[["schema_version"], "golem.launcher-config/v1"],
		[
			["launch"],
			{
				harness_defaults: config.harnessDefaults,
				presets: config.presets,
			},
		],
	] as const) {
		nextText = applyEdits(
			nextText,
			modify(nextText, [...jsonPath], value, { formattingOptions }),
		);
	}
	return nextText.endsWith("\n") ? nextText : `${nextText}\n`;
}

/** Creates a redacted, deterministic atomic intent; it never exposes config values. */
export function planConfigWrite(
	path: string,
	document: JsoncConfigDocument,
	config: LauncherConfig,
): ConfigWritePlan {
	const nextText = renderConfigText(document, config);
	return deepFreeze({
		targetPath: path,
		backupPath: `${path}.golem-launcher.bak`,
		temporaryPath: `${path}.golem-launcher.tmp`,
		preserveUnknownRegions: true as const,
		sourceBytes: document.text.length,
		nextBytes: nextText.length,
	});
}

/**
 * Backup → temporary write → atomic commit. Any interruption restores backup
 * through the injected port and removes the temporary file before surfacing a
 * redacted, stable error.
 */
export async function writeJsoncConfig(
	port: ConfigTextPort,
	plan: ConfigWritePlan,
	document: JsoncConfigDocument,
	config: LauncherConfig,
	intent: "save_launcher_config",
): Promise<void> {
	if (intent !== "save_launcher_config")
		throw new LauncherResolutionError(
			issue(
				"launcher.config.write_intent_required",
				"Writing versioned launcher JSONC requires an explicit save intent.",
				["Create and review a redacted ConfigWritePlan before writing."],
			),
		);
	let backupWritten = false;
	let temporaryCleanupEligible = false;
	try {
		await port.writeBackup(plan.backupPath, document.text);
		backupWritten = true;
		// A port may create bytes and then throw; cleanup must not depend on await returning.
		temporaryCleanupEligible = true;
		await port.writeTemporary(
			plan.temporaryPath,
			renderConfigText(document, config),
		);
		await port.commitTemporary(plan.temporaryPath, plan.targetPath);
	} catch {
		try {
			if (backupWritten) {
				try {
					await port.rollback(plan.targetPath, plan.backupPath);
				} catch {
					// The public failure remains stable and redacted even when rollback fails.
				}
			}
		} finally {
			if (temporaryCleanupEligible) {
				try {
					await port.removeTemporary(plan.temporaryPath);
				} catch {
					// A cleanup-port error must not replace the stable write failure.
				}
			}
		}
		throw new LauncherResolutionError(
			issue(
				"launcher.config.atomic_write_failed",
				"The launcher configuration write was interrupted and rolled back.",
				["Inspect the preserved backup and retry the explicit save intent."],
			),
		);
	}
}

/** Updates only the named managed OpenCode region; all other JSONC remains byte-preserved. */
export function mergeOpenCodeManagedRegion(
	text: string,
	path: readonly string[],
	value: unknown,
): string {
	const errors: ParseError[] = [];
	parse(text, errors, { allowTrailingComma: true, disallowComments: false });
	if (errors.length)
		throw new LauncherResolutionError(
			issue(
				"launcher.opencode.jsonc_invalid",
				"OpenCode JSONC must be valid before a managed region can be updated.",
				["Fix syntax without deleting user-owned provider or credential keys."],
			),
		);
	return applyEdits(
		text,
		modify(text, [...path], value, {
			formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
		}),
	);
}
