import type { RuntimeBoundary } from "@golem/runtime";
import type { TrackerBoundary } from "@golem/tracker";

export {
	type BrowserSessionAuthority,
	type BrowserSessionClock,
	createBrowserSessionAuthority,
} from "./auth.js";
export {
	createLegacyCompatibilitySource,
	type LegacyCompatibilityFrame,
	type LegacyCompatibilityPort,
	type LegacyCompatibilityPublisher,
	type LegacyCompatibilitySource,
	registerLegacyWebSocket,
	registerStaticCompatibility,
} from "./compatibility.js";
export type {
	LaunchAgentDefinition,
	LaunchAgentInstall,
	LaunchAgentStatus,
	LaunchctlBoundary,
	LaunchctlResult,
} from "./launch-agent.js";
export {
	installLaunchAgent,
	renderLaunchAgent,
	rollbackLaunchAgent,
	startLaunchAgent,
	statusLaunchAgent,
	stopLaunchAgent,
	updateLaunchAgent,
} from "./launch-agent.js";
export { stableOpenApiJson } from "./openapi.js";
export type {
	ControlPlaneProjectionPort,
	ControlPlaneReplayEntry,
	ControlPlaneReplayPort,
	ControlPlaneReplayResult,
} from "./ports.js";
export type {
	ControlPlaneLifecycleOptions,
	StartedControlPlane,
} from "./server.js";
export {
	controlPlaneLockPath,
	controlPlanePortFromEnvironment,
	startControlPlane,
} from "./server.js";
export type { ServiceLockStatus } from "./service-lock.js";
export { serviceLockStatus } from "./service-lock.js";
export { BoundedReplayWindow } from "./ws-replay.js";

export interface ControlPlaneComposition {
	readonly runtime: RuntimeBoundary;
	readonly tracker: TrackerBoundary;
}
