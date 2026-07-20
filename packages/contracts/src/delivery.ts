import { z } from "zod";

import {
	EndpointReferenceBodySchema,
	GenerationReferenceBodySchema,
} from "./common.js";
import { ControlCommandV1Schema } from "./control.js";
import { DeliveryIdSchema } from "./ids.js";
import { JsonValueSchema } from "./json.js";
import { wireVersion } from "./version.js";

export const DeliveryEnvelopeV1Schema = z
	.object({
		schema_version: wireVersion("delivery-envelope"),
		delivery_id: DeliveryIdSchema,
		command: ControlCommandV1Schema,
		endpoint: EndpointReferenceBodySchema,
		generation: GenerationReferenceBodySchema,
		attempt: z.number().int().nonnegative(),
		deduplication_key: z.string().min(1).max(256),
		created_at: z.iso.datetime({ offset: true }),
		not_before_at: z.iso.datetime({ offset: true }).optional(),
		payload: JsonValueSchema,
	})
	.strict();

export const DeliveryAcknowledgementV1Schema = z
	.object({
		schema_version: wireVersion("delivery-acknowledgement"),
		delivery_id: DeliveryIdSchema,
		status: z.enum(["accepted", "completed", "rejected", "retry", "expired"]),
		acknowledged_at: z.iso.datetime({ offset: true }),
		reason_code: z.string().min(1).max(128).optional(),
		result: JsonValueSchema.optional(),
	})
	.strict();

export type DeliveryEnvelopeV1 = z.infer<typeof DeliveryEnvelopeV1Schema>;
export type DeliveryAcknowledgementV1 = z.infer<
	typeof DeliveryAcknowledgementV1Schema
>;
