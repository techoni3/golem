/** Thin public façade; composition remains in lifecycle/auth/routes/WS modules. */
export type {
	ControlPlaneLifecycleOptions,
	StartedControlPlane,
} from "./lifecycle.js";
export {
	controlPlaneLockPath,
	controlPlanePortFromEnvironment,
	startControlPlane,
} from "./lifecycle.js";
