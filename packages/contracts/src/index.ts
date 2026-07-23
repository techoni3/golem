export * from "./api.js";
export * from "./browser-work.js";
export * from "./common.js";
export * from "./control.js";
export * from "./delivery.js";
export * from "./diagnostics.js";
export * from "./facts.js";
export * from "./fixtures.js";
export * from "./ids.js";
export * from "./json.js";
export * from "./launcher.js";
export * from "./legacy-projection.js";
export * from "./migration.js";
export * from "./references.js";
export * from "./registry.js";
export * from "./runtime.js";
export * from "./version.js";
export * from "./websocket.js";

/** Compatibility marker retained for the Wave 2 workspace composition seams. */
export interface ContractBoundary {
	readonly version: "v1";
}

export const contractBoundary: ContractBoundary = { version: "v1" };
