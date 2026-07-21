import type { AdapterBoundary } from "@golem/adapter-sdk";
import { contractBoundary } from "@golem/contracts";
import { FencedOpenCodeBridge } from "./bridge.js";
import { setupOpenCodeConfig } from "./config.js";
import { OpenCodeEventAdapter } from "./events.js";
import {
	opencodeCapabilityTruth,
	opencodeProviderCapabilities,
	providerQualification,
} from "./providers.js";
import type {
	OpenCodeAdapterOptions,
	OpenCodeBridgePort,
	OpenCodeConfigSetup,
	OpenCodeDeliveryRequest,
	OpenCodeDeliveryResult,
	OpenCodeEvent,
	OpenCodeFence,
	OpenCodeProviderObservation,
	OpenCodeProviderQualification,
	OpenCodeSessionInfo,
} from "./types.js";

export * from "./bridge.js";
export * from "./config.js";
export * from "./events.js";
export * from "./providers.js";
export * from "./types.js";

export interface OpenCodeAdapterBoundary {
	readonly adapter: AdapterBoundary;
}

export interface OpenCodeDispatchableFacts {
	readonly sessionId: string;
	readonly harness: "opencode";
	readonly child: false;
	readonly eligible: true;
	readonly generationId: string;
	readonly ownerFence: string;
}

/**
 * Typed OpenCode edge. It emits canonical signals and delegates lifecycle,
 * endpoint fencing, persistence, and delivery eligibility to injected owners.
 */
export class OpenCodeAdapter {
	readonly #events: OpenCodeEventAdapter;
	readonly #options: OpenCodeAdapterOptions;

	constructor(options: OpenCodeAdapterOptions) {
		this.#options = options;
		this.#events = new OpenCodeEventAdapter(options);
	}

	consume(event: OpenCodeEvent) {
		return this.#events.consume(event);
	}

	bridge(input: {
		readonly sessionId: string;
		readonly port: OpenCodeBridgePort;
		readonly fence?: OpenCodeFence;
	}): FencedOpenCodeBridge {
		return new FencedOpenCodeBridge(input);
	}

	setupConfig(input: {
		readonly path: string;
		readonly observations: readonly OpenCodeProviderObservation[];
		readonly apply?: boolean;
	}): Promise<OpenCodeConfigSetup> {
		return setupOpenCodeConfig(input);
	}

	stateFor(rawSessionId: string) {
		return this.#events.stateFor(rawSessionId);
	}

	get projectId(): string {
		return this.#options.projectId;
	}
}

export function openCodeProviderCapabilities(
	observations: readonly OpenCodeProviderObservation[],
) {
	return opencodeProviderCapabilities(observations);
}

export function qualifyOpenCodeProvider(
	observation: OpenCodeProviderObservation,
	now: string,
	maxAgeMs?: number,
): OpenCodeProviderQualification {
	return providerQualification(observation, now, maxAgeMs);
}

export function openCodeCapabilityTruth(
	observation: OpenCodeProviderObservation,
	now: string,
	maxAgeMs?: number,
) {
	return opencodeCapabilityTruth(observation, now, maxAgeMs);
}

export function dispatchableOpenCodeSession(
	info: OpenCodeSessionInfo,
	fence: OpenCodeFence | undefined,
): OpenCodeDispatchableFacts | undefined {
	if (info.parentID || !fence?.eligible) return undefined;
	return {
		sessionId: info.id,
		harness: "opencode",
		child: false,
		eligible: true,
		generationId: fence.generationId,
		ownerFence: fence.ownerFence,
	};
}

export const openCodeAdapterBoundary: OpenCodeAdapterBoundary = {
	adapter: {
		contract: contractBoundary,
	},
};

export type { OpenCodeDeliveryRequest, OpenCodeDeliveryResult };
