import type { DeliveryMode } from "@golem/contracts";
import type {
	CapabilitySnapshot,
	CapabilityTruth,
	DoctorFact,
	LauncherList,
	LaunchSelection,
	Qualification,
} from "./types.js";
import { deepFreeze } from "./types.js";

export const defaultQualificationMaxAgeMs = 1000 * 60 * 60 * 24 * 30;

function deliveryFlow(mode: DeliveryMode): CapabilitySnapshot["deliveryFlow"] {
	if (mode === "pull") return "pull";
	if (mode === "next_turn") return "next_turn";
	return "push";
}

function capability(
	id: string,
	harness: CapabilitySnapshot["capability"]["harness"],
	mode: CapabilitySnapshot["mode"],
	backend: CapabilitySnapshot["backend"],
	modelPattern: string,
	deliveryMode: DeliveryMode,
	qualification: Qualification,
	controlFeatures: readonly string[] = [],
): CapabilitySnapshot {
	return deepFreeze({
		capability: {
			capability_id: id,
			harness,
			adapter_version: "builtin-v1",
			integration_layers: [
				deliveryMode === "managed_app_server" ? "app_server" : "hooks",
			],
			qualification,
			delivery_mode: deliveryMode,
			readiness:
				deliveryMode === "next_turn"
					? "next_turn"
					: deliveryMode === "pull"
						? "pull_only"
						: "ready",
			evidence_version: "launcher-builtin-v1",
		},
		mode,
		backend,
		modelPattern,
		deliveryFlow: deliveryFlow(deliveryMode),
		controlFeatures: [...controlFeatures],
		executable: harness,
		evidenceSource: "built_in",
		evidencePolicy: "version_qualified",
		evidenceObservedAt: "2026-07-20T00:00:00.000Z",
	});
}

/** Version-qualified defaults intentionally do not age out on a wall-clock TTL. */
export const builtInCapabilities: readonly CapabilitySnapshot[] = deepFreeze([
	capability(
		"codex.openai.managed",
		"codex",
		"managed",
		"openai",
		"gpt-*",
		"managed_app_server",
		"supported",
		["resume", "interrupt"],
	),
	capability(
		"opencode.openai.direct",
		"opencode",
		"direct",
		"openai",
		"gpt-*",
		"prompt_bridge",
		"experimental",
	),
	capability(
		"opencode.ollama-local.direct",
		"opencode",
		"direct",
		"ollama_local",
		"*",
		"prompt_bridge",
		"experimental",
	),
	capability(
		"claude.anthropic.direct",
		"claude",
		"direct",
		"anthropic",
		"claude-*",
		"native_channel",
		"unknown",
	),
]);

function validTime(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** One capability truth projection is shared by resolve, list, and doctor. */
export function capabilityTruth(
	snapshot: CapabilitySnapshot,
	now: string,
	maxAge = defaultQualificationMaxAgeMs,
): CapabilityTruth {
	if (snapshot.evidenceSource === "registration")
		return deepFreeze({
			status: "registration_only",
			launchable: false,
			remediation:
				"Record a real consumption journey before authorizing launch or delivery.",
		});
	const observedAt = validTime(snapshot.evidenceObservedAt);
	const current = validTime(now);
	if (
		observedAt === undefined ||
		current === undefined ||
		!Number.isFinite(maxAge) ||
		maxAge < 0
	)
		return deepFreeze({
			status: "invalid_evidence",
			launchable: false,
			remediation:
				"Record valid evidence time and policy before authorizing launch.",
		});
	if (
		snapshot.evidencePolicy === "version_qualified" &&
		!snapshot.capability.evidence_version
	)
		return deepFreeze({
			status: "invalid_evidence",
			launchable: false,
			remediation:
				"Version-qualified evidence must include its compatibility version.",
		});
	if (snapshot.evidencePolicy === "observed") {
		const age = current - observedAt;
		if (age < 0 || age > maxAge)
			return deepFreeze({
				status: "stale",
				launchable: false,
				remediation: "Refresh qualification with a real adapter journey.",
			});
	}
	const qualification = snapshot.capability.qualification;
	const launchable =
		qualification === "supported" || qualification === "experimental";
	return deepFreeze({
		status: qualification,
		launchable,
		remediation:
			snapshot.remediation ??
			(launchable
				? "Keep evidence policy and compatibility version current."
				: "Choose a qualified capability or run its real qualification journey."),
	});
}

export function modelMatches(pattern: string, model: string): boolean {
	const expression = `^${pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*")}$`;
	return new RegExp(expression, "u").test(model);
}

export function capabilityFor(
	selection: LaunchSelection,
	capabilities: readonly CapabilitySnapshot[],
): CapabilitySnapshot | undefined {
	return capabilities
		.filter(
			(snapshot) =>
				snapshot.capability.harness === selection.harness &&
				snapshot.mode === selection.mode &&
				snapshot.backend === selection.backend &&
				snapshot.capability.delivery_mode === selection.deliveryMode &&
				modelMatches(snapshot.modelPattern, selection.modelSelector),
		)
		.sort(
			(left, right) =>
				right.modelPattern.length - left.modelPattern.length ||
				left.capability.capability_id.localeCompare(
					right.capability.capability_id,
				),
		)[0];
}

export function doctorFacts(
	capabilities: readonly CapabilitySnapshot[],
	now: string,
	qualificationMaxAgeMs = defaultQualificationMaxAgeMs,
): readonly DoctorFact[] {
	return deepFreeze(
		[...capabilities]
			.map((snapshot): DoctorFact => {
				const truth = capabilityTruth(snapshot, now, qualificationMaxAgeMs);
				return {
					id: snapshot.capability.capability_id,
					harness: snapshot.capability.harness,
					mode: snapshot.mode,
					backend: snapshot.backend,
					qualification: truth.status,
					launchable: truth.launchable,
					deliveryMode: snapshot.capability.delivery_mode,
					deliveryFlow: snapshot.deliveryFlow,
					readiness: snapshot.capability.readiness,
					integrationLayers: [...snapshot.capability.integration_layers].sort(),
					controlFeatures: [...snapshot.controlFeatures].sort(),
					evidenceSource: snapshot.evidenceSource,
					evidencePolicy: snapshot.evidencePolicy,
					...(snapshot.capability.evidence_version
						? { evidenceVersion: snapshot.capability.evidence_version }
						: {}),
					...(snapshot.evidenceObservedAt
						? { observedAt: snapshot.evidenceObservedAt }
						: {}),
					remediation: truth.remediation,
				};
			})
			.sort((left, right) => left.id.localeCompare(right.id)),
	);
}

export function listCapabilities(
	capabilities: readonly CapabilitySnapshot[],
	now: string,
	qualificationMaxAgeMs = defaultQualificationMaxAgeMs,
): LauncherList["capabilities"] {
	return deepFreeze(
		[...capabilities]
			.map((snapshot) => {
				const truth = capabilityTruth(snapshot, now, qualificationMaxAgeMs);
				return {
					id: snapshot.capability.capability_id,
					harness: snapshot.capability.harness,
					mode: snapshot.mode,
					backend: snapshot.backend,
					qualification: truth.status,
					launchable: truth.launchable,
					deliveryMode: snapshot.capability.delivery_mode,
					deliveryFlow: snapshot.deliveryFlow,
					readiness: snapshot.capability.readiness,
					controlFeatures: [...snapshot.controlFeatures].sort(),
					evidenceSource: snapshot.evidenceSource,
					evidencePolicy: snapshot.evidencePolicy,
					...(snapshot.capability.evidence_version
						? { evidenceVersion: snapshot.capability.evidence_version }
						: {}),
					...(snapshot.evidenceObservedAt
						? { observedAt: snapshot.evidenceObservedAt }
						: {}),
				};
			})
			.sort((left, right) => left.id.localeCompare(right.id)),
	);
}
