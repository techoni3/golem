import type { RuntimeBoundary } from "@golem/runtime";
import type { TrackerBoundary } from "@golem/tracker";

export { openControlPlanePersistence } from "./persistence.js";

export interface ControlPlaneComposition {
	readonly runtime: RuntimeBoundary;
	readonly tracker: TrackerBoundary;
}
