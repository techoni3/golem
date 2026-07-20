import { z } from "zod";

const UUID_SOURCE =
	"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function opaqueId(prefix: string) {
	return z
		.string()
		.regex(new RegExp(`^${prefix}_${UUID_SOURCE}$`, "u"), "wire.id.invalid");
}

export const ProjectIdSchema = opaqueId("prj").brand<"ProjectId">();
export const LocationIdSchema = opaqueId("loc").brand<"LocationId">();
export const SessionIdSchema = opaqueId("ses").brand<"SessionId">();
export const GenerationIdSchema = opaqueId("gen").brand<"GenerationId">();
export const EventIdSchema = opaqueId("evt").brand<"EventId">();
export const CommandIdSchema = opaqueId("cmd").brand<"CommandId">();
export const EndpointIdSchema = opaqueId("ep").brand<"EndpointId">();
export const ProducerIdSchema = opaqueId("prod").brand<"ProducerId">();
export const ActorIdSchema = opaqueId("act").brand<"ActorId">();
export const DeliveryIdSchema = opaqueId("del").brand<"DeliveryId">();
export const OperationIdSchema = opaqueId("op").brand<"OperationId">();
export const MigrationPlanIdSchema = opaqueId("mig").brand<"MigrationPlanId">();
export const ControlPlaneInstanceIdSchema =
	opaqueId("cpi").brand<"ControlPlaneInstanceId">();

export type ProjectId = z.infer<typeof ProjectIdSchema>;
export type LocationId = z.infer<typeof LocationIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type GenerationId = z.infer<typeof GenerationIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type CommandId = z.infer<typeof CommandIdSchema>;
export type EndpointId = z.infer<typeof EndpointIdSchema>;
export type ProducerId = z.infer<typeof ProducerIdSchema>;
export type ActorId = z.infer<typeof ActorIdSchema>;
export type DeliveryId = z.infer<typeof DeliveryIdSchema>;
export type OperationId = z.infer<typeof OperationIdSchema>;
export type MigrationPlanId = z.infer<typeof MigrationPlanIdSchema>;
export type ControlPlaneInstanceId = z.infer<
	typeof ControlPlaneInstanceIdSchema
>;
