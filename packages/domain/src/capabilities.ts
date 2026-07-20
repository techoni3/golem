import type { DeliveryMode, DeliveryReadiness } from "@golem/contracts";
import { explanation } from "./explain.js";
import type { CapabilityFact, DomainExplanation } from "./types.js";

export interface CapabilityResolution {
	readonly deliveryMode: DeliveryMode;
	readonly readiness: DeliveryReadiness;
	readonly explanation: DomainExplanation;
}

export function resolveCapability(
	capability: CapabilityFact,
): CapabilityResolution {
	if (
		capability.qualification === "unsupported" ||
		capability.qualification === "unknown"
	)
		return {
			deliveryMode: capability.delivery_mode,
			readiness: "unsupported",
			explanation: explanation("domain.capability.qualified", "warning", {
				qualification: capability.qualification,
				readiness: "unsupported",
			}),
		};
	if (capability.delivery_mode === "pull")
		return {
			deliveryMode: capability.delivery_mode,
			readiness: "pull_only",
			explanation: explanation("domain.capability.qualified", "info", {
				deliveryMode: "pull",
				readiness: "pull_only",
			}),
		};
	if (capability.delivery_mode === "next_turn")
		return {
			deliveryMode: capability.delivery_mode,
			readiness: "next_turn",
			explanation: explanation("domain.capability.qualified", "info", {
				deliveryMode: "next_turn",
				readiness: "next_turn",
			}),
		};
	return {
		deliveryMode: capability.delivery_mode,
		readiness: capability.readiness,
		explanation: explanation("domain.capability.qualified", "info", {
			deliveryMode: capability.delivery_mode,
			readiness: capability.readiness,
		}),
	};
}
