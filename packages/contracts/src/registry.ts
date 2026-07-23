import { z } from "zod";

import {
	ApiCommandOutcomeV1Schema,
	ApiErrorV1Schema,
	ApiPageV1Schema,
	CommandReceiptV1Schema,
} from "./api.js";
import { ControlCommandV1Schema } from "./control.js";
import {
	DeliveryAcknowledgementV1Schema,
	DeliveryEnvelopeV1Schema,
} from "./delivery.js";
import { DiagnosticsExplanationV1Schema } from "./diagnostics.js";
import {
	CapabilityRecordSchema,
	ClockFactsSchema,
	EndpointRecordSchema,
	LifecycleFactsSchema,
	ProvenanceSchema,
} from "./facts.js";
import { type ContractFixtureName, ContractFixtures } from "./fixtures.js";
import {
	CompatibilityIngressV1Schema,
	LauncherConfigV1Schema,
	LauncherPresetSchema,
} from "./launcher.js";
import { MigrationPlanV1Schema } from "./migration.js";
import {
	ActorReferenceSchema,
	AliasReferenceSchema,
	GenerationReferenceSchema,
	ProducerReferenceSchema,
	ProjectLocationReferenceSchema,
	ProjectReferenceSchema,
	SessionReferenceSchema,
} from "./references.js";
import { RuntimeSignalV1Schema } from "./runtime.js";
import { CONTRACT_SEMANTIC_VERSION, schemaIdentifier } from "./version.js";
import { WebSocketFrameV1Schema } from "./websocket.js";

export interface ContractSchemaEntry {
	readonly name: ContractFixtureName;
	readonly schemaId: string;
	readonly wireVersion: string;
	readonly fileName: string;
	readonly schema: z.ZodType;
}

function entry(
	name: ContractFixtureName,
	schema: z.ZodType,
): ContractSchemaEntry {
	return {
		name,
		schemaId: schemaIdentifier(name),
		wireVersion: `golem.${name}/v1`,
		fileName: `${name}.schema.json`,
		schema,
	};
}

export const ContractSchemaRegistry = [
	entry("project-reference", ProjectReferenceSchema),
	entry("project-location-reference", ProjectLocationReferenceSchema),
	entry("session-reference", SessionReferenceSchema),
	entry("generation-reference", GenerationReferenceSchema),
	entry("alias-reference", AliasReferenceSchema),
	entry("actor-reference", ActorReferenceSchema),
	entry("producer-reference", ProducerReferenceSchema),
	entry("clock-facts", ClockFactsSchema),
	entry("provenance", ProvenanceSchema),
	entry("lifecycle-facts", LifecycleFactsSchema),
	entry("endpoint-record", EndpointRecordSchema),
	entry("capability-record", CapabilityRecordSchema),
	entry("runtime-signal", RuntimeSignalV1Schema),
	entry("control-command", ControlCommandV1Schema),
	entry("delivery-envelope", DeliveryEnvelopeV1Schema),
	entry("delivery-acknowledgement", DeliveryAcknowledgementV1Schema),
	entry("launcher-preset", LauncherPresetSchema),
	entry("launcher-config", LauncherConfigV1Schema),
	entry("compatibility-ingress", CompatibilityIngressV1Schema),
	entry("api-error", ApiErrorV1Schema),
	entry("api-command-outcome", ApiCommandOutcomeV1Schema),
	entry("command-receipt", CommandReceiptV1Schema),
	entry("api-page", ApiPageV1Schema),
	entry("websocket-frame", WebSocketFrameV1Schema),
	entry("migration-plan", MigrationPlanV1Schema),
	entry("diagnostics-explanation", DiagnosticsExplanationV1Schema),
] as const;

export function canonicalizeJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalizeJson);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonicalizeJson(child)]),
		);
	}
	return value;
}

export function stableJson(value: unknown) {
	return `${JSON.stringify(canonicalizeJson(value), null, 2)}\n`;
}

export function jsonSchemaDocument(entry: ContractSchemaEntry) {
	const generated = z.toJSONSchema(entry.schema, {
		target: "draft-2020-12",
		unrepresentable: "throw",
		cycles: "ref",
	});
	return canonicalizeJson({
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: entry.schemaId,
		"x-golem-contract-semver": CONTRACT_SEMANTIC_VERSION,
		"x-golem-wire-version": entry.wireVersion,
		...generated,
	});
}

export function schemaManifest() {
	return canonicalizeJson({
		format: "golem-contract-schema-registry/v1",
		contract_semantic_version: CONTRACT_SEMANTIC_VERSION,
		schemas: ContractSchemaRegistry.map((entry) => ({
			name: entry.name,
			schema_id: entry.schemaId,
			wire_version: entry.wireVersion,
			file: entry.fileName,
		})),
	});
}

export function compatibilityFixtures() {
	return canonicalizeJson({
		format: "golem-contract-compatibility-fixtures/v1",
		fixtures: ContractSchemaRegistry.map((entry) => ({
			name: entry.name,
			positive: ContractFixtures[entry.name].positive,
			negative: ContractFixtures[entry.name].negative,
		})),
	});
}
