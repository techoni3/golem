import { LauncherPresetBodySchema } from "@golem/contracts";

import { failure, issue, LauncherResolutionError } from "./explain.js";
import type {
	ConfigScope,
	LaunchExplanation,
	LauncherConfig,
	LauncherIssue,
	LaunchFailure,
	LaunchPreset,
	PresetSource,
	ResolveLaunchInput,
} from "./types.js";
import { deepFreeze, harnesses } from "./types.js";

const secretArgument =
	/^--?(?:api[_-]?key|token|secret|password|credential)(?:=|$)/iu;
const secretInlineValue =
	/(?:api[_-]?key|token|secret|password|credential)\s*=/iu;
const unsafeExecutable = /[\0\r\n;&|`$<>()]/u;

export const builtInPresets: readonly LaunchPreset[] = deepFreeze([
	{
		name: "default",
		harness: "codex",
		backend: "openai",
		model_selector: "gpt-*",
		delivery_mode: "managed_app_server",
		native_args: [],
		env_key_refs: ["OPENAI_API_KEY"],
	},
	{
		name: "direct",
		harness: "codex",
		backend: "openai",
		model_selector: "gpt-*",
		delivery_mode: "pull",
		native_args: [],
		env_key_refs: ["OPENAI_API_KEY"],
	},
	{
		name: "default",
		harness: "opencode",
		backend: "openai",
		model_selector: "gpt-*",
		delivery_mode: "prompt_bridge",
		native_args: [],
		env_key_refs: ["OPENAI_API_KEY"],
	},
	{
		name: "local",
		harness: "opencode",
		backend: "ollama_local",
		model_selector: "*",
		delivery_mode: "prompt_bridge",
		native_args: [],
		env_key_refs: [],
	},
	{
		name: "cloud",
		harness: "opencode",
		backend: "ollama_cloud",
		model_selector: "*",
		delivery_mode: "prompt_bridge",
		native_args: [],
		env_key_refs: [],
	},
	{
		name: "default",
		harness: "claude",
		backend: "anthropic",
		model_selector: "claude-*",
		delivery_mode: "native_channel",
		native_args: [],
		env_key_refs: ["ANTHROPIC_API_KEY"],
	},
	{
		name: "local",
		harness: "claude",
		backend: "ollama_local",
		model_selector: "*",
		delivery_mode: "native_channel",
		native_args: [],
		env_key_refs: [],
	},
	{
		name: "cloud",
		harness: "claude",
		backend: "ollama_cloud",
		model_selector: "*",
		delivery_mode: "native_channel",
		native_args: [],
		env_key_refs: [],
	},
]);

function hasControlCharacter(value: string): boolean {
	return value.includes("\0") || value.includes("\r") || value.includes("\n");
}

function unsafeArgument(value: string): boolean {
	return (
		hasControlCharacter(value) ||
		secretArgument.test(value) ||
		secretInlineValue.test(value)
	);
}

export function asPreset(value: unknown, scope: ConfigScope): LaunchPreset {
	const parsed = LauncherPresetBodySchema.safeParse(value);
	if (!parsed.success)
		throw new LauncherResolutionError(
			issue(
				"launcher.config.managed_invalid",
				`The ${scope} launch preset contains an unsupported managed field or secret-bearing argument.`,
				[
					"Remove the invalid managed field and keep secrets in the environment or credential provider.",
				],
			),
		);
	const preset = parsed.data;
	if (scope === "project" && preset.binary_override)
		throw new LauncherResolutionError(
			issue(
				"launcher.project.binary_override_forbidden",
				"Project configuration cannot select an executable.",
				[
					"Move binary_override to trusted user configuration or use the installed harness.",
				],
			),
		);
	if (preset.binary_override && unsafeExecutable.test(preset.binary_override))
		throw new LauncherResolutionError(
			issue(
				"launcher.executable.unsafe",
				"Executable overrides cannot contain shell-control characters.",
				["Use an installed executable path without shell syntax."],
			),
		);
	for (const argument of preset.native_args) {
		if (unsafeArgument(argument))
			throw new LauncherResolutionError(
				issue(
					"launcher.argv.secret_or_unsafe",
					"Launch arguments cannot contain secrets or control characters.",
					[
						"Use direct safe argv values and keep credential values outside configuration.",
					],
				),
			);
	}
	return deepFreeze({
		name: preset.name,
		harness: preset.harness,
		backend: preset.backend,
		model_selector: preset.model_selector,
		delivery_mode: preset.delivery_mode,
		native_args: [...preset.native_args],
		env_key_refs: [...preset.env_key_refs],
		...(preset.binary_override
			? { binary_override: preset.binary_override }
			: {}),
	});
}

function presetKey(preset: LaunchPreset): string {
	return `${preset.harness}:${preset.name}`;
}

function duplicateIssue(
	presets: readonly LaunchPreset[],
	scope: "user" | "project",
): LauncherIssue | undefined {
	const seen = new Set<string>();
	for (const preset of presets) {
		const key = presetKey(preset);
		if (seen.has(key))
			return issue(
				"launcher.preset.ambiguous",
				`The ${scope} configuration declares a preset name more than once for one harness.`,
				[
					"Rename or remove the duplicate preset; declaration order cannot choose an owner.",
				],
			);
		seen.add(key);
	}
	return undefined;
}

function emptyConfig(): LauncherConfig {
	return {
		schemaVersion: "golem.launcher-config/v1",
		harnessDefaults: {},
		presets: [],
	};
}

/** Project overrides user, while duplicate declarations within one scope fail closed. */
export function mergeLauncherConfig(
	input: Pick<ResolveLaunchInput, "user" | "project">,
): LauncherConfig | LauncherIssue {
	const user = input.user?.config ?? emptyConfig();
	const project = input.project?.config ?? emptyConfig();
	const duplicate =
		duplicateIssue(user.presets, "user") ??
		duplicateIssue(project.presets, "project");
	if (duplicate) return duplicate;
	const presets = new Map<string, LaunchPreset>();
	for (const preset of [...builtInPresets, ...user.presets, ...project.presets])
		presets.set(presetKey(preset), preset);
	return deepFreeze({
		schemaVersion: "golem.launcher-config/v1",
		harnessDefaults: {
			...user.harnessDefaults,
			...project.harnessDefaults,
		},
		presets: [...presets.values()].sort((left, right) =>
			presetKey(left).localeCompare(presetKey(right)),
		),
	});
}

function findPreset(
	presets: readonly LaunchPreset[],
	name: string,
	harness?: LaunchPreset["harness"],
): LaunchPreset | LauncherIssue {
	const matches = presets.filter(
		(preset) =>
			preset.name === name && (!harness || preset.harness === harness),
	);
	if (matches.length === 1)
		return (
			matches[0] ??
			issue("launcher.preset.unknown", "Preset lookup failed.", [])
		);
	if (matches.length > 1)
		return issue(
			"launcher.preset.ambiguous",
			"Preset name is defined for more than one harness.",
			["Use a harness-scoped preset invocation."],
		);
	return issue(
		"launcher.preset.unknown",
		"Preset is not configured for the selected harness.",
		["List presets and choose a configured name."],
	);
}

function isIssue(value: LaunchPreset | LauncherIssue): value is LauncherIssue {
	return "code" in value;
}

function sourceForDefault(
	harness: LaunchPreset["harness"],
	input: ResolveLaunchInput,
): PresetSource {
	if (input.project?.config.harnessDefaults[harness]) return "project_default";
	if (input.user?.config.harnessDefaults[harness]) return "user_default";
	return "built_in";
}

function defaultName(
	harness: LaunchPreset["harness"],
	input: ResolveLaunchInput,
): string {
	return (
		input.project?.config.harnessDefaults[harness] ??
		input.user?.config.harnessDefaults[harness] ??
		"default"
	);
}

export function resolvePreset(
	input: ResolveLaunchInput,
	config: LauncherConfig,
	trace: LaunchExplanation[],
): { preset: LaunchPreset; source: PresetSource } | LaunchFailure {
	const invokedHarness = input.harness;
	if (input.globalPreset) {
		const found = findPreset(config.presets, input.globalPreset);
		if (isIssue(found)) return failure(found, trace);
		if (invokedHarness && found.harness !== invokedHarness)
			return failure(
				issue(
					"launcher.input.conflict",
					"The invoked harness conflicts with the invoked global preset.",
					["Use the preset's harness or invoke a harness-scoped preset."],
				),
				trace,
			);
		trace.push({
			code: "launcher.preset.invoked_global",
			source: "invoked_global",
			detail: found.name,
		});
		return { preset: found, source: "invoked_global" };
	}
	if (!invokedHarness)
		return failure(
			issue(
				input.isTTY
					? "launcher.input.harness_required"
					: "launcher.input.non_tty",
				input.isTTY
					? "A TTY picker belongs to the later CLI layer; resolution needs a harness selection."
					: "Non-interactive resolution requires an explicit harness or global preset.",
				["Pass a harness such as codex, or invoke a global @preset."],
			),
			trace,
		);
	if (!harnesses.has(invokedHarness))
		return failure(
			issue(
				"launcher.harness.unknown",
				"The requested harness is not supported.",
				["Use claude, codex, opencode, or pi."],
			),
			trace,
		);
	const name = input.preset ?? defaultName(invokedHarness, input);
	const found = findPreset(config.presets, name, invokedHarness);
	if (isIssue(found)) return failure(found, trace);
	const source = input.preset
		? "invoked_scoped"
		: sourceForDefault(invokedHarness, input);
	trace.push({ code: `launcher.preset.${source}`, source, detail: found.name });
	return { preset: found, source };
}
