import type { CapabilitySnapshot } from "@golem/launcher";
import { type CapabilityTruth, capabilityTruth } from "@golem/launcher";
import type {
	OpenCodeProvider,
	OpenCodeProviderObservation,
	OpenCodeProviderQualification,
} from "./types.js";

const providerLabels: Record<OpenCodeProvider, string> = {
	openai: "OpenAI/GPT",
	ollama_cloud: "Ollama Cloud",
	ollama_local: "Ollama Local",
};

function modelPattern(
	provider: OpenCodeProvider,
	value: string | undefined,
): string {
	if (value?.trim()) return value.trim();
	return provider === "openai" ? "gpt-*" : "*";
}

function capabilityForObservation(
	observation: OpenCodeProviderObservation,
): CapabilitySnapshot {
	const available =
		observation.available &&
		(observation.provider === "ollama_local"
			? observation.daemon
			: observation.credentials);
	const consumed =
		observation.responseObserved === true &&
		observation.deliveryObserved === true;
	const qualification = consumed
		? "supported"
		: available
			? "experimental"
			: "unknown";
	const readiness = consumed ? "ready" : "uninitialized";
	const source = observation.evidenceSource ?? "real_journey";
	const policy = observation.evidencePolicy ?? "observed";
	const id = `opencode.${observation.provider === "ollama_local" ? "ollama-local" : observation.provider === "ollama_cloud" ? "ollama-cloud" : "openai"}.direct`;
	const providerLabel = providerLabels[observation.provider];
	const launchReason = available
		? `${providerLabel} provider preflight is available.`
		: `${providerLabel} provider preflight is unavailable.`;
	const launchRemediation =
		observation.provider === "ollama_local"
			? "Start the local Ollama daemon and rerun the adapter qualification journey."
			: "Configure the provider credential through the supported environment or credential provider.";
	return {
		capability: {
			capability_id: id,
			harness: "opencode",
			adapter_version: observation.version ?? "opencode-adapter-v1",
			integration_layers: ["prompt_bridge", "mcp"],
			qualification,
			delivery_mode: "prompt_bridge",
			readiness,
			evidence_version: observation.version ?? "opencode-adapter-v1",
		},
		mode: "direct",
		backend: observation.provider,
		modelPattern: modelPattern(observation.provider, observation.modelPattern),
		deliveryFlow: consumed ? "push" : "pull",
		controlFeatures: ["prompt_async", "resume", "fence"],
		executable: "opencode",
		evidenceSource: source,
		evidencePolicy: policy,
		...(observation.observedAt
			? { evidenceObservedAt: observation.observedAt }
			: {}),
		launchContribution: {
			status: available ? "launchable" : "unavailable",
			reason: launchReason,
			remediation: launchRemediation,
		},
		deliveryReason: consumed
			? `${providerLabel} prompt bridge has response and consumption evidence.`
			: `${providerLabel} launchability is independent from prompt consumption evidence.`,
		deliveryRemediation: consumed
			? "Keep the endpoint fence and response evidence current."
			: "Run the real OpenCode prompt bridge consumption journey before advertising push readiness.",
	};
}

export function opencodeProviderCapabilities(
	observations: readonly OpenCodeProviderObservation[],
): readonly CapabilitySnapshot[] {
	const byProvider = new Map(
		observations.map((observation) => [observation.provider, observation]),
	);
	return (["openai", "ollama_cloud", "ollama_local"] as const)
		.map(
			(provider) =>
				byProvider.get(provider) ?? {
					provider,
					available: false,
					credentials: false,
					daemon: false,
				},
		)
		.map(capabilityForObservation)
		.sort((left, right) =>
			left.capability.capability_id.localeCompare(
				right.capability.capability_id,
			),
		);
}

export function opencodeCapabilityTruth(
	observation: OpenCodeProviderObservation,
	now: string,
	maxAgeMs?: number,
): CapabilityTruth {
	const capability = capabilityForObservation(observation);
	return capabilityTruth(capability, now, maxAgeMs);
}

export function providerQualification(
	observation: OpenCodeProviderObservation,
	now: string,
	maxAgeMs?: number,
): OpenCodeProviderQualification {
	const capability = capabilityForObservation(observation);
	const truth = capabilityTruth(capability, now, maxAgeMs);
	return {
		provider: observation.provider,
		capability,
		launchable: truth.launchable,
		deliveryReady: truth.delivery.readiness === "ready",
		reason: truth.launch.reason,
	};
}
