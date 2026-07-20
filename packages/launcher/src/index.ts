export {
	builtInCapabilities,
	capabilityTruth,
	defaultQualificationMaxAgeMs,
} from "./capabilities.js";
export {
	loadJsoncConfig,
	mergeOpenCodeManagedRegion,
	parseJsoncConfig,
	planConfigWrite,
	writeJsoncConfig,
} from "./config.js";
export {
	failure,
	issue,
	LauncherResolutionError,
	stableLaunchPlanJson,
} from "./explain.js";
export { builtInPresets, mergeLauncherConfig } from "./presets.js";
export { doctorFacts, listLauncher, resolveLaunch } from "./resolve.js";
export type {
	Backend,
	CapabilityFact,
	CapabilitySnapshot,
	CapabilityTruth,
	CapabilityTruthStatus,
	ConfigScope,
	ConfigTextPort,
	ConfigWritePlan,
	DeliveryFlow,
	DoctorFact,
	EvidencePolicy,
	EvidenceSource,
	JsoncConfigDocument,
	LaunchExplanation,
	LauncherConfig,
	LauncherIssue,
	LauncherList,
	LaunchFailure,
	LaunchMode,
	LaunchPlan,
	LaunchPreset,
	LaunchResolution,
	LaunchSelection,
	PresetSource,
	Qualification,
	ResolveLaunchInput,
} from "./types.js";

import { parseJsoncConfig } from "./config.js";
import { doctorFacts, listLauncher, resolveLaunch } from "./resolve.js";

/** Thin read-only boundary: config persistence and process spawning remain outside. */
export interface LauncherBoundary {
	readonly parseConfig: typeof parseJsoncConfig;
	readonly resolve: typeof resolveLaunch;
	readonly list: typeof listLauncher;
	readonly doctorFacts: typeof doctorFacts;
}

export const launcherBoundary: LauncherBoundary = {
	parseConfig: parseJsoncConfig,
	resolve: resolveLaunch,
	list: listLauncher,
	doctorFacts,
};
