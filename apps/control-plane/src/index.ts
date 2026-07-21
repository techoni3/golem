import type { RuntimeBoundary } from "@golem/runtime";
import type { TrackerBoundary } from "@golem/tracker";

export {
	type ActorContext,
	type AuthorizationPolicy,
	type BrowserPrincipalResolver,
	type BrowserSessionAuthority,
	type BrowserSessionClock,
	createAuthorizationPolicy,
	createBrowserPrincipalResolver,
	createBrowserSessionAuthority,
	createFailClosedBrowserPrincipalResolver,
	hasRequestAuthorityOverride,
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
export {
	composeManagedCodexSupervisor,
	createManagedCodexDeliveryPort,
	createManagedCodexEndpointPort,
} from "./managed-codex.js";
export {
	type ManagedCodexControl,
	type ManagedCodexControlBinding,
	type ManagedCodexControlOptions,
	startManagedCodexControl,
} from "./managed-codex-control.js";
export { stableOpenApiJson } from "./openapi.js";
export type {
	ControlPlaneProjectionPort,
	ControlPlaneReplayEntry,
	ControlPlaneReplayPort,
	ControlPlaneReplayResult,
	RuntimeProjectionPort,
} from "./ports.js";
export { composeControlPlaneProjectService } from "./projects.js";
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
export {
	composeControlPlaneEndpointEligibility,
	composeControlPlaneManagementServices,
	composeControlPlaneTrackerCoreServices,
	composeControlPlaneTrackerServices,
} from "./tracker.js";
export { registerTrackerCoreCompatibilityRoutes } from "./tracker-core-routes.js";
export { BoundedReplayWindow } from "./ws-replay.js";

export interface ControlPlaneComposition {
	readonly runtime: RuntimeBoundary;
	readonly tracker: TrackerBoundary;
}
