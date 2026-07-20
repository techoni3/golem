import type { DeliveryMode } from "@golem/contracts";
import type {
	CapabilitySnapshot,
	CapabilityTruth,
	DeliveryFacts,
	DeliveryTruthReadiness,
	DoctorFact,
	LauncherList,
	LaunchFacts,
	LaunchSelection,
	Qualification,
} from "./types.js";
import { deepFreeze } from "./types.js";

export const defaultQualificationMaxAgeMs = 1000 * 60 * 60 * 24 * 30;
const evidenceSources = new Set([
	"built_in",
	"real_journey",
	"manual_probe",
	"registration",
]);
const evidencePolicies = new Set(["observed", "version_qualified"]);

function qualifiedDeliveryFlow(
	mode: DeliveryMode,
	qualification: Qualification,
): CapabilitySnapshot["deliveryFlow"] {
	if (mode === "pull") return "pull";
	if (mode === "next_turn") return "next_turn";
	return qualification === "supported" ? "push" : "pull";
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
	options: Readonly<{
		readonly launch?: LaunchFacts;
		readonly deliveryReason?: string;
		readonly deliveryRemediation?: string;
	}> = {},
): CapabilitySnapshot {
	const launch =
		options.launch ??
		({
			status: "launchable",
			reason:
				"The selected harness, backend, and model have a launch contribution.",
			remediation:
				"Keep the installed harness and adapter contribution available.",
		} satisfies LaunchFacts);
	const readiness =
		deliveryMode === "next_turn"
			? "next_turn"
			: deliveryMode === "pull"
				? "pull_only"
				: qualification === "supported"
					? "ready"
					: "unsupported";
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
			readiness,
			evidence_version: "launcher-builtin-v1",
		},
		mode,
		backend,
		modelPattern,
		deliveryFlow: qualifiedDeliveryFlow(deliveryMode, qualification),
		controlFeatures: [...controlFeatures],
		executable: harness,
		evidenceSource: "built_in",
		evidencePolicy: "version_qualified",
		evidenceObservedAt: "2026-07-20T00:00:00.000Z",
		launchContribution: launch,
		...(options.deliveryReason
			? { deliveryReason: options.deliveryReason }
			: {}),
		...(options.deliveryRemediation
			? { deliveryRemediation: options.deliveryRemediation }
			: {}),
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
		"codex.openai.direct",
		"codex",
		"direct",
		"openai",
		"gpt-*",
		"pull",
		"supported",
		["pull"],
		{
			deliveryReason:
				"Direct Codex retains Golem pull tools but is not Golem-owned push control.",
			deliveryRemediation:
				"Use managed golem codex for App Server push/control.",
		},
	),
	capability(
		"opencode.openai.direct",
		"opencode",
		"direct",
		"openai",
		"gpt-*",
		"prompt_bridge",
		"experimental",
		[],
		{
			deliveryReason:
				"OpenCode prompt delivery is not yet independently consumption-qualified.",
			deliveryRemediation:
				"Run the OpenCode adapter qualification journey before advertising push readiness.",
		},
	),
	capability(
		"opencode.ollama-local.direct",
		"opencode",
		"direct",
		"ollama_local",
		"*",
		"prompt_bridge",
		"experimental",
		[],
		{
			deliveryReason:
				"Local Ollama launchability is independent from unproven prompt consumption.",
			deliveryRemediation:
				"Run the OpenCode local-provider qualification journey before advertising push readiness.",
		},
	),
	capability(
		"opencode.ollama-cloud.direct",
		"opencode",
		"direct",
		"ollama_cloud",
		"*",
		"prompt_bridge",
		"experimental",
		[],
		{
			deliveryReason:
				"Ollama Cloud launchability does not prove addressed prompt consumption.",
			deliveryRemediation:
				"Run the OpenCode cloud-provider qualification journey before advertising push readiness.",
		},
	),
	capability(
		"claude.anthropic.direct",
		"claude",
		"direct",
		"anthropic",
		"claude-*",
		"native_channel",
		"unknown",
		[],
		{
			launch: {
				status: "unavailable",
				reason:
					"Claude Anthropic launch contribution is not installed or qualified in this environment.",
				remediation:
					"Verify the Claude plugin/channel launch contribution before spawning.",
			},
			deliveryReason:
				"Claude channel consumption has not been proven for this process/provider combination.",
			deliveryRemediation:
				"Run the Claude channel-consumption qualification journey; until then use pull-only operation.",
		},
	),
	capability(
		"claude.ollama-local.direct",
		"claude",
		"direct",
		"ollama_local",
		"*",
		"native_channel",
		"unknown",
		[],
		{
			deliveryReason:
				"Claude/Ollama local can launch, but addressed channel consumption is unproven.",
			deliveryRemediation:
				"Run the real Claude/Ollama consumption journey; until then use pull-only operation.",
		},
	),
	capability(
		"claude.ollama-cloud.direct",
		"claude",
		"direct",
		"ollama_cloud",
		"*",
		"native_channel",
		"unknown",
		[],
		{
			deliveryReason:
				"Claude/Ollama cloud can launch, but addressed channel consumption is unproven.",
			deliveryRemediation:
				"Run the real Claude/Ollama consumption journey; until then use pull-only operation.",
		},
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
	const explicitLaunch = snapshot.launchContribution;
	let status: CapabilityTruth["status"] = snapshot.capability.qualification;
	if (
		!evidenceSources.has(snapshot.evidenceSource) ||
		!evidencePolicies.has(snapshot.evidencePolicy)
	)
		status = "invalid_evidence";
	else if (snapshot.evidenceSource === "registration")
		status = "registration_only";
	const observedAt = validTime(snapshot.evidenceObservedAt);
	const current = validTime(now);
	if (
		observedAt === undefined ||
		current === undefined ||
		!Number.isFinite(maxAge) ||
		maxAge < 0
	)
		status = "invalid_evidence";
	if (
		snapshot.evidencePolicy === "version_qualified" &&
		!snapshot.capability.evidence_version
	)
		status = "invalid_evidence";
	if (
		snapshot.evidencePolicy === "observed" &&
		observedAt !== undefined &&
		current !== undefined
	) {
		const age = current - observedAt;
		if (age < 0 || age > maxAge) status = "stale";
	}
	const evidenceBlockedLaunch =
		status === "invalid_evidence"
			? {
					status: "unavailable" as const,
					reason: "Launch evidence is invalid or incomplete.",
					remediation:
						snapshot.remediation ??
						"Record valid launch evidence before authorizing spawn.",
				}
			: status === "registration_only"
				? {
						status: "unavailable" as const,
						reason: "Registration is not a launch authorization.",
						remediation:
							snapshot.remediation ??
							"Record a real launch contribution before authorizing spawn.",
					}
				: undefined;
	const launch: LaunchFacts = deepFreeze(
		evidenceBlockedLaunch ??
			explicitLaunch ?? {
				status:
					status === snapshot.capability.qualification &&
					(snapshot.capability.qualification === "supported" ||
						snapshot.capability.qualification === "experimental")
						? "launchable"
						: "unavailable",
				reason:
					status === snapshot.capability.qualification &&
					(snapshot.capability.qualification === "supported" ||
						snapshot.capability.qualification === "experimental")
						? "The selected capability has a qualified launch contribution."
						: "The selected capability has no independently qualified launch contribution.",
				remediation:
					snapshot.remediation ??
					(status === snapshot.capability.qualification &&
					(snapshot.capability.qualification === "supported" ||
						snapshot.capability.qualification === "experimental")
						? "Keep the installed harness and capability contribution available."
						: "Choose a launchable capability or run its adapter preflight."),
			},
	);
	const launchable = launch.status === "launchable";
	const deliveryReadiness: DeliveryTruthReadiness =
		status === "registration_only" ||
		snapshot.capability.qualification === "unsupported"
			? "ineligible"
			: status === "invalid_evidence" || status === "stale"
				? "not_ready"
				: snapshot.capability.qualification === "supported" &&
						snapshot.capability.readiness === "ready"
					? "ready"
					: "not_ready";
	const delivery: DeliveryFacts = deepFreeze({
		mode: snapshot.capability.delivery_mode,
		qualification: snapshot.capability.qualification,
		readiness: deliveryReadiness,
		reason:
			snapshot.deliveryReason ??
			(deliveryReadiness === "ready"
				? "Delivery is qualified by the selected capability evidence."
				: "Delivery is not independently qualified by the selected capability evidence."),
		remediation:
			snapshot.deliveryRemediation ??
			(deliveryReadiness === "ready"
				? "Keep the capability evidence current."
				: "Run the real adapter consumption journey before advertising push readiness."),
	});
	return deepFreeze({
		status,
		launchable,
		remediation: launch.remediation,
		launch,
		delivery,
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
					launch: truth.launch,
					delivery: truth.delivery,
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
					launch: truth.launch,
					delivery: truth.delivery,
				};
			})
			.sort((left, right) => left.id.localeCompare(right.id)),
	);
}
