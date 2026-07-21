import type { AdapterBoundary } from "@golem/adapter-sdk";

export {
	type CodexDirectCapability,
	type CodexDirectEvent,
	type CodexDirectIdentity,
	type CodexDirectLifecycleState,
	codexDirectCapability,
	codexEventId,
	codexGenerationId,
	codexIdentity,
	codexProducerId,
	codexProjectId,
	codexRuntimeSignal,
	codexSessionId,
} from "./direct/index.js";
export * from "./managed/index.js";

export interface CodexAdapterBoundary {
	readonly adapter: AdapterBoundary;
}
