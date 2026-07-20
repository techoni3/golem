import { z } from "zod";

export const WIRE_MAJOR_VERSION = 1 as const;
export const CONTRACT_SEMANTIC_VERSION = "1.0.0" as const;

export function wireVersion(schemaName: string) {
	return z.literal(`golem.${schemaName}/v${WIRE_MAJOR_VERSION}`, {
		error: "wire.version.unknown_major",
	});
}

export function schemaIdentifier(schemaName: string) {
	return `urn:golem:contracts:${schemaName}:v${WIRE_MAJOR_VERSION}`;
}
