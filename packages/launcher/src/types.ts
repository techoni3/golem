import type {
	CapabilityRecord,
	DeliveryMode,
	DeliveryReadiness,
	Harness,
} from "@golem/contracts";

export type Backend =
	| "openai"
	| "anthropic"
	| "ollama_local"
	| "ollama_cloud"
	| "native";
export type LaunchMode = "direct" | "managed";
export type Qualification = CapabilityRecord["qualification"];
export type CapabilityFact = Omit<CapabilityRecord, "schema_version">;
export type ConfigScope = "user" | "project";
export type PresetSource =
	| "built_in"
	| "user_default"
	| "project_default"
	| "invoked_scoped"
	| "invoked_global";
export type EvidenceSource =
	| "built_in"
	| "real_journey"
	| "manual_probe"
	| "registration";
export type EvidencePolicy = "observed" | "version_qualified";
export type DeliveryFlow = "push" | "pull" | "next_turn";
export type CapabilityTruthStatus =
	| Qualification
	| "stale"
	| "registration_only"
	| "invalid_evidence";

export const backends = new Set<Backend>([
	"openai",
	"anthropic",
	"ollama_local",
	"ollama_cloud",
	"native",
]);
export const harnesses = new Set<Harness>([
	"claude",
	"codex",
	"opencode",
	"pi",
]);
export const modes = new Set<LaunchMode>(["direct", "managed"]);

export interface LaunchPreset {
	readonly name: string;
	readonly harness: Harness;
	readonly backend: Backend;
	readonly model_selector: string;
	readonly delivery_mode: DeliveryMode;
	readonly native_args: readonly string[];
	readonly env_key_refs: readonly string[];
	readonly binary_override?: string;
}

export interface LauncherConfig {
	readonly schemaVersion: "golem.launcher-config/v1";
	readonly harnessDefaults: Readonly<Partial<Record<Harness, string>>>;
	readonly presets: readonly LaunchPreset[];
}

export interface LauncherIssue {
	readonly code: string;
	readonly severity: "info" | "warning" | "error";
	readonly message: string;
	readonly remediation: readonly string[];
}

export interface JsoncConfigDocument {
	readonly scope: ConfigScope;
	readonly text: string;
	readonly config: LauncherConfig;
	readonly userOwned: Readonly<Record<string, unknown>>;
	readonly warnings: readonly LauncherIssue[];
}

/** Atomic config mutation is injected; production code never imports filesystem APIs. */
export interface ConfigTextPort {
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

/** Safe-to-log write intent: raw config text stays inside the supplied port. */
export interface ConfigWritePlan {
	readonly targetPath: string;
	readonly backupPath: string;
	readonly temporaryPath: string;
	readonly preserveUnknownRegions: true;
	readonly sourceBytes: number;
	readonly nextBytes: number;
}

export interface CapabilitySnapshot {
	readonly capability: CapabilityFact;
	readonly mode: LaunchMode;
	readonly backend: Backend;
	readonly modelPattern: string;
	readonly deliveryFlow: DeliveryFlow;
	readonly controlFeatures: readonly string[];
	readonly executable: string;
	readonly evidenceSource: EvidenceSource;
	readonly evidencePolicy: EvidencePolicy;
	readonly evidenceObservedAt?: string;
	readonly remediation?: string;
}

export interface CapabilityTruth {
	readonly status: CapabilityTruthStatus;
	readonly launchable: boolean;
	readonly remediation: string;
}

export interface LaunchSelection {
	readonly harness: Harness;
	readonly mode: LaunchMode;
	readonly backend: Backend;
	readonly modelSelector: string;
	readonly deliveryMode: DeliveryMode;
	readonly adapterId: string;
	readonly executable: string;
}

export interface LaunchExplanation {
	readonly code: string;
	readonly source: PresetSource | "explicit" | "capability" | "input";
	readonly detail: string;
}

export interface LaunchPlan {
	readonly schemaVersion: "golem.launch-plan/v1";
	readonly ok: true;
	readonly selection: LaunchSelection;
	readonly preset: { readonly name: string; readonly source: PresetSource };
	readonly executableRequirement: {
		readonly path: string;
		readonly mode: LaunchMode;
	};
	readonly environmentKeyRefs: readonly string[];
	readonly effectiveArgvIntent: readonly string[];
	readonly qualification: {
		readonly status: Qualification;
		readonly source: EvidenceSource;
		readonly policy: EvidencePolicy;
		readonly version?: string;
		readonly observedAt: string;
	};
	/** Keep delivery, readiness, app-server, and control distinctions observable. */
	readonly capabilityFacts: {
		readonly deliveryMode: DeliveryMode;
		readonly deliveryFlow: DeliveryFlow;
		readonly readiness: DeliveryReadiness;
		readonly integrationLayers: readonly string[];
		readonly controlFeatures: readonly string[];
	};
	readonly warnings: readonly LauncherIssue[];
	readonly trace: readonly LaunchExplanation[];
}

export interface LaunchFailure {
	readonly schemaVersion: "golem.launch-plan/v1";
	readonly ok: false;
	readonly error: LauncherIssue;
	readonly trace: readonly LaunchExplanation[];
}

export type LaunchResolution = LaunchPlan | LaunchFailure;

export interface ResolveLaunchInput {
	readonly harness?: Harness;
	readonly preset?: string;
	readonly globalPreset?: string;
	readonly explicit?: Readonly<
		Partial<{
			harness: Harness;
			mode: LaunchMode;
			backend: Backend;
			modelSelector: string;
			deliveryMode: DeliveryMode;
		}>
	>;
	readonly passthrough?: readonly string[];
	readonly isTTY: boolean;
	readonly now: string;
	readonly qualificationMaxAgeMs?: number;
	readonly user?: JsoncConfigDocument;
	readonly project?: JsoncConfigDocument;
	readonly capabilities?: readonly CapabilitySnapshot[];
}

export interface LauncherList {
	readonly presets: readonly {
		readonly name: string;
		readonly harness: Harness;
		readonly backend: Backend;
		readonly modelSelector: string;
	}[];
	readonly capabilities: readonly {
		readonly id: string;
		readonly harness: Harness;
		readonly mode: LaunchMode;
		readonly backend: Backend;
		readonly qualification: CapabilityTruthStatus;
		readonly launchable: boolean;
		readonly deliveryMode: DeliveryMode;
		readonly deliveryFlow: DeliveryFlow;
		readonly readiness: DeliveryReadiness;
		readonly controlFeatures: readonly string[];
		readonly evidenceSource: EvidenceSource;
		readonly evidencePolicy: EvidencePolicy;
		readonly evidenceVersion?: string;
		readonly observedAt?: string;
	}[];
	readonly issues: readonly LauncherIssue[];
}

export interface DoctorFact {
	readonly id: string;
	readonly harness: Harness;
	readonly mode: LaunchMode;
	readonly backend: Backend;
	readonly qualification: CapabilityTruthStatus;
	readonly launchable: boolean;
	readonly deliveryMode: DeliveryMode;
	readonly deliveryFlow: DeliveryFlow;
	readonly readiness: DeliveryReadiness;
	readonly integrationLayers: readonly string[];
	readonly controlFeatures: readonly string[];
	readonly evidenceSource: EvidenceSource;
	readonly evidencePolicy: EvidencePolicy;
	readonly evidenceVersion?: string;
	readonly observedAt?: string;
	readonly remediation: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>))
			deepFreeze(child);
	}
	return value;
}
