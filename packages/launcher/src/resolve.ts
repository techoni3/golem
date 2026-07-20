import {
	builtInCapabilities,
	capabilityFor,
	capabilityTruth,
	defaultQualificationMaxAgeMs,
	doctorFacts,
	listCapabilities,
} from "./capabilities.js";
import { failure, issue } from "./explain.js";
import { mergeLauncherConfig, resolvePreset } from "./presets.js";
import type {
	CapabilitySnapshot,
	LaunchExplanation,
	LauncherIssue,
	LauncherList,
	LaunchPlan,
	LaunchResolution,
	ResolveLaunchInput,
} from "./types.js";
import { backends, deepFreeze, harnesses, modes } from "./types.js";

const secretArgument =
	/^--?(?:api[_-]?key|token|secret|password|credential)(?:=|$)/iu;
const secretInlineValue =
	/(?:api[_-]?key|token|secret|password|credential)\s*=/iu;

function hasControlCharacter(value: string): boolean {
	return value.includes("\0") || value.includes("\r") || value.includes("\n");
}

function safePassthrough(
	arguments_: readonly string[],
): LauncherIssue | undefined {
	for (const argument of arguments_) {
		if (
			hasControlCharacter(argument) ||
			secretArgument.test(argument) ||
			secretInlineValue.test(argument)
		)
			return issue(
				"launcher.argv.secret_or_unsafe",
				"Passthrough arguments cannot contain secrets or control characters.",
				["Use an environment key reference or a credential provider instead."],
			);
	}
	return undefined;
}

function safeModelSelector(value: string): LauncherIssue | undefined {
	if (
		!value.trim() ||
		hasControlCharacter(value) ||
		secretArgument.test(value) ||
		secretInlineValue.test(value)
	)
		return issue(
			"launcher.model.invalid",
			"Model selectors must be non-blank and cannot contain secrets or control characters.",
			["Use a model name or wildcard pattern without credential values."],
		);
	return undefined;
}

export function resolveLaunch(input: ResolveLaunchInput): LaunchResolution {
	const trace: LaunchExplanation[] = [];
	const config = mergeLauncherConfig(input);
	if ("code" in config) return failure(config, trace);
	const selected = resolvePreset(input, config, trace);
	if ("ok" in selected) return selected;
	const passthrough = input.passthrough ?? [];
	const passthroughIssue = safePassthrough(passthrough);
	if (passthroughIssue) return failure(passthroughIssue, trace);
	const explicit = input.explicit ?? {};
	const presetMode =
		selected.preset.delivery_mode === "managed_app_server"
			? "managed"
			: "direct";
	const harness = explicit.harness ?? selected.preset.harness;
	const mode = explicit.mode ?? presetMode;
	const backend = explicit.backend ?? selected.preset.backend;
	const modelSelector =
		explicit.modelSelector ?? selected.preset.model_selector;
	const deliveryMode = explicit.deliveryMode ?? selected.preset.delivery_mode;
	if (!harnesses.has(harness) || !modes.has(mode) || !backends.has(backend))
		return failure(
			issue(
				"launcher.selection.invalid",
				"Harness, mode, or backend is not supported.",
				[
					"Use a configured harness/backend preset or explicit supported value.",
				],
			),
			trace,
		);
	const modelIssue = safeModelSelector(modelSelector);
	if (modelIssue) return failure(modelIssue, trace);
	if (
		harness !== selected.preset.harness ||
		mode !== presetMode ||
		backend !== selected.preset.backend ||
		deliveryMode !== selected.preset.delivery_mode
	)
		return failure(
			issue(
				"launcher.override.preset_incompatible",
				"Explicit launch selection conflicts with dependencies supplied by the selected preset.",
				[
					"Use a preset for the requested harness, backend, mode, and delivery combination, or omit the conflicting override.",
				],
			),
			trace,
		);
	if (Object.keys(explicit).length > 0)
		trace.push({
			code: "launcher.override.explicit",
			source: "explicit",
			detail:
				"explicit values applied after invoked presets and configuration defaults",
		});
	const provisional = {
		harness,
		mode,
		backend,
		modelSelector,
		deliveryMode,
		adapterId: "unqualified",
		executable: selected.preset.binary_override ?? harness,
	};
	const snapshot = capabilityFor(
		provisional,
		input.capabilities ?? builtInCapabilities,
	);
	if (!snapshot)
		return failure(
			issue(
				"launcher.capability.unavailable",
				"No capability snapshot qualifies this harness/backend/model/mode combination.",
				[
					"Choose a listed capability or run the adapter qualification journey.",
				],
			),
			trace,
		);
	const truth = capabilityTruth(
		snapshot,
		input.now,
		input.qualificationMaxAgeMs ?? defaultQualificationMaxAgeMs,
	);
	if (!truth.launchable) {
		const code =
			truth.status === "registration_only"
				? "launcher.capability.registration_only"
				: truth.status === "stale"
					? "launcher.capability.stale"
					: truth.status === "invalid_evidence"
						? "launcher.capability.invalid_evidence"
						: "launcher.capability.unqualified";
		return failure(
			issue(code, "The selected capability is not qualified for launch.", [
				truth.remediation,
			]),
			trace,
		);
	}
	trace.push({
		code: "launcher.capability.qualified",
		source: "capability",
		detail: `${snapshot.capability.capability_id}:${truth.status}`,
	});
	const warnings: LauncherIssue[] = [];
	if (truth.status === "experimental")
		warnings.push(
			issue(
				"launcher.capability.experimental",
				"The capability is version-qualified but remains experimental.",
				[truth.remediation],
				"warning",
			),
		);
	const plan: LaunchPlan = {
		schemaVersion: "golem.launch-plan/v1",
		ok: true,
		selection: {
			...provisional,
			adapterId: snapshot.capability.capability_id,
			executable: selected.preset.binary_override ?? snapshot.executable,
		},
		preset: { name: selected.preset.name, source: selected.source },
		executableRequirement: {
			path: selected.preset.binary_override ?? snapshot.executable,
			mode,
		},
		environmentKeyRefs: [...selected.preset.env_key_refs].sort(),
		effectiveArgvIntent: [
			selected.preset.binary_override ?? snapshot.executable,
			...selected.preset.native_args,
			...passthrough,
		],
		qualification: {
			status: snapshot.capability.qualification,
			source: snapshot.evidenceSource,
			policy: snapshot.evidencePolicy,
			...(snapshot.capability.evidence_version
				? { version: snapshot.capability.evidence_version }
				: {}),
			observedAt: snapshot.evidenceObservedAt ?? "",
		},
		capabilityFacts: {
			deliveryMode: snapshot.capability.delivery_mode,
			deliveryFlow: snapshot.deliveryFlow,
			readiness: snapshot.capability.readiness,
			integrationLayers: [...snapshot.capability.integration_layers].sort(),
			controlFeatures: [...snapshot.controlFeatures].sort(),
		},
		warnings,
		trace,
	};
	return deepFreeze(plan);
}

export function listLauncher(input: {
	readonly user?: ResolveLaunchInput["user"];
	readonly project?: ResolveLaunchInput["project"];
	readonly capabilities?: readonly CapabilitySnapshot[];
	readonly now: string;
	readonly qualificationMaxAgeMs?: number;
}): LauncherList {
	const config = mergeLauncherConfig({
		...(input.user ? { user: input.user } : {}),
		...(input.project ? { project: input.project } : {}),
	});
	const capabilities = listCapabilities(
		input.capabilities ?? builtInCapabilities,
		input.now,
		input.qualificationMaxAgeMs ?? defaultQualificationMaxAgeMs,
	);
	if ("code" in config)
		return deepFreeze({ presets: [], capabilities, issues: [config] });
	return deepFreeze({
		presets: config.presets
			.map((preset) => ({
				name: preset.name,
				harness: preset.harness,
				backend: preset.backend,
				modelSelector: preset.model_selector,
			}))
			.sort((left, right) =>
				`${left.harness}:${left.name}`.localeCompare(
					`${right.harness}:${right.name}`,
				),
			),
		capabilities,
		issues: [],
	});
}

export { doctorFacts };
