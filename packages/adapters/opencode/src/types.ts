import type { RuntimeSignalV1 } from "@golem/contracts";
import type { CapabilitySnapshot } from "@golem/launcher";

export type OpenCodeProvider = "openai" | "ollama_cloud" | "ollama_local";

export interface OpenCodeSessionInfo {
	readonly id: string;
	readonly parentID?: string;
	readonly directory?: string;
	readonly title?: string;
	readonly model?: string;
}

export interface OpenCodeEvent {
	readonly type: string;
	readonly properties?: Readonly<Record<string, unknown>>;
}

export interface OpenCodeAdapterOptions {
	readonly projectId: string;
	readonly producerInstanceId: string;
	readonly producer?: string;
	readonly now?: () => string;
}

export interface OpenCodeSignalContext {
	readonly projectId: string;
	readonly producerInstanceId: string;
	readonly producer?: string;
	readonly now?: () => string;
	readonly generationBySession?: ReadonlyMap<string, string>;
}

export interface OpenCodeBridgePort {
	readonly promptAsync: (input: {
		readonly sessionId: string;
		readonly text: string;
		readonly throwOnError: true;
	}) => Promise<{ readonly accepted: boolean; readonly receipt?: string }>;
	readonly control?: (input: {
		readonly sessionId: string;
		readonly action: "interrupt" | "halt" | "resume";
	}) => Promise<{ readonly accepted: boolean }>;
}

export interface OpenCodeFence {
	readonly generationId: string;
	readonly ownerFence: string;
	readonly eligible: boolean;
}

export interface OpenCodeDeliveryRequest {
	readonly deliveryId: string;
	readonly sessionId: string;
	readonly text: string;
	readonly fence: OpenCodeFence;
}

export interface OpenCodeDeliveryResult {
	readonly status: "accepted" | "rejected" | "retry";
	readonly code: string;
	readonly receipt?: string;
}

export interface OpenCodeProviderObservation {
	readonly provider: OpenCodeProvider;
	readonly modelPattern?: string;
	readonly version?: string;
	readonly available: boolean;
	readonly credentials: boolean;
	readonly daemon: boolean;
	readonly responseObserved?: boolean;
	readonly deliveryObserved?: boolean;
	readonly evidenceSource?:
		| "built_in"
		| "real_journey"
		| "manual_probe"
		| "registration";
	readonly evidencePolicy?: "observed" | "version_qualified";
	readonly observedAt?: string;
}

export interface OpenCodeProviderQualification {
	readonly provider: OpenCodeProvider;
	readonly capability: CapabilitySnapshot;
	readonly launchable: boolean;
	readonly deliveryReady: boolean;
	readonly reason: string;
}

export interface OpenCodeConfigPort {
	readonly readText: (path: string) => Promise<string | undefined>;
	readonly writeBackup: (path: string, text: string) => Promise<void>;
	readonly writeTemporary: (path: string, text: string) => Promise<void>;
	readonly commitTemporary: (
		temporaryPath: string,
		targetPath: string,
	) => Promise<void>;
	readonly rollback: (targetPath: string, backupPath: string) => Promise<void>;
	readonly removeTemporary: (path: string) => Promise<void>;
}

export interface OpenCodeConfigSetup {
	readonly targetPath: string;
	readonly managedPath: readonly string[];
	readonly sourceBytes: number;
	readonly nextBytes: number;
	readonly changed: boolean;
	readonly dryRun: boolean;
	readonly text: string;
}

export type OpenCodeRuntimeSignal = RuntimeSignalV1;
