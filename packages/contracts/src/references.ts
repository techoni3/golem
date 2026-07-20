import { z } from "zod";

import {
	ActorReferenceBodySchema,
	AliasReferenceBodySchema,
	GenerationReferenceBodySchema,
	ProducerReferenceBodySchema,
	ProjectLocationReferenceBodySchema,
	ProjectReferenceBodySchema,
	SessionReferenceBodySchema,
} from "./common.js";
import { wireVersion } from "./version.js";

export const ProjectReferenceSchema = z
	.object({
		schema_version: wireVersion("project-reference"),
		...ProjectReferenceBodySchema.shape,
	})
	.strict();

export const ProjectLocationReferenceSchema = z
	.object({
		schema_version: wireVersion("project-location-reference"),
		...ProjectLocationReferenceBodySchema.shape,
	})
	.strict();

export const SessionReferenceSchema = z
	.object({
		schema_version: wireVersion("session-reference"),
		...SessionReferenceBodySchema.shape,
	})
	.strict();

export const GenerationReferenceSchema = z
	.object({
		schema_version: wireVersion("generation-reference"),
		...GenerationReferenceBodySchema.shape,
	})
	.strict();

export const AliasReferenceSchema = z
	.object({
		schema_version: wireVersion("alias-reference"),
		...AliasReferenceBodySchema.shape,
	})
	.strict()
	.superRefine((value, context) => {
		if (value.session && value.session.project_id !== value.project_id) {
			context.addIssue({
				code: "custom",
				message: "wire.alias.cross_scope",
				path: ["session", "project_id"],
			});
		}
	});

export const ActorReferenceSchema = z
	.object({
		schema_version: wireVersion("actor-reference"),
		...ActorReferenceBodySchema.shape,
	})
	.strict();

export const ProducerReferenceSchema = z
	.object({
		schema_version: wireVersion("producer-reference"),
		...ProducerReferenceBodySchema.shape,
	})
	.strict();

export type ProjectReferenceEnvelope = z.infer<typeof ProjectReferenceSchema>;
export type ProjectLocationReferenceEnvelope = z.infer<
	typeof ProjectLocationReferenceSchema
>;
export type SessionReferenceEnvelope = z.infer<typeof SessionReferenceSchema>;
export type GenerationReferenceEnvelope = z.infer<
	typeof GenerationReferenceSchema
>;
export type AliasReferenceEnvelope = z.infer<typeof AliasReferenceSchema>;
export type ActorReferenceEnvelope = z.infer<typeof ActorReferenceSchema>;
export type ProducerReferenceEnvelope = z.infer<typeof ProducerReferenceSchema>;
