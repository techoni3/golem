import type { RuntimeBoundary } from "@golem/runtime";
import type { TrackerBoundary } from "@golem/tracker";

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
	ControlPlaneLifecycleOptions,
	ControlPlaneProjectionPort,
	StartedControlPlane,
} from "./server.js";
export {
	controlPlaneLockPath,
	controlPlanePortFromEnvironment,
	startControlPlane,
} from "./server.js";
export type { ServiceLockStatus } from "./service-lock.js";
export { serviceLockStatus } from "./service-lock.js";

export interface ControlPlaneComposition {
	readonly runtime: RuntimeBoundary;
	readonly tracker: TrackerBoundary;
}
