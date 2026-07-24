#!/usr/bin/env node

// packages/compat/dist/apply/service.js
import { createHash as createHash4 } from "node:crypto";
import fs8 from "node:fs";
import path8 from "node:path";

// packages/contracts/dist/api.js
import { z as z4 } from "zod";

// packages/contracts/dist/ids.js
import { z } from "zod";
var UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
function opaqueId(prefix) {
  return z.string().regex(new RegExp(`^${prefix}_${UUID_SOURCE}$`, "u"), "wire.id.invalid");
}
var ProjectIdSchema = opaqueId("prj").brand();
var LocationIdSchema = opaqueId("loc").brand();
var SessionIdSchema = opaqueId("ses").brand();
var GenerationIdSchema = opaqueId("gen").brand();
var EventIdSchema = opaqueId("evt").brand();
var CommandIdSchema = opaqueId("cmd").brand();
var EndpointIdSchema = opaqueId("ep").brand();
var ProducerIdSchema = opaqueId("prod").brand();
var ActorIdSchema = opaqueId("act").brand();
var DeliveryIdSchema = opaqueId("del").brand();
var OperationIdSchema = opaqueId("op").brand();
var MigrationPlanIdSchema = opaqueId("mig").brand();
var ControlPlaneInstanceIdSchema = opaqueId("cpi").brand();

// packages/contracts/dist/json.js
import { z as z2 } from "zod";
var JsonValueSchema = z2.json();
var JsonObjectSchema = z2.record(z2.string(), JsonValueSchema);

// packages/contracts/dist/version.js
import { z as z3 } from "zod";
var WIRE_MAJOR_VERSION = 1;
function wireVersion(schemaName) {
  return z3.literal(`golem.${schemaName}/v${WIRE_MAJOR_VERSION}`, {
    error: "wire.version.unknown_major"
  });
}
function schemaIdentifier(schemaName) {
  return `urn:golem:contracts:${schemaName}:v${WIRE_MAJOR_VERSION}`;
}

// packages/contracts/dist/api.js
var ApiErrorV1Schema = z4.object({
  schema_version: wireVersion("api-error"),
  code: z4.string().min(1).max(128),
  message: z4.string().min(1).max(1024),
  correlation_id: z4.string().min(1).max(128),
  details: JsonObjectSchema.optional()
}).strict();
var ApiCommandOutcomeStatusV1Schema = z4.enum([
  "accepted",
  "completed",
  "rejected",
  "conflict",
  "pending",
  "idempotency_mismatch"
]);
var ApiCommandOutcomeV1Schema = z4.object({
  schema_version: wireVersion("api-command-outcome"),
  command_id: CommandIdSchema,
  status: ApiCommandOutcomeStatusV1Schema,
  reason_code: z4.string().min(1).max(128).optional(),
  operation_id: OperationIdSchema.optional(),
  result: JsonValueSchema.optional()
}).strict();
var ApiPageV1Schema = z4.object({
  schema_version: wireVersion("api-page"),
  items: z4.array(JsonValueSchema),
  next_cursor: z4.string().min(1).max(512).nullable(),
  total: z4.number().int().nonnegative().optional()
}).strict();
var CommandReceiptV1Schema = z4.object({
  schema_version: wireVersion("command-receipt"),
  command_id: CommandIdSchema,
  idempotency_key: z4.string().min(1).max(256),
  command_kind: z4.string().min(1).max(128),
  actor_id: z4.string().min(1).max(256),
  project_id: z4.string().min(1).max(256),
  resource_type: z4.string().min(1).max(64),
  resource_id: z4.string().min(1).max(256),
  correlation_id: z4.string().min(1).max(128),
  fingerprint: z4.string().min(1).max(128),
  outcome: ApiCommandOutcomeV1Schema,
  committed_at: z4.string().min(1).max(64)
}).strict();
var CommandFingerprintInputV1Schema = z4.object({
  command_kind: z4.string().min(1).max(128),
  project_id: z4.string().min(1).max(256),
  resource_type: z4.string().min(1).max(64),
  resource_id: z4.string().min(1).max(256),
  payload: JsonValueSchema
}).strict();

// packages/contracts/dist/browser-settings.js
import { z as z5 } from "zod";
var BrowserSettingsTimestampSchema = z5.iso.datetime({ offset: true });
var BrowserSettingsTextSchema = z5.string().min(1).max(512);
var BrowserSettingsPlanHashSchema = z5.string().regex(/^sha256:[a-f0-9]{64}$/u);
var BrowserSettingsHarnessSchema = z5.enum([
  "claude",
  "codex",
  "opencode",
  "pi"
]);
var BrowserSettingsBackendSchema = z5.enum([
  "openai",
  "anthropic",
  "ollama_local",
  "ollama_cloud",
  "native"
]);
var BrowserSettingsDeliveryModeSchema = z5.enum([
  "pull",
  "native_channel",
  "prompt_bridge",
  "managed_app_server",
  "next_turn"
]);
var BrowserSettingsTargetSchema = z5.enum([
  "cc",
  "cc-marketplace",
  "codex",
  "opencode",
  "pi"
]);
var BrowserSettingsProviderSchema = z5.enum([
  "openai",
  "ollama_cloud",
  "ollama_local"
]);
var BrowserSettingsServiceActionSchema = z5.enum([
  "start",
  "stop",
  "restart",
  "install",
  "update",
  "rollback"
]);
var BrowserSettingsServiceSchema = z5.object({
  installed: z5.boolean(),
  process: z5.enum(["running", "stopped", "unknown"]),
  api: z5.enum(["ready", "unavailable"]),
  delivery: z5.enum([
    "ready",
    "held",
    "pull_only",
    "next_turn",
    "unavailable"
  ]),
  actions: z5.array(BrowserSettingsServiceActionSchema).max(6)
}).strict();
var BrowserSettingsRenderSchema = z5.object({
  target: BrowserSettingsTargetSchema,
  status: z5.enum(["clean", "drift", "tamper", "missing", "error"]),
  version: z5.string().min(1).max(128).optional(),
  managed_files: z5.array(z5.string().min(1).max(256)).max(500),
  rollback_available: z5.boolean()
}).strict();
var BrowserSettingsCapabilitySchema = z5.object({
  opaque_id: z5.string().min(1).max(128),
  harness: BrowserSettingsHarnessSchema,
  backend: BrowserSettingsBackendSchema,
  model_pattern: z5.string().min(1).max(256),
  binary: z5.enum(["available", "unavailable"]),
  provider: z5.enum(["configured", "unconfigured", "not_applicable"]),
  model: z5.enum(["supported", "experimental", "unknown", "unsupported"]),
  qualification: z5.enum([
    "supported",
    "experimental",
    "unknown",
    "unsupported",
    "stale",
    "registration_only",
    "invalid_evidence"
  ]),
  endpoint: z5.enum(["healthy", "degraded", "absent"]),
  delivery: z5.enum([
    "ready",
    "not_ready",
    "ineligible",
    "pull_only",
    "next_turn"
  ]),
  evidence_version: z5.string().min(1).max(128).optional(),
  evidence_at: BrowserSettingsTimestampSchema.optional(),
  remedy: BrowserSettingsTextSchema
}).strict();
var BrowserSettingsPresetSchema = z5.object({
  name: z5.string().min(1).max(64),
  harness: BrowserSettingsHarnessSchema,
  backend: BrowserSettingsBackendSchema,
  model_selector: z5.string().min(1).max(256),
  source: z5.enum(["built_in", "user"])
}).strict();
var BrowserSettingsProviderSchemaView = z5.object({
  provider: BrowserSettingsProviderSchema,
  configured: z5.boolean(),
  qualification: z5.enum([
    "supported",
    "experimental",
    "unknown",
    "unsupported"
  ]),
  delivery_ready: z5.boolean(),
  rollback_available: z5.boolean()
}).strict();
var BrowserSettingsMigrationSchema = z5.object({
  status: z5.enum([
    "not_planned",
    "ready",
    "review_required",
    "applied",
    "rolled_back",
    "failed"
  ]),
  plan_hash: BrowserSettingsPlanHashSchema.optional(),
  create: z5.number().int().nonnegative(),
  attach: z5.number().int().nonnegative(),
  review: z5.number().int().nonnegative(),
  quarantine: z5.number().int().nonnegative(),
  backup_available: z5.boolean(),
  rollback_available: z5.boolean()
}).strict();
var BrowserSettingsCutoverSchema = z5.object({
  status: z5.enum([
    "not_ready",
    "ready",
    "blocked",
    "quiesced",
    "checkpointed",
    "soaking",
    "stable",
    "rollback_required",
    "rolled_back",
    "failed"
  ]),
  plan_hash: BrowserSettingsPlanHashSchema.optional(),
  canonical_revision: z5.number().int().nonnegative(),
  failed_gates: z5.array(z5.string().min(1).max(128)).max(32),
  rollback_available: z5.boolean()
}).strict();
var BrowserSettingsAuditSchema = z5.object({
  command_id: z5.string().min(1).max(128),
  command_kind: z5.string().min(1).max(128),
  status: z5.enum(["pending", "completed", "rejected", "failed"]),
  created_at: BrowserSettingsTimestampSchema,
  completed_at: BrowserSettingsTimestampSchema.optional()
}).strict();
var BrowserSettingsSnapshotSchema = z5.object({
  schema_version: z5.literal("golem.browser-settings/v1"),
  revision: z5.number().int().nonnegative(),
  service: BrowserSettingsServiceSchema,
  renders: z5.array(BrowserSettingsRenderSchema).max(5),
  capabilities: z5.array(BrowserSettingsCapabilitySchema).max(100),
  providers: z5.array(BrowserSettingsProviderSchemaView).max(3),
  presets: z5.array(BrowserSettingsPresetSchema).max(100),
  migration: BrowserSettingsMigrationSchema,
  cutover: BrowserSettingsCutoverSchema,
  unknown_config_keys_preserved: z5.boolean(),
  unknown_config_key_count: z5.number().int().nonnegative().max(1e4),
  audit: z5.array(BrowserSettingsAuditSchema).max(50)
}).strict();
var BrowserSettingsCommandBaseSchema = z5.object({
  idempotency_key: z5.string().min(1).max(256)
});
var BrowserSettingsConfirmedSchema = z5.object({
  plan_hash: BrowserSettingsPlanHashSchema,
  confirm: z5.literal(true)
});
var BrowserSettingsPresetInputSchema = z5.object({
  name: z5.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
  harness: BrowserSettingsHarnessSchema,
  backend: BrowserSettingsBackendSchema,
  model_selector: z5.string().min(1).max(256),
  delivery_mode: BrowserSettingsDeliveryModeSchema
}).strict();
var BrowserSettingsCommandRequestSchema = z5.discriminatedUnion("kind", [
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("render.preview"),
    target: BrowserSettingsTargetSchema
  }).strict(),
  BrowserSettingsCommandBaseSchema.merge(BrowserSettingsConfirmedSchema).extend({
    kind: z5.literal("render.apply"),
    target: BrowserSettingsTargetSchema
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("render.rollback"),
    target: BrowserSettingsTargetSchema,
    confirm: z5.literal(true)
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("service.preview"),
    action: BrowserSettingsServiceActionSchema
  }).strict(),
  BrowserSettingsCommandBaseSchema.merge(BrowserSettingsConfirmedSchema).extend({
    kind: z5.literal("service.apply"),
    action: BrowserSettingsServiceActionSchema
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("provider.preview"),
    provider: BrowserSettingsProviderSchema
  }).strict(),
  BrowserSettingsCommandBaseSchema.merge(BrowserSettingsConfirmedSchema).extend({
    kind: z5.literal("provider.apply"),
    provider: BrowserSettingsProviderSchema
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("provider.rollback"),
    provider: BrowserSettingsProviderSchema,
    confirm: z5.literal(true)
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("preset.preview"),
    preset: BrowserSettingsPresetInputSchema
  }).strict(),
  BrowserSettingsCommandBaseSchema.merge(BrowserSettingsConfirmedSchema).extend({
    kind: z5.literal("preset.apply"),
    preset: BrowserSettingsPresetInputSchema
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("preset.rollback"),
    confirm: z5.literal(true)
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("migration.preview")
  }).strict(),
  BrowserSettingsCommandBaseSchema.merge(BrowserSettingsConfirmedSchema).extend({
    kind: z5.literal("migration.apply")
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("migration.rollback"),
    confirm: z5.literal(true)
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("cutover.preview")
  }).strict(),
  BrowserSettingsCommandBaseSchema.merge(BrowserSettingsConfirmedSchema).extend({
    kind: z5.literal("cutover.apply")
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("cutover.soak"),
    confirm: z5.literal(true)
  }).strict(),
  BrowserSettingsCommandBaseSchema.extend({
    kind: z5.literal("cutover.rollback"),
    confirm: z5.literal(true)
  }).strict()
]);
var BrowserSettingsCommandResultSchema = z5.object({
  command_kind: z5.string().min(1).max(128),
  outcome: z5.enum(["previewed", "applied", "rolled_back"]),
  summary: BrowserSettingsTextSchema,
  plan_hash: BrowserSettingsPlanHashSchema.optional(),
  changed: z5.boolean(),
  affected: z5.array(z5.string().min(1).max(256)).max(500),
  rollback_available: z5.boolean(),
  snapshot_revision: z5.number().int().nonnegative()
}).strict();
var BrowserSettingsCommandResponseSchema = z5.object({
  schema_version: z5.literal("golem.browser-settings-command/v1"),
  command_id: z5.string().min(1).max(128),
  status: z5.enum(["pending", "completed"]),
  result: BrowserSettingsCommandResultSchema.optional()
}).strict();
var BrowserSettingsErrorSchema = z5.object({
  schema_version: z5.literal("golem.browser-settings-error/v1"),
  code: z5.enum([
    "browser.auth.required",
    "browser.forbidden",
    "browser.settings.invalid",
    "browser.settings.conflict",
    "browser.settings.unavailable",
    "command.idempotency_mismatch"
  ]),
  correlation_id: z5.string().min(1).max(128)
}).strict();

// packages/contracts/dist/browser-work.js
import { z as z6 } from "zod";
var BrowserOpaqueIdSchema = z6.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u).max(128);
var BrowserTimestampSchema = z6.iso.datetime({ offset: true });
var BrowserTicketKindSchema = z6.enum([
  "work-item",
  "spec",
  "question",
  "decision",
  "fix"
]);
var BrowserTicketStateSchema = z6.enum([
  "todo",
  "in_progress",
  "blocked",
  "review",
  "done",
  "archived"
]);
var BrowserTicketPrioritySchema = z6.enum(["P0", "P1", "P2", "P3"]);
var BrowserTitleSchema = z6.string().min(1).max(256);
var BrowserBodySchema = z6.string().max(16384);
var BrowserLabelSchema = z6.string().min(1).max(64);
var BrowserPhaseSchema = z6.string().min(1).max(64);
var BrowserOperationStatusSchema = z6.enum([
  "queued",
  "ineligible",
  "delivered"
]);
var BrowserWorkStreamSchema = z6.enum([
  "tracker.board",
  "tracker.tree",
  "management.controls",
  "communication.operations"
]);
var BrowserWorkProjectionCursorSchema = z6.string().regex(/^bwp_[0-9]{1,8}$/u).max(12);
var BrowserWorkProjectionQuerySchema = z6.object({ cursor: BrowserWorkProjectionCursorSchema.optional() }).strict();
var BrowserWorkTicketSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  kind: BrowserTicketKindSchema,
  title: BrowserTitleSchema,
  state: BrowserTicketStateSchema,
  phase: BrowserPhaseSchema,
  priority: BrowserTicketPrioritySchema.nullable(),
  labels: z6.array(BrowserLabelSchema).max(32),
  parent_opaque_id: BrowserOpaqueIdSchema.optional(),
  stream_opaque_id: BrowserOpaqueIdSchema.optional(),
  wave: z6.number().int().positive().max(1e4).optional(),
  legal_phases: z6.array(BrowserPhaseSchema).max(16),
  has_assignee: z6.boolean(),
  revision: z6.number().int().positive(),
  updated_at: BrowserTimestampSchema
}).strict();
var BrowserWorkTreeTicketSchema = BrowserWorkTicketSchema;
var BrowserWorkRoleSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  name: z6.string().min(1).max(128),
  scope: z6.enum(["project", "session", "generation"]),
  revision: z6.number().int().positive(),
  updated_at: BrowserTimestampSchema
}).strict();
var BrowserWorkGateSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  gate_kind: z6.enum(["approval", "input"]),
  status: z6.enum(["awaiting", "approved", "denied", "cancelled"]),
  question: z6.string().min(1).max(4096),
  assignee_kind: z6.enum(["human", "operator"]),
  updated_at: BrowserTimestampSchema
}).strict();
var BrowserWorkIdeaSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  body: BrowserBodySchema,
  status: z6.enum(["pending", "popped", "promoted"]),
  promoted_ticket_opaque_id: BrowserOpaqueIdSchema.optional(),
  created_at: BrowserTimestampSchema,
  updated_at: BrowserTimestampSchema
}).strict();
var BrowserWorkAssetMetadataSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  mime_type: z6.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  byte_size: z6.number().int().positive().max(10 * 1024 * 1024),
  created_at: BrowserTimestampSchema
}).strict();
var BrowserWorkCommentSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  parent_opaque_id: BrowserOpaqueIdSchema.optional(),
  author_kind: z6.enum(["human", "session", "system"]),
  body: BrowserBodySchema,
  tag: z6.string().min(1).max(64),
  status: z6.string().min(1).max(64),
  revision: z6.number().int().positive(),
  created_at: BrowserTimestampSchema,
  updated_at: BrowserTimestampSchema
}).strict();
var BrowserWorkLinkSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  target_opaque_id: BrowserOpaqueIdSchema,
  relation: z6.enum(["blocks", "relates", "duplicates"]),
  created_at: BrowserTimestampSchema.optional()
}).strict();
var BrowserWorkTrackerStreamSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  name: z6.string().min(1).max(256),
  mode: z6.enum(["sequential", "parallel"]),
  description: z6.string().max(4096),
  revision: z6.number().int().positive(),
  updated_at: BrowserTimestampSchema
}).strict();
var BrowserWorkManagementOperationSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  operation_kind: z6.enum(["chat", "brief", "interrupt", "halt", "control"]),
  status: BrowserOperationStatusSchema,
  created_at: BrowserTimestampSchema,
  updated_at: BrowserTimestampSchema
}).strict();
var BrowserWorkDispatchOperationSchema = z6.object({
  opaque_id: BrowserOpaqueIdSchema,
  operation_kind: z6.literal("dispatch"),
  subject_opaque_id: BrowserOpaqueIdSchema,
  disposition: z6.enum([
    "queued",
    "pull_only",
    "next_turn",
    "ineligible",
    "stale"
  ]),
  capability: z6.literal("delivery").optional(),
  remediation: z6.enum(["await_delivery", "await_next_turn", "refresh_ticket"]).optional(),
  settlement: z6.enum([
    "pending",
    "delivered",
    "settled",
    "retrying",
    "failed",
    "expired",
    "cancelled"
  ]).optional(),
  created_at: BrowserTimestampSchema
}).strict();
var BrowserWorkOperationSchema = z6.union([
  BrowserWorkManagementOperationSchema,
  BrowserWorkDispatchOperationSchema
]);
var BrowserWorkProjectionBaseSchema = z6.object({
  schema_version: z6.literal("golem.browser-work-projection/v1"),
  resource_revision: z6.number().int().nonnegative(),
  next_cursor: BrowserWorkProjectionCursorSchema.nullable()
}).strict();
var BrowserWorkBoardProjectionSchema = BrowserWorkProjectionBaseSchema.extend({
  stream: z6.literal("tracker.board"),
  items: z6.array(BrowserWorkTicketSchema).max(100)
}).strict();
var BrowserWorkTreeProjectionSchema = BrowserWorkProjectionBaseSchema.extend({
  stream: z6.literal("tracker.tree"),
  items: z6.array(BrowserWorkTreeTicketSchema).max(100)
}).strict();
var BrowserWorkManagementProjectionSchema = BrowserWorkProjectionBaseSchema.extend({
  stream: z6.literal("management.controls"),
  items: z6.array(BrowserWorkManagementOperationSchema).max(100),
  roles: z6.array(BrowserWorkRoleSchema).max(100),
  gates: z6.array(BrowserWorkGateSchema).max(100),
  ideas: z6.array(BrowserWorkIdeaSchema).max(100)
}).strict();
var BrowserWorkCommunicationProjectionSchema = BrowserWorkProjectionBaseSchema.extend({
  stream: z6.literal("communication.operations"),
  items: z6.array(BrowserWorkOperationSchema).max(100)
}).strict();
var BrowserWorkProjectionResponseSchema = z6.discriminatedUnion("stream", [
  BrowserWorkBoardProjectionSchema,
  BrowserWorkTreeProjectionSchema,
  BrowserWorkManagementProjectionSchema,
  BrowserWorkCommunicationProjectionSchema
]);
var BrowserWorkInvalidationSchema = z6.object({
  kind: z6.literal("invalidation"),
  category: z6.enum(["tracker", "management", "communication"])
}).strict();
var BrowserWorkCursorSchema = z6.string().min(1).max(512);
var BrowserWorkResyncPayloadSchema = z6.object({
  kind: z6.literal("resync_required"),
  reason: z6.enum([
    "instance_changed",
    "cursor_gap",
    "cursor_compacted",
    "policy_changed",
    "protocol_mismatch"
  ]),
  snapshot_url: z6.string().url().max(2048)
}).strict();
var BrowserWorkFrameBaseSchema = z6.object({
  schema_version: wireVersion("browser-work-websocket-frame"),
  instance_id: ControlPlaneInstanceIdSchema,
  sequence: z6.number().int().nonnegative(),
  resource_revision: z6.number().int().nonnegative(),
  correlation_id: z6.string().min(1).max(128)
}).strict();
var BrowserWorkBoardWebSocketFrameSchema = BrowserWorkFrameBaseSchema.extend({
  stream: z6.literal("tracker.board"),
  payload: z6.discriminatedUnion("kind", [
    z6.object({
      kind: z6.literal("snapshot"),
      cursor: BrowserWorkCursorSchema,
      payload: BrowserWorkBoardProjectionSchema
    }).strict(),
    z6.object({
      kind: z6.literal("delta"),
      cursor: BrowserWorkCursorSchema,
      delta: BrowserWorkInvalidationSchema.extend({
        category: z6.literal("tracker")
      }).strict()
    }).strict(),
    BrowserWorkResyncPayloadSchema
  ])
}).strict();
var BrowserWorkTreeWebSocketFrameSchema = BrowserWorkFrameBaseSchema.extend({
  stream: z6.literal("tracker.tree"),
  payload: z6.discriminatedUnion("kind", [
    z6.object({
      kind: z6.literal("snapshot"),
      cursor: BrowserWorkCursorSchema,
      payload: BrowserWorkTreeProjectionSchema
    }).strict(),
    z6.object({
      kind: z6.literal("delta"),
      cursor: BrowserWorkCursorSchema,
      delta: BrowserWorkInvalidationSchema.extend({
        category: z6.literal("tracker")
      }).strict()
    }).strict(),
    BrowserWorkResyncPayloadSchema
  ])
}).strict();
var BrowserWorkManagementWebSocketFrameSchema = BrowserWorkFrameBaseSchema.extend({
  stream: z6.literal("management.controls"),
  payload: z6.discriminatedUnion("kind", [
    z6.object({
      kind: z6.literal("snapshot"),
      cursor: BrowserWorkCursorSchema,
      payload: BrowserWorkManagementProjectionSchema
    }).strict(),
    z6.object({
      kind: z6.literal("delta"),
      cursor: BrowserWorkCursorSchema,
      delta: BrowserWorkInvalidationSchema.extend({
        category: z6.literal("management")
      }).strict()
    }).strict(),
    BrowserWorkResyncPayloadSchema
  ])
}).strict();
var BrowserWorkCommunicationWebSocketFrameSchema = BrowserWorkFrameBaseSchema.extend({
  stream: z6.literal("communication.operations"),
  payload: z6.discriminatedUnion("kind", [
    z6.object({
      kind: z6.literal("snapshot"),
      cursor: BrowserWorkCursorSchema,
      payload: BrowserWorkCommunicationProjectionSchema
    }).strict(),
    z6.object({
      kind: z6.literal("delta"),
      cursor: BrowserWorkCursorSchema,
      delta: BrowserWorkInvalidationSchema.extend({
        category: z6.literal("communication")
      }).strict()
    }).strict(),
    BrowserWorkResyncPayloadSchema
  ])
}).strict();
var BrowserWorkWebSocketFrameSchema = z6.discriminatedUnion("stream", [
  BrowserWorkBoardWebSocketFrameSchema,
  BrowserWorkTreeWebSocketFrameSchema,
  BrowserWorkManagementWebSocketFrameSchema,
  BrowserWorkCommunicationWebSocketFrameSchema
]);
var BrowserWorkDetailResponseSchema = z6.object({
  schema_version: z6.literal("golem.browser-work-detail/v1"),
  item: BrowserWorkTicketSchema,
  body: BrowserBodySchema,
  comments: z6.array(BrowserWorkCommentSchema).max(500),
  links: z6.array(BrowserWorkLinkSchema).max(200),
  children: z6.array(BrowserWorkTicketSchema).max(200),
  streams: z6.array(BrowserWorkTrackerStreamSchema).max(100),
  assets: z6.array(BrowserWorkAssetMetadataSchema).max(100)
}).strict();
var BrowserWorkAssetResponseSchema = z6.object({
  schema_version: z6.literal("golem.browser-work-asset/v1"),
  asset: BrowserWorkAssetMetadataSchema,
  content_base64: z6.string().min(1).max(14e6)
}).strict();
var BrowserWorkCommandBaseSchema = z6.object({
  idempotency_key: z6.string().min(1).max(256)
});
var BrowserWorkCommandRequestSchema = z6.discriminatedUnion("kind", [
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("ticket.create"),
    ticket_kind: BrowserTicketKindSchema.optional(),
    title: BrowserTitleSchema,
    body: BrowserBodySchema.optional(),
    priority: BrowserTicketPrioritySchema.optional(),
    labels: z6.array(BrowserLabelSchema).max(32).optional(),
    parent_opaque_id: BrowserOpaqueIdSchema.optional(),
    stream_opaque_id: BrowserOpaqueIdSchema.optional(),
    wave: z6.number().int().positive().max(1e4).optional()
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("ticket.update"),
    opaque_id: BrowserOpaqueIdSchema,
    expected_revision: z6.number().int().positive(),
    title: BrowserTitleSchema.optional(),
    body: BrowserBodySchema.optional(),
    priority: BrowserTicketPrioritySchema.optional(),
    labels: z6.array(BrowserLabelSchema).max(32).optional(),
    parent_opaque_id: BrowserOpaqueIdSchema.optional(),
    stream_opaque_id: BrowserOpaqueIdSchema.optional(),
    wave: z6.number().int().positive().max(1e4).optional()
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("ticket.transition"),
    opaque_id: BrowserOpaqueIdSchema,
    expected_revision: z6.number().int().positive(),
    phase: BrowserPhaseSchema,
    reason: z6.string().min(1).max(1024).optional()
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("comment.create"),
    opaque_id: BrowserOpaqueIdSchema,
    parent_comment_opaque_id: BrowserOpaqueIdSchema.optional(),
    body: BrowserBodySchema.pipe(z6.string().min(1))
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("link.create"),
    opaque_id: BrowserOpaqueIdSchema,
    target_opaque_id: BrowserOpaqueIdSchema,
    relation: z6.enum(["blocks", "relates", "duplicates"])
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("stream.create"),
    name: z6.string().min(1).max(256),
    mode: z6.enum(["sequential", "parallel"]),
    description: z6.string().max(4096).optional()
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("management.gate.create"),
    gate_kind: z6.enum(["approval", "input"]),
    question: z6.string().min(1).max(512),
    assignee: z6.string().min(1).max(128)
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("management.role.assign"),
    role_opaque_id: BrowserOpaqueIdSchema
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("management.idea.create"),
    body: BrowserBodySchema.pipe(z6.string().min(1))
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("management.idea.pop"),
    idea_opaque_id: BrowserOpaqueIdSchema
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("management.idea.promote"),
    idea_opaque_id: BrowserOpaqueIdSchema,
    title: BrowserTitleSchema.optional()
  }).strict(),
  BrowserWorkCommandBaseSchema.extend({
    kind: z6.literal("dispatch"),
    opaque_id: BrowserOpaqueIdSchema,
    expected_revision: z6.number().int().positive()
  }).strict()
]);
var BrowserWorkCommandResultSchema = z6.discriminatedUnion("kind", [
  z6.object({ kind: z6.literal("ticket"), ticket: BrowserWorkTicketSchema }).strict(),
  z6.object({
    kind: z6.literal("comment"),
    comment: BrowserWorkCommentSchema
  }).strict(),
  z6.object({ kind: z6.literal("link"), link: BrowserWorkLinkSchema }).strict(),
  z6.object({
    kind: z6.literal("stream"),
    stream: BrowserWorkTrackerStreamSchema
  }).strict(),
  z6.object({
    kind: z6.literal("gate"),
    opaque_id: BrowserOpaqueIdSchema,
    status: z6.enum(["awaiting", "approved", "denied", "cancelled"]),
    updated_at: BrowserTimestampSchema
  }).strict(),
  z6.object({
    kind: z6.literal("role_assignment"),
    role_opaque_id: BrowserOpaqueIdSchema,
    assigned_at: BrowserTimestampSchema
  }).strict(),
  z6.object({ kind: z6.literal("idea"), idea: BrowserWorkIdeaSchema }).strict(),
  z6.object({
    kind: z6.literal("dispatch"),
    disposition: z6.enum([
      "queued",
      "pull_only",
      "next_turn",
      "ineligible",
      "stale"
    ]),
    /** The durable GOL-79 command id, never an endpoint or target id. */
    operation_id: BrowserOpaqueIdSchema,
    capability: z6.enum(["delivery"]).optional(),
    remediation: z6.enum(["await_delivery", "await_next_turn", "refresh_ticket"]).optional()
  }).strict()
]);
var BrowserWorkCommandResponseSchema = z6.object({
  schema_version: z6.literal("golem.browser-work-command/v1"),
  command_id: z6.string().min(1).max(128),
  status: z6.enum([
    "completed",
    "rejected",
    "conflict",
    "idempotency_mismatch"
  ]),
  resource_revision: z6.number().int().nonnegative(),
  result: BrowserWorkCommandResultSchema
}).strict();
var BrowserWorkErrorSchema = z6.object({
  schema_version: z6.literal("golem.browser-work-error/v1"),
  code: z6.enum([
    "browser.auth.required",
    "browser.forbidden",
    "browser.work.invalid",
    "browser.work.not_found",
    "browser-work.dispatch.unsupported",
    "tracker.revision.required",
    "tracker.conflict",
    "tracker.not_found",
    "tracker.phase.invalid",
    "tracker.input.invalid",
    "tracker.runtime_reference.invalid",
    "management.invalid",
    "management.not_found",
    "management.forbidden",
    "management.conflict",
    "management.asset_invalid",
    "command.idempotency_mismatch"
  ]),
  correlation_id: z6.string().min(1).max(128)
}).strict();

// packages/contracts/dist/common.js
import { z as z7 } from "zod";
var HarnessSchema = z7.enum(["claude", "codex", "opencode", "pi"]);
var LifecycleStateSchema = z7.enum([
  "starting",
  "idle",
  "active",
  "waiting",
  "ending",
  "ended",
  "errored",
  "superseded"
]);
var EndpointRouteStateSchema = z7.enum([
  "claiming",
  "healthy",
  "degraded",
  "released",
  "expired",
  "superseded"
]);
var DeliveryReadinessSchema = z7.enum([
  "ready",
  "held_busy",
  "held_waiting",
  "pull_only",
  "next_turn",
  "unsupported",
  "unhealthy",
  "uninitialized"
]);
var DeliveryModeSchema = z7.enum([
  "pull",
  "native_channel",
  "prompt_bridge",
  "managed_app_server",
  "next_turn"
]);
var TimestampSchema = z7.iso.datetime({ offset: true });
var ProjectReferenceBodySchema = z7.object({ project_id: ProjectIdSchema }).strict();
var ProjectLocationReferenceBodySchema = z7.object({
  project_id: ProjectIdSchema,
  location_id: LocationIdSchema,
  relation: z7.enum(["main", "worktree", "registered", "legacy"]),
  canonical_path: z7.string().min(1).max(4096),
  observed_path: z7.string().min(1).max(4096).optional()
}).strict();
var SessionReferenceBodySchema = z7.object({
  project_id: ProjectIdSchema,
  session_id: SessionIdSchema
}).strict();
var GenerationReferenceBodySchema = z7.object({
  project_id: ProjectIdSchema,
  session_id: SessionIdSchema,
  generation_id: GenerationIdSchema
}).strict();
var AliasReferenceBodySchema = z7.object({
  project_id: ProjectIdSchema,
  harness: HarnessSchema,
  alias_kind: z7.enum([
    "native_conversation",
    "native_run",
    "legacy_canonical_id",
    "supervisor_thread",
    "bridge_session",
    "migration_relation"
  ]),
  alias: z7.string().min(1).max(512),
  producer_id: ProducerIdSchema.optional(),
  session: SessionReferenceBodySchema.optional()
}).strict().superRefine((value2, context) => {
  if (value2.session && value2.session.project_id !== value2.project_id) {
    context.addIssue({
      code: "custom",
      message: "wire.alias.cross_scope",
      path: ["session", "project_id"]
    });
  }
});
var ActorReferenceBodySchema = z7.object({
  actor_id: ActorIdSchema,
  kind: z7.enum(["human", "service", "adapter", "session"]),
  display_name: z7.string().min(1).max(160).optional()
}).strict();
var ProducerReferenceBodySchema = z7.object({
  producer: z7.string().min(1).max(128),
  producer_instance_id: ProducerIdSchema,
  harness: HarnessSchema
}).strict();
var ClockFactsBodySchema = z7.object({
  source_observed_at: TimestampSchema,
  source_event_at: TimestampSchema.optional(),
  received_at: TimestampSchema,
  materialized_at: TimestampSchema.optional()
}).strict().superRefine((value2, context) => {
  const observedAt = Date.parse(value2.source_observed_at);
  const receivedAt = Date.parse(value2.received_at);
  const sourceEventAt = value2.source_event_at ? Date.parse(value2.source_event_at) : null;
  const materializedAt = value2.materialized_at ? Date.parse(value2.materialized_at) : null;
  if (observedAt > receivedAt) {
    context.addIssue({
      code: "custom",
      message: "wire.clock.observed_after_received",
      path: ["received_at"]
    });
  }
  if (sourceEventAt !== null && sourceEventAt > receivedAt) {
    context.addIssue({
      code: "custom",
      message: "wire.clock.source_after_received",
      path: ["received_at"]
    });
  }
  if (materializedAt !== null && materializedAt < receivedAt) {
    context.addIssue({
      code: "custom",
      message: "wire.clock.materialized_before_received",
      path: ["materialized_at"]
    });
  }
});
var ProvenanceBodySchema = z7.object({
  source: z7.enum([
    "adapter",
    "api",
    "launcher",
    "legacy_import",
    "migration"
  ]),
  evidence_id: z7.string().min(1).max(256).optional(),
  confidence: z7.enum(["verified", "observed", "inferred", "legacy"])
}).strict();
var EndpointReferenceBodySchema = z7.object({
  endpoint_id: EndpointIdSchema,
  generation: GenerationReferenceBodySchema
}).strict();

// packages/contracts/dist/control.js
import { z as z9 } from "zod";

// packages/contracts/dist/launcher.js
import { z as z8 } from "zod";
var SecretInlineValuePattern = /(?:api[_-]?key|token|secret|password|credential)\s*=/iu;
var SecretArgumentNamePattern = /^--?(?:api[_-]?key|token|secret|password|credential)(?:=|$)/iu;
function rejectSecretArguments(value2, context) {
  for (const [index, argument] of value2.native_args.entries()) {
    if (SecretArgumentNamePattern.test(argument)) {
      context.addIssue({
        code: "custom",
        message: argument.includes("=") ? "config.secret_value.forbidden" : "config.secret_argument.forbidden",
        path: ["native_args", index]
      });
      const splitValue = value2.native_args[index + 1];
      if (!argument.includes("=") && splitValue && !splitValue.startsWith("-")) {
        context.addIssue({
          code: "custom",
          message: "config.secret_value.forbidden",
          path: ["native_args", index + 1]
        });
      }
      continue;
    }
    if (SecretInlineValuePattern.test(argument)) {
      context.addIssue({
        code: "custom",
        message: "config.secret_value.forbidden",
        path: ["native_args", index]
      });
    }
  }
}
var LauncherPresetBodySchema = z8.object({
  name: z8.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-]*$/u),
  harness: HarnessSchema,
  backend: z8.enum([
    "openai",
    "anthropic",
    "ollama_local",
    "ollama_cloud",
    "native"
  ]),
  model_selector: z8.string().min(1).max(256),
  delivery_mode: DeliveryModeSchema,
  native_args: z8.array(z8.string().min(1).max(1024)).max(32),
  env_key_refs: z8.array(z8.string().regex(/^[A-Z][A-Z0-9_]*$/u, "config.env_key_ref.invalid")).max(16),
  binary_override: z8.string().min(1).max(4096).optional()
}).strict().superRefine(rejectSecretArguments);
var LauncherPresetSchema = z8.object({
  schema_version: wireVersion("launcher-preset"),
  ...LauncherPresetBodySchema.shape
}).strict().superRefine(rejectSecretArguments);
var HarnessDefaultsSchema = z8.object({
  claude: z8.string().min(1).max(128).optional(),
  codex: z8.string().min(1).max(128).optional(),
  opencode: z8.string().min(1).max(128).optional(),
  pi: z8.string().min(1).max(128).optional()
}).strict();
var LauncherConfigV1Schema = z8.object({
  schema_version: wireVersion("launcher-config"),
  launch: z8.object({
    harness_defaults: HarnessDefaultsSchema,
    presets: z8.array(LauncherPresetBodySchema).max(256)
  }).strict()
}).strict();
var CompatibilityIngressV1Schema = z8.object({
  schema_version: wireVersion("compatibility-ingress"),
  legacy_schema_version: z8.string().min(1).max(128),
  payload: JsonValueSchema
}).passthrough();

// packages/contracts/dist/control.js
var ControlCommandKinds = [
  "project.register",
  "project.archive",
  "project.location_decide",
  "preset.upsert",
  "preset.delete",
  "launch.prepare",
  "session.control",
  "dispatch.enqueue",
  "dispatch.cancel",
  "dispatch.retry",
  "migration.plan",
  "migration.apply",
  "migration.rollback",
  "compatibility.cutover"
];
var ControlCommandKindSchema = z9.enum(ControlCommandKinds);
var SessionMetadataKeySchema = z9.string().min(1).max(128).regex(/^[a-z][a-z0-9_.-]*$/u, "wire.session_metadata.key_invalid");
var SessionMetadataPatchSchema = z9.object({
  patch: z9.record(SessionMetadataKeySchema, JsonValueSchema),
  clear_fields: z9.array(SessionMetadataKeySchema).max(64)
}).strict().superRefine((value2, context) => {
  const patchKeys = Object.keys(value2.patch);
  if (patchKeys.length === 0 && value2.clear_fields.length === 0) {
    context.addIssue({
      code: "custom",
      message: "wire.session_metadata.empty_mutation",
      path: ["patch"]
    });
  }
  for (const [index, field] of value2.clear_fields.entries()) {
    if (field in value2.patch) {
      context.addIssue({
        code: "custom",
        message: "wire.session_metadata.patch_clear_conflict",
        path: ["clear_fields", index]
      });
    }
  }
});
var SessionRoleSchema = z9.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/u, "wire.session_role.invalid");
var SessionControlPayloadSchema = z9.discriminatedUnion("action", [
  z9.object({
    kind: z9.literal("session.control"),
    generation: GenerationReferenceBodySchema,
    action: z9.literal("interrupt")
  }).strict(),
  z9.object({
    kind: z9.literal("session.control"),
    generation: GenerationReferenceBodySchema,
    action: z9.literal("halt")
  }).strict(),
  z9.object({
    kind: z9.literal("session.control"),
    generation: GenerationReferenceBodySchema,
    action: z9.literal("resume")
  }).strict(),
  z9.object({
    kind: z9.literal("session.control"),
    generation: GenerationReferenceBodySchema,
    action: z9.literal("rename"),
    name: z9.string().min(1).max(160)
  }).strict(),
  z9.object({
    kind: z9.literal("session.control"),
    generation: GenerationReferenceBodySchema,
    action: z9.literal("set_role"),
    role: SessionRoleSchema
  }).strict(),
  z9.object({
    kind: z9.literal("session.control"),
    generation: GenerationReferenceBodySchema,
    action: z9.literal("patch_metadata"),
    metadata: SessionMetadataPatchSchema
  }).strict()
]);
var ControlTargetSchema = z9.discriminatedUnion("kind", [
  z9.object({ kind: z9.literal("project"), project: ProjectReferenceBodySchema }).strict(),
  z9.object({ kind: z9.literal("session"), session: SessionReferenceBodySchema }).strict(),
  z9.object({
    kind: z9.literal("generation"),
    generation: GenerationReferenceBodySchema
  }).strict(),
  z9.object({
    kind: z9.literal("endpoint"),
    endpoint: EndpointReferenceBodySchema
  }).strict()
]);
var ControlCommandPayloadSchema = z9.discriminatedUnion("kind", [
  z9.object({
    kind: z9.literal("project.register"),
    project: ProjectReferenceBodySchema,
    location: ProjectLocationReferenceBodySchema
  }).strict(),
  z9.object({
    kind: z9.literal("project.archive"),
    project: ProjectReferenceBodySchema
  }).strict(),
  z9.object({
    kind: z9.literal("project.location_decide"),
    project: ProjectReferenceBodySchema,
    location: ProjectLocationReferenceBodySchema,
    decision: z9.enum(["attach", "reject"])
  }).strict(),
  z9.object({
    kind: z9.literal("preset.upsert"),
    preset_name: z9.string().min(1).max(128),
    preset: LauncherPresetBodySchema
  }).strict(),
  z9.object({
    kind: z9.literal("preset.delete"),
    preset_name: z9.string().min(1).max(128)
  }).strict(),
  z9.object({
    kind: z9.literal("launch.prepare"),
    harness: z9.enum(["claude", "codex", "opencode", "pi"]),
    preset_name: z9.string().min(1).max(128).optional()
  }).strict(),
  SessionControlPayloadSchema,
  z9.object({
    kind: z9.literal("dispatch.enqueue"),
    endpoint: EndpointReferenceBodySchema,
    payload: JsonValueSchema
  }).strict(),
  z9.object({
    kind: z9.literal("dispatch.cancel"),
    delivery_id: DeliveryIdSchema
  }).strict(),
  z9.object({
    kind: z9.literal("dispatch.retry"),
    delivery_id: DeliveryIdSchema
  }).strict(),
  z9.object({
    kind: z9.literal("migration.plan"),
    scope: z9.enum(["runtime", "tracker", "config"])
  }).strict(),
  z9.object({
    kind: z9.literal("migration.apply"),
    plan_id: MigrationPlanIdSchema
  }).strict(),
  z9.object({
    kind: z9.literal("migration.rollback"),
    plan_id: MigrationPlanIdSchema
  }).strict(),
  z9.object({
    kind: z9.literal("compatibility.cutover"),
    stage: z9.enum(["C1", "C2", "C3", "C4", "C5"])
  }).strict()
]);
var ControlCommandV1Schema = z9.object({
  schema_version: wireVersion("control-command"),
  command_id: CommandIdSchema,
  command_kind: ControlCommandKindSchema,
  actor: ActorReferenceBodySchema,
  correlation_id: z9.string().min(1).max(128),
  causation_id: CommandIdSchema.optional(),
  idempotency_key: z9.string().min(1).max(256),
  target: ControlTargetSchema.optional(),
  expected_revision: z9.number().int().nonnegative().optional(),
  endpoint_fence: z9.string().min(1).max(256).optional(),
  audit: z9.object({
    request_source: z9.enum(["cli", "dashboard", "mcp", "service"]),
    redacted_metadata: JsonObjectSchema
  }).strict(),
  payload: ControlCommandPayloadSchema
}).strict().superRefine((value2, context) => {
  if (value2.command_kind !== value2.payload.kind) {
    context.addIssue({
      code: "custom",
      message: "wire.control_command.kind_mismatch",
      path: ["payload", "kind"]
    });
  }
  if (value2.payload.kind === "preset.upsert" && value2.payload.preset_name !== value2.payload.preset.name) {
    context.addIssue({
      code: "custom",
      message: "wire.preset.name_mismatch",
      path: ["payload", "preset", "name"]
    });
  }
});

// packages/contracts/dist/delivery.js
import { z as z10 } from "zod";
var DeliveryEnvelopeV1Schema = z10.object({
  schema_version: wireVersion("delivery-envelope"),
  delivery_id: DeliveryIdSchema,
  command: ControlCommandV1Schema,
  endpoint: EndpointReferenceBodySchema,
  generation: GenerationReferenceBodySchema,
  attempt: z10.number().int().nonnegative(),
  deduplication_key: z10.string().min(1).max(256),
  created_at: z10.iso.datetime({ offset: true }),
  not_before_at: z10.iso.datetime({ offset: true }).optional(),
  payload: JsonValueSchema
}).strict();
var DeliveryAcknowledgementV1Schema = z10.object({
  schema_version: wireVersion("delivery-acknowledgement"),
  delivery_id: DeliveryIdSchema,
  status: z10.enum(["accepted", "completed", "rejected", "retry", "expired"]),
  acknowledged_at: z10.iso.datetime({ offset: true }),
  reason_code: z10.string().min(1).max(128).optional(),
  result: JsonValueSchema.optional()
}).strict();

// packages/contracts/dist/diagnostics.js
import { z as z11 } from "zod";
var DiagnosticsExplanationV1Schema = z11.object({
  schema_version: wireVersion("diagnostics-explanation"),
  code: z11.string().min(1).max(128),
  severity: z11.enum(["info", "warning", "error"]),
  message: z11.string().min(1).max(1024),
  project_id: ProjectIdSchema.optional(),
  event_ids: z11.array(EventIdSchema).max(64),
  facts: JsonObjectSchema,
  remediation: z11.array(z11.string().min(1).max(512)).max(16)
}).strict();

// packages/contracts/dist/facts.js
import { z as z12 } from "zod";
var ClockFactsSchema = z12.object({
  schema_version: wireVersion("clock-facts"),
  ...ClockFactsBodySchema.shape
}).strict().superRefine((value2, context) => {
  const observedAt = Date.parse(value2.source_observed_at);
  const receivedAt = Date.parse(value2.received_at);
  if (observedAt > receivedAt) {
    context.addIssue({
      code: "custom",
      message: "wire.clock.observed_after_received",
      path: ["received_at"]
    });
  }
  if (value2.source_event_at && Date.parse(value2.source_event_at) > receivedAt) {
    context.addIssue({
      code: "custom",
      message: "wire.clock.source_after_received",
      path: ["received_at"]
    });
  }
  if (value2.materialized_at && Date.parse(value2.materialized_at) < receivedAt) {
    context.addIssue({
      code: "custom",
      message: "wire.clock.materialized_before_received",
      path: ["materialized_at"]
    });
  }
});
var ProvenanceSchema = z12.object({
  schema_version: wireVersion("provenance"),
  ...ProvenanceBodySchema.shape
}).strict();
var LifecycleFactsBodySchema = z12.object({
  generation: GenerationReferenceBodySchema,
  state: LifecycleStateSchema,
  started_at: z12.iso.datetime({ offset: true }).optional(),
  last_activity_at: z12.iso.datetime({ offset: true }).optional(),
  ended_at: z12.iso.datetime({ offset: true }).optional(),
  reason: z12.string().min(1).max(256).optional()
}).strict().superRefine((value2, context) => {
  if (value2.started_at && value2.ended_at) {
    if (Date.parse(value2.ended_at) < Date.parse(value2.started_at)) {
      context.addIssue({
        code: "custom",
        message: "wire.lifecycle.ended_before_started",
        path: ["ended_at"]
      });
    }
  }
});
var LifecycleFactsSchema = z12.object({
  schema_version: wireVersion("lifecycle-facts"),
  ...LifecycleFactsBodySchema.shape
}).strict().superRefine((value2, context) => {
  if (value2.started_at && value2.ended_at && Date.parse(value2.ended_at) < Date.parse(value2.started_at)) {
    context.addIssue({
      code: "custom",
      message: "wire.lifecycle.ended_before_started",
      path: ["ended_at"]
    });
  }
});
var EndpointRecordBodySchema = z12.object({
  endpoint_id: EndpointIdSchema,
  generation: GenerationReferenceBodySchema,
  state: EndpointRouteStateSchema,
  owner_fence: z12.string().min(1).max(256),
  delivery_mode: DeliveryModeSchema,
  readiness: DeliveryReadinessSchema,
  revision: z12.number().int().nonnegative(),
  last_heartbeat_at: z12.iso.datetime({ offset: true }).optional()
}).strict();
var EndpointRecordSchema = z12.object({
  schema_version: wireVersion("endpoint-record"),
  ...EndpointRecordBodySchema.shape
}).strict();
var CapabilityRecordBodySchema = z12.object({
  capability_id: z12.string().min(1).max(160),
  harness: HarnessSchema,
  adapter_version: z12.string().min(1).max(64),
  integration_layers: z12.array(z12.enum([
    "extension",
    "hooks",
    "mcp",
    "channel",
    "app_server",
    "prompt_bridge"
  ])).min(1),
  qualification: z12.enum([
    "supported",
    "experimental",
    "unsupported",
    "unknown"
  ]),
  delivery_mode: DeliveryModeSchema,
  readiness: DeliveryReadinessSchema,
  reason_code: z12.string().min(1).max(128).optional(),
  evidence_version: z12.string().min(1).max(64).optional()
}).strict();
var CapabilityRecordSchema = z12.object({
  schema_version: wireVersion("capability-record"),
  ...CapabilityRecordBodySchema.shape
}).strict();

// packages/contracts/dist/fixtures.js
var ids = {
  actor: "act_11111111-1111-4111-8111-111111111111",
  command: "cmd_22222222-2222-4222-8222-222222222222",
  controlPlane: "cpi_33333333-3333-4333-8333-333333333333",
  delivery: "del_44444444-4444-4444-8444-444444444444",
  endpoint: "ep_55555555-5555-4555-8555-555555555555",
  event: "evt_66666666-6666-4666-8666-666666666666",
  generation: "gen_77777777-7777-4777-8777-777777777777",
  location: "loc_88888888-8888-4888-8888-888888888888",
  migration: "mig_99999999-9999-4999-8999-999999999999",
  operation: "op_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  producer: "prod_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  project: "prj_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  session: "ses_dddddddd-dddd-4ddd-8ddd-dddddddddddd"
};
var timestamp = {
  event: "2026-07-20T09:59:00.000Z",
  observed: "2026-07-20T10:00:00.000Z",
  received: "2026-07-20T10:01:00.000Z",
  materialized: "2026-07-20T10:02:00.000Z"
};
var project = { project_id: ids.project };
var location = {
  project_id: ids.project,
  location_id: ids.location,
  relation: "main",
  canonical_path: "/workspace/golem"
};
var session = { project_id: ids.project, session_id: ids.session };
var generation = { ...session, generation_id: ids.generation };
var actor = { actor_id: ids.actor, kind: "human", display_name: "Operator" };
var producer = {
  producer: "claude-adapter",
  producer_instance_id: ids.producer,
  harness: "claude"
};
var clocks = {
  source_event_at: timestamp.event,
  source_observed_at: timestamp.observed,
  received_at: timestamp.received,
  materialized_at: timestamp.materialized
};
var provenance = { source: "adapter", confidence: "verified" };
var endpoint = {
  endpoint_id: ids.endpoint,
  generation,
  state: "healthy",
  owner_fence: "fence-1",
  delivery_mode: "native_channel",
  readiness: "ready",
  revision: 1,
  last_heartbeat_at: timestamp.observed
};
var capability = {
  capability_id: "claude.channel",
  harness: "claude",
  adapter_version: "1.0.0",
  integration_layers: ["hooks", "mcp", "channel"],
  qualification: "supported",
  delivery_mode: "native_channel",
  readiness: "ready",
  evidence_version: "journey-v1"
};
var controlCommand = {
  schema_version: "golem.control-command/v1",
  command_id: ids.command,
  command_kind: "project.register",
  actor,
  correlation_id: "correlation-1",
  idempotency_key: "command:project.register:1",
  target: { kind: "project", project },
  audit: { request_source: "cli", redacted_metadata: { intent: "register" } },
  payload: { kind: "project.register", project, location }
};
function negativeVersion(value2) {
  return { ...value2, schema_version: "golem.unsupported/v2" };
}
var ContractFixtures = {
  "project-reference": {
    positive: { schema_version: "golem.project-reference/v1", ...project },
    negative: {
      schema_version: "golem.project-reference/v1",
      project_id: "project-name"
    }
  },
  "project-location-reference": {
    positive: {
      schema_version: "golem.project-location-reference/v1",
      ...location
    },
    negative: negativeVersion({
      schema_version: "golem.project-location-reference/v1",
      ...location
    })
  },
  "session-reference": {
    positive: { schema_version: "golem.session-reference/v1", ...session },
    negative: negativeVersion({
      schema_version: "golem.session-reference/v1",
      ...session
    })
  },
  "generation-reference": {
    positive: {
      schema_version: "golem.generation-reference/v1",
      ...generation
    },
    negative: negativeVersion({
      schema_version: "golem.generation-reference/v1",
      ...generation
    })
  },
  "alias-reference": {
    positive: {
      schema_version: "golem.alias-reference/v1",
      project_id: ids.project,
      harness: "claude",
      alias_kind: "native_conversation",
      alias: "native-thread-1",
      session
    },
    negative: {
      schema_version: "golem.alias-reference/v1",
      project_id: ids.project,
      harness: "claude",
      alias_kind: "native_conversation",
      alias: "native-thread-1",
      session: {
        project_id: "prj_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        session_id: ids.session
      }
    }
  },
  "actor-reference": {
    positive: { schema_version: "golem.actor-reference/v1", ...actor },
    negative: negativeVersion({
      schema_version: "golem.actor-reference/v1",
      ...actor
    })
  },
  "producer-reference": {
    positive: { schema_version: "golem.producer-reference/v1", ...producer },
    negative: negativeVersion({
      schema_version: "golem.producer-reference/v1",
      ...producer
    })
  },
  "clock-facts": {
    positive: { schema_version: "golem.clock-facts/v1", ...clocks },
    negative: {
      schema_version: "golem.clock-facts/v1",
      ...clocks,
      received_at: "2026-07-20T09:00:00.000Z"
    }
  },
  provenance: {
    positive: { schema_version: "golem.provenance/v1", ...provenance },
    negative: negativeVersion({
      schema_version: "golem.provenance/v1",
      ...provenance
    })
  },
  "lifecycle-facts": {
    positive: {
      schema_version: "golem.lifecycle-facts/v1",
      generation,
      state: "ended",
      started_at: timestamp.event,
      ended_at: timestamp.materialized
    },
    negative: {
      schema_version: "golem.lifecycle-facts/v1",
      generation,
      state: "ended",
      started_at: timestamp.materialized,
      ended_at: timestamp.event
    }
  },
  "endpoint-record": {
    positive: { schema_version: "golem.endpoint-record/v1", ...endpoint },
    negative: negativeVersion({
      schema_version: "golem.endpoint-record/v1",
      ...endpoint
    })
  },
  "capability-record": {
    positive: { schema_version: "golem.capability-record/v1", ...capability },
    negative: negativeVersion({
      schema_version: "golem.capability-record/v1",
      ...capability
    })
  },
  "runtime-signal": {
    positive: {
      schema_version: "golem.runtime-signal/v1",
      event_id: ids.event,
      event_kind: "session.started",
      ...producer,
      correlation_id: "correlation-1",
      deduplication_key: "event:session.started:1",
      clocks,
      provenance,
      clear_fields: [],
      payload: {
        kind: "session.started",
        generation,
        metadata: { model: "gpt" }
      }
    },
    negative: {
      schema_version: "golem.runtime-signal/v1",
      event_id: ids.event,
      event_kind: "session.started",
      ...producer,
      correlation_id: "correlation-1",
      deduplication_key: "event:session.started:1",
      clocks,
      provenance,
      clear_fields: [],
      payload: { kind: "session.idle", generation }
    }
  },
  "control-command": {
    positive: controlCommand,
    negative: { ...controlCommand, command_id: "cmd_not-a-uuid" }
  },
  "delivery-envelope": {
    positive: {
      schema_version: "golem.delivery-envelope/v1",
      delivery_id: ids.delivery,
      command: controlCommand,
      endpoint: { endpoint_id: ids.endpoint, generation },
      generation,
      attempt: 0,
      deduplication_key: "delivery:1",
      created_at: timestamp.received,
      not_before_at: timestamp.materialized,
      payload: { type: "brief", body: "hello" }
    },
    negative: negativeVersion({
      schema_version: "golem.delivery-envelope/v1",
      delivery_id: ids.delivery,
      command: controlCommand,
      endpoint: { endpoint_id: ids.endpoint, generation },
      generation,
      attempt: 0,
      deduplication_key: "delivery:1",
      created_at: timestamp.received,
      payload: { type: "brief" }
    })
  },
  "delivery-acknowledgement": {
    positive: {
      schema_version: "golem.delivery-acknowledgement/v1",
      delivery_id: ids.delivery,
      status: "accepted",
      acknowledged_at: timestamp.materialized
    },
    negative: negativeVersion({
      schema_version: "golem.delivery-acknowledgement/v1",
      delivery_id: ids.delivery,
      status: "accepted",
      acknowledged_at: timestamp.materialized
    })
  },
  "launcher-preset": {
    positive: {
      schema_version: "golem.launcher-preset/v1",
      name: "review",
      harness: "claude",
      backend: "anthropic",
      model_selector: "claude-sonnet",
      delivery_mode: "pull",
      native_args: ["--verbose"],
      env_key_refs: ["ANTHROPIC_API_KEY"]
    },
    negative: {
      schema_version: "golem.launcher-preset/v1",
      name: "review",
      harness: "claude",
      backend: "anthropic",
      model_selector: "claude-sonnet",
      delivery_mode: "pull",
      native_args: ["--api-key=plain-secret"],
      env_key_refs: ["ANTHROPIC_API_KEY"]
    }
  },
  "launcher-config": {
    positive: {
      schema_version: "golem.launcher-config/v1",
      launch: {
        harness_defaults: { claude: "review" },
        presets: [
          {
            name: "review",
            harness: "claude",
            backend: "anthropic",
            model_selector: "claude-sonnet",
            delivery_mode: "pull",
            native_args: ["--verbose"],
            env_key_refs: ["ANTHROPIC_API_KEY"]
          }
        ]
      }
    },
    negative: {
      schema_version: "golem.launcher-config/v1",
      launch: { harness_defaults: {}, presets: [] },
      api_key: "plain-secret"
    }
  },
  "compatibility-ingress": {
    positive: {
      schema_version: "golem.compatibility-ingress/v1",
      legacy_schema_version: "legacy/v7",
      payload: { legacy: true },
      unknown_additive_field: { retained: true }
    },
    negative: negativeVersion({
      schema_version: "golem.compatibility-ingress/v1",
      legacy_schema_version: "legacy/v7",
      payload: { legacy: true }
    })
  },
  "api-error": {
    positive: {
      schema_version: "golem.api-error/v1",
      code: "not_found",
      message: "resource not found",
      correlation_id: "correlation-1"
    },
    negative: negativeVersion({
      schema_version: "golem.api-error/v1",
      code: "not_found",
      message: "resource not found",
      correlation_id: "correlation-1"
    })
  },
  "api-command-outcome": {
    positive: {
      schema_version: "golem.api-command-outcome/v1",
      command_id: ids.command,
      status: "accepted"
    },
    negative: negativeVersion({
      schema_version: "golem.api-command-outcome/v1",
      command_id: ids.command,
      status: "accepted"
    })
  },
  "command-receipt": {
    positive: {
      schema_version: "golem.command-receipt/v1",
      command_id: ids.command,
      idempotency_key: "command:ticket.update:1",
      command_kind: "ticket.update",
      actor_id: ids.actor,
      project_id: ids.project,
      resource_type: "ticket",
      resource_id: "TKT-0001",
      correlation_id: "correlation-1",
      fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      outcome: {
        schema_version: "golem.api-command-outcome/v1",
        command_id: ids.command,
        status: "completed"
      },
      committed_at: timestamp.materialized
    },
    negative: negativeVersion({
      schema_version: "golem.command-receipt/v1",
      command_id: ids.command,
      idempotency_key: "command:ticket.update:1",
      command_kind: "ticket.update",
      actor_id: ids.actor,
      project_id: ids.project,
      resource_type: "ticket",
      resource_id: "TKT-0001",
      correlation_id: "correlation-1",
      fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      outcome: {
        schema_version: "golem.api-command-outcome/v1",
        command_id: ids.command,
        status: "completed"
      },
      committed_at: timestamp.materialized
    })
  },
  "api-page": {
    positive: {
      schema_version: "golem.api-page/v1",
      items: [{ id: ids.project }],
      next_cursor: null,
      total: 1
    },
    negative: negativeVersion({
      schema_version: "golem.api-page/v1",
      items: [],
      next_cursor: null
    })
  },
  "websocket-frame": {
    positive: {
      schema_version: "golem.websocket-frame/v1",
      instance_id: ids.controlPlane,
      stream: "runtime.live",
      sequence: 1,
      resource_revision: 2,
      correlation_id: "correlation-1",
      payload: {
        kind: "snapshot",
        cursor: "cursor-1",
        payload: { sessions: [] }
      }
    },
    negative: negativeVersion({
      schema_version: "golem.websocket-frame/v1",
      instance_id: ids.controlPlane,
      stream: "runtime.live",
      sequence: 1,
      resource_revision: 2,
      correlation_id: "correlation-1",
      payload: { kind: "snapshot", cursor: "cursor-1", payload: {} }
    })
  },
  "migration-plan": {
    positive: {
      schema_version: "golem.migration-plan/v1",
      plan_id: ids.migration,
      mode: "dry_run",
      snapshot_id: "snapshot-1",
      plan_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      created_at: timestamp.received,
      counts_by_reason: { imported: 1 },
      steps: [
        { id: "import-projects", kind: "import", input: { source: "legacy" } }
      ],
      rollback_prerequisites: ["backup-present"]
    },
    negative: negativeVersion({
      schema_version: "golem.migration-plan/v1",
      plan_id: ids.migration,
      mode: "dry_run",
      snapshot_id: "snapshot-1",
      plan_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      created_at: timestamp.received,
      counts_by_reason: { imported: 1 },
      steps: [
        { id: "import-projects", kind: "import", input: { source: "legacy" } }
      ],
      rollback_prerequisites: ["backup-present"]
    })
  },
  "diagnostics-explanation": {
    positive: {
      schema_version: "golem.diagnostics-explanation/v1",
      code: "alias_ambiguous",
      severity: "warning",
      message: "Alias requires review",
      project_id: ids.project,
      event_ids: [ids.event],
      facts: { alias: "native-thread-1" },
      remediation: ["Choose an explicit alias relation"]
    },
    negative: negativeVersion({
      schema_version: "golem.diagnostics-explanation/v1",
      code: "alias_ambiguous",
      severity: "warning",
      message: "Alias requires review",
      event_ids: [],
      facts: {},
      remediation: []
    })
  }
};

// packages/contracts/dist/legacy-projection.js
import { z as z13 } from "zod";
var LegacyControlPlaneProjectionStreamSchema = z13.enum([
  "runtime.live",
  "runtime.history",
  "runtime.diagnostics",
  "projects"
]);
var LegacyControlPlaneProjectionResponseSchema = z13.object({
  schema_version: z13.literal("golem.control-plane-projection/v1"),
  stream: LegacyControlPlaneProjectionStreamSchema,
  resource_revision: z13.number().int().nonnegative(),
  payload: JsonValueSchema
}).strict();

// packages/contracts/dist/migration.js
import { z as z14 } from "zod";
var MigrationPlanV1Schema = z14.object({
  schema_version: wireVersion("migration-plan"),
  plan_id: MigrationPlanIdSchema,
  mode: z14.enum(["dry_run", "apply", "rollback"]),
  snapshot_id: z14.string().min(1).max(256),
  plan_hash: z14.string().regex(/^[a-f0-9]{64}$/u, "migration.plan_hash.invalid"),
  created_at: z14.iso.datetime({ offset: true }),
  counts_by_reason: z14.record(z14.string().min(1), z14.number().int().nonnegative()),
  steps: z14.array(z14.object({
    id: z14.string().min(1).max(128),
    kind: z14.enum([
      "import",
      "export",
      "switch_writer",
      "validate",
      "rollback"
    ]),
    input: JsonObjectSchema
  }).strict()).min(1),
  rollback_prerequisites: z14.array(z14.string().min(1).max(256))
}).strict();

// packages/contracts/dist/references.js
import { z as z15 } from "zod";
var ProjectReferenceSchema = z15.object({
  schema_version: wireVersion("project-reference"),
  ...ProjectReferenceBodySchema.shape
}).strict();
var ProjectLocationReferenceSchema = z15.object({
  schema_version: wireVersion("project-location-reference"),
  ...ProjectLocationReferenceBodySchema.shape
}).strict();
var SessionReferenceSchema = z15.object({
  schema_version: wireVersion("session-reference"),
  ...SessionReferenceBodySchema.shape
}).strict();
var GenerationReferenceSchema = z15.object({
  schema_version: wireVersion("generation-reference"),
  ...GenerationReferenceBodySchema.shape
}).strict();
var AliasReferenceSchema = z15.object({
  schema_version: wireVersion("alias-reference"),
  ...AliasReferenceBodySchema.shape
}).strict().superRefine((value2, context) => {
  if (value2.session && value2.session.project_id !== value2.project_id) {
    context.addIssue({
      code: "custom",
      message: "wire.alias.cross_scope",
      path: ["session", "project_id"]
    });
  }
});
var ActorReferenceSchema = z15.object({
  schema_version: wireVersion("actor-reference"),
  ...ActorReferenceBodySchema.shape
}).strict();
var ProducerReferenceSchema = z15.object({
  schema_version: wireVersion("producer-reference"),
  ...ProducerReferenceBodySchema.shape
}).strict();

// packages/contracts/dist/registry.js
import { z as z18 } from "zod";

// packages/contracts/dist/runtime.js
import { z as z16 } from "zod";
var RuntimeSignalKinds = [
  "project.observed",
  "session.started",
  "session.resumed",
  "session.activity",
  "session.idle",
  "session.waiting",
  "session.metadata_patched",
  "session.ended",
  "endpoint.claimed",
  "endpoint.heartbeat",
  "endpoint.readiness_changed",
  "endpoint.released",
  "capabilities.reported"
];
var RuntimeSignalKindSchema = z16.enum(RuntimeSignalKinds);
var RuntimeSignalPayloadSchema = z16.discriminatedUnion("kind", [
  z16.object({
    kind: z16.literal("project.observed"),
    project: ProjectReferenceBodySchema,
    location: ProjectLocationReferenceBodySchema
  }).strict(),
  z16.object({
    kind: z16.literal("session.started"),
    generation: GenerationReferenceBodySchema,
    metadata: JsonObjectSchema.optional()
  }).strict(),
  z16.object({
    kind: z16.literal("session.resumed"),
    generation: GenerationReferenceBodySchema,
    resumed_from_generation_id: GenerationIdSchema.optional()
  }).strict(),
  z16.object({
    kind: z16.literal("session.activity"),
    generation: GenerationReferenceBodySchema,
    activity_kind: z16.enum(["prompt", "tool", "response", "work"])
  }).strict(),
  z16.object({
    kind: z16.literal("session.idle"),
    generation: GenerationReferenceBodySchema
  }).strict(),
  z16.object({
    kind: z16.literal("session.waiting"),
    generation: GenerationReferenceBodySchema,
    reason: z16.string().min(1).max(256)
  }).strict(),
  z16.object({
    kind: z16.literal("session.metadata_patched"),
    generation: GenerationReferenceBodySchema,
    metadata: JsonObjectSchema
  }).strict(),
  z16.object({
    kind: z16.literal("session.ended"),
    generation: GenerationReferenceBodySchema,
    disposition: z16.enum(["ended", "errored", "superseded"])
  }).strict(),
  z16.object({
    kind: z16.literal("endpoint.claimed"),
    endpoint: EndpointRecordBodySchema
  }).strict(),
  z16.object({
    kind: z16.literal("endpoint.heartbeat"),
    endpoint: EndpointReferenceBodySchema,
    heartbeat_at: z16.iso.datetime({ offset: true })
  }).strict(),
  z16.object({
    kind: z16.literal("endpoint.readiness_changed"),
    endpoint: EndpointRecordBodySchema
  }).strict(),
  z16.object({
    kind: z16.literal("endpoint.released"),
    endpoint: EndpointReferenceBodySchema,
    reason: z16.string().min(1).max(256)
  }).strict(),
  z16.object({
    kind: z16.literal("capabilities.reported"),
    project: ProjectReferenceBodySchema,
    capabilities: z16.array(CapabilityRecordBodySchema).min(1)
  }).strict()
]);
var RuntimeSignalV1Schema = z16.object({
  schema_version: wireVersion("runtime-signal"),
  event_id: EventIdSchema,
  event_kind: RuntimeSignalKindSchema,
  ...ProducerReferenceBodySchema.shape,
  producer_sequence: z16.number().int().nonnegative().optional(),
  correlation_id: z16.string().min(1).max(128),
  causation_id: EventIdSchema.optional(),
  deduplication_key: z16.string().min(1).max(256),
  owner_fence: z16.string().min(1).max(256).optional(),
  clocks: ClockFactsBodySchema,
  provenance: ProvenanceBodySchema,
  clear_fields: z16.array(z16.string().min(1).max(160)).max(64),
  payload: RuntimeSignalPayloadSchema
}).strict().superRefine((value2, context) => {
  if (value2.event_kind !== value2.payload.kind) {
    context.addIssue({
      code: "custom",
      message: "wire.runtime_signal.kind_mismatch",
      path: ["payload", "kind"]
    });
  }
  const clocks2 = ClockFactsBodySchema.safeParse(value2.clocks);
  if (!clocks2.success) {
    for (const issue of clocks2.error.issues) {
      context.addIssue({
        code: "custom",
        message: issue.message,
        path: ["clocks", ...issue.path]
      });
    }
  }
});

// packages/contracts/dist/websocket.js
import { z as z17 } from "zod";
var WebSocketFramePayloadSchema = z17.discriminatedUnion("kind", [
  z17.object({
    kind: z17.literal("snapshot"),
    cursor: z17.string().min(1).max(512),
    payload: JsonValueSchema
  }).strict(),
  z17.object({
    kind: z17.literal("delta"),
    cursor: z17.string().min(1).max(512),
    delta: JsonValueSchema
  }).strict(),
  z17.object({
    kind: z17.literal("resync_required"),
    reason: z17.enum([
      "instance_changed",
      "cursor_gap",
      "cursor_compacted",
      "policy_changed",
      "protocol_mismatch"
    ]),
    snapshot_url: z17.string().url().max(2048)
  }).strict()
]);
var WebSocketFrameV1Schema = z17.object({
  schema_version: wireVersion("websocket-frame"),
  instance_id: ControlPlaneInstanceIdSchema,
  stream: z17.enum([
    "runtime.live",
    "runtime.history",
    "runtime.diagnostics",
    "projects",
    "tracker.tree",
    "tracker.board",
    "management.controls",
    "communication.operations"
  ]),
  sequence: z17.number().int().nonnegative(),
  resource_revision: z17.number().int().nonnegative(),
  correlation_id: z17.string().min(1).max(128),
  payload: WebSocketFramePayloadSchema
}).strict();

// packages/contracts/dist/registry.js
function entry(name, schema) {
  return {
    name,
    schemaId: schemaIdentifier(name),
    wireVersion: `golem.${name}/v1`,
    fileName: `${name}.schema.json`,
    schema
  };
}
var ContractSchemaRegistry = [
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
  entry("diagnostics-explanation", DiagnosticsExplanationV1Schema)
];

// packages/persistence/dist/owner.js
import fs4 from "node:fs";
import path3 from "node:path";
import Database3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

// packages/persistence/dist/backup-health.js
import fs from "node:fs";
import Database from "better-sqlite3";

// packages/persistence/dist/schema.js
import crypto from "node:crypto";
var busyTimeoutMs = 2500;
var latestRuntimeVersion = 1;
var latestTrackerVersion = 9;
function migrationChecksum(value2) {
  return crypto.createHash("sha256").update(value2).digest("hex");
}
function migration(id, sql2) {
  return Object.freeze({ id, checksum: migrationChecksum(sql2), sql: sql2 });
}
var runtimeMigrations = [
  migration("runtime/001-initial", `
CREATE TABLE runtime_events (
  event_id TEXT PRIMARY KEY,
  deduplication_key TEXT NOT NULL UNIQUE,
  event_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  source_observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  materialized_at TEXT NOT NULL,
  activity_at TEXT,
  metadata_version TEXT NOT NULL DEFAULT 'golem.event/v1',
  disposition TEXT NOT NULL DEFAULT 'accepted' CHECK(disposition IN ('accepted', 'duplicate', 'stale', 'illegal', 'quarantined'))
);
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE project_locations (
  location_id TEXT PRIMARY KEY CHECK(length(location_id) > 0),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  canonical_path TEXT NOT NULL,
  observed_path TEXT,
  relation TEXT NOT NULL CHECK(relation IN ('main', 'worktree', 'registered', 'legacy')),
  source_observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, canonical_path),
  UNIQUE(project_id, location_id)
);
CREATE TABLE location_aliases (
  project_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  alias_path TEXT NOT NULL,
  alias_kind TEXT NOT NULL CHECK(alias_kind IN ('path', 'symlink', 'worktree', 'legacy')),
  observed_at TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  PRIMARY KEY(project_id, alias_path, alias_kind),
  FOREIGN KEY(project_id, location_id) REFERENCES project_locations(project_id, location_id)
);
CREATE TABLE location_relations (
  project_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  related_location_id TEXT NOT NULL,
  relation_kind TEXT NOT NULL CHECK(relation_kind IN ('same_project', 'worktree_of', 'relocated_from', 'legacy_source')),
  observed_at TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  PRIMARY KEY(project_id, location_id, related_location_id, relation_kind),
  CHECK(location_id <> related_location_id),
  FOREIGN KEY(project_id, location_id) REFERENCES project_locations(project_id, location_id),
  FOREIGN KEY(project_id, related_location_id) REFERENCES project_locations(project_id, location_id)
);
CREATE UNIQUE INDEX project_locations_canonical_path_unique
  ON project_locations(canonical_path);
CREATE TABLE project_metadata (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
  name_source TEXT NOT NULL CHECK(name_source IN ('git', 'marker', 'register', 'legacy_import', 'hook')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  provenance_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE project_identity_keys (
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  identity_key TEXT NOT NULL UNIQUE CHECK(length(identity_key) > 0),
  source TEXT NOT NULL CHECK(source IN ('git', 'marker', 'register', 'legacy_import', 'hook')),
  provenance_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, identity_key)
);
CREATE TABLE project_location_state (
  project_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'retired', 'unregistered')),
  last_confirmed_at TEXT,
  provenance_json TEXT NOT NULL,
  PRIMARY KEY(project_id, location_id),
  FOREIGN KEY(project_id, location_id) REFERENCES project_locations(project_id, location_id) ON DELETE CASCADE
);
CREATE TABLE logical_sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, session_id)
);
CREATE TABLE session_generations (
  generation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  harness TEXT NOT NULL CHECK(harness IN ('claude', 'codex', 'opencode', 'pi')),
  lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('starting', 'idle', 'active', 'waiting', 'ending', 'ended', 'errored', 'superseded')),
  lifecycle_schema_version TEXT NOT NULL CHECK(lifecycle_schema_version = 'golem.lifecycle/v1'),
  lifecycle_provenance_json TEXT NOT NULL,
  field_schema_version TEXT NOT NULL CHECK(field_schema_version = 'golem.fields/v1'),
  field_provenance_json TEXT NOT NULL,
  source_observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  activity_at TEXT,
  materialized_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(session_id, ordinal),
  UNIQUE(project_id, generation_id),
  UNIQUE(project_id, session_id, generation_id),
  FOREIGN KEY(project_id, session_id) REFERENCES logical_sessions(project_id, session_id),
  CHECK((lifecycle_state IN ('ended', 'errored', 'superseded') AND ended_at IS NOT NULL) OR (lifecycle_state NOT IN ('ended', 'errored', 'superseded') AND ended_at IS NULL))
);
CREATE TABLE session_aliases (
  project_id TEXT NOT NULL,
  harness TEXT NOT NULL CHECK(harness IN ('claude', 'codex', 'opencode', 'pi')),
  alias_kind TEXT NOT NULL CHECK(alias_kind IN ('native_conversation', 'native_run', 'legacy_canonical_id', 'supervisor_thread', 'bridge_session', 'migration_relation')),
  producer_id TEXT CHECK(producer_id IS NULL OR length(producer_id) > 0),
  alias TEXT NOT NULL CHECK(length(alias) > 0),
  session_id TEXT,
  generation_id TEXT,
  source TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id, session_id) REFERENCES logical_sessions(project_id, session_id),
  FOREIGN KEY(project_id, session_id, generation_id) REFERENCES session_generations(project_id, session_id, generation_id),
  CHECK(generation_id IS NULL OR session_id IS NOT NULL)
);
CREATE UNIQUE INDEX session_aliases_scoped_identity ON session_aliases(project_id, harness, alias_kind, COALESCE(producer_id, ''), alias);
CREATE TABLE producer_watermarks (
  producer_id TEXT PRIMARY KEY,
  watermark TEXT NOT NULL,
  source_observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  materialized_at TEXT NOT NULL,
  provenance_json TEXT NOT NULL
);
CREATE TABLE metadata_versions (
  metadata_key TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('accepted', 'stale', 'superseded', 'rejected')),
  source_observed_at TEXT NOT NULL,
  materialized_at TEXT NOT NULL,
  provenance_json TEXT NOT NULL
);
CREATE TABLE endpoint_claims (
  endpoint_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES session_generations(generation_id),
  route_kind TEXT NOT NULL CHECK(route_kind IN ('control', 'delivery', 'observation')),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  state TEXT NOT NULL CHECK(state IN ('claiming', 'healthy', 'degraded', 'released', 'expired', 'superseded')),
  owner_fence INTEGER NOT NULL CHECK(owner_fence > 0),
  owner_instance_id TEXT NOT NULL CHECK(length(owner_instance_id) > 0),
  delivery_mode TEXT NOT NULL CHECK(delivery_mode IN ('pull', 'native_channel', 'prompt_bridge', 'managed_app_server', 'next_turn')),
  readiness_state TEXT NOT NULL CHECK(readiness_state IN ('ready', 'held_busy', 'held_waiting', 'pull_only', 'next_turn', 'unsupported', 'unhealthy', 'uninitialized')),
  control_state TEXT NOT NULL CHECK(control_state IN ('enabled', 'held', 'disabled')),
  consumer_ready INTEGER NOT NULL DEFAULT 0 CHECK(consumer_ready IN (0, 1)),
  consumption_observed INTEGER NOT NULL DEFAULT 0 CHECK(consumption_observed IN (0, 1)),
  delivery_observed INTEGER NOT NULL DEFAULT 0 CHECK(delivery_observed IN (0, 1)),
  delivery_failed INTEGER NOT NULL DEFAULT 0 CHECK(delivery_failed IN (0, 1)),
  claimed_at TEXT NOT NULL,
  heartbeat_at TEXT,
  expires_at TEXT,
  superseded_at TEXT,
  CHECK((state = 'superseded' AND superseded_at IS NOT NULL) OR (state <> 'superseded'))
);
CREATE UNIQUE INDEX endpoint_claims_one_live_route ON endpoint_claims(generation_id, route_kind) WHERE state IN ('claiming', 'healthy', 'degraded');
CREATE UNIQUE INDEX endpoint_claims_fence ON endpoint_claims(generation_id, route_kind, owner_fence);
CREATE TABLE endpoint_fences (
  generation_id TEXT NOT NULL REFERENCES session_generations(generation_id),
  route_kind TEXT NOT NULL CHECK(route_kind IN ('control', 'delivery', 'observation')),
  fence INTEGER NOT NULL CHECK(fence > 0),
  allocated_at TEXT NOT NULL,
  owner_instance_id TEXT NOT NULL,
  PRIMARY KEY(generation_id, route_kind, fence)
);
CREATE TABLE capability_observations (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES endpoint_claims(endpoint_id),
  capability TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  qualification_state TEXT NOT NULL CHECK(qualification_state IN ('supported', 'experimental', 'unsupported', 'unknown')),
  delivery_mode TEXT NOT NULL CHECK(delivery_mode IN ('pull', 'native_channel', 'prompt_bridge', 'managed_app_server', 'next_turn')),
  readiness_state TEXT NOT NULL CHECK(readiness_state IN ('ready', 'held_busy', 'held_waiting', 'pull_only', 'next_turn', 'unsupported', 'unhealthy', 'uninitialized')),
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('probe', 'configured', 'observed', 'operator')),
  evidence_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE(endpoint_id, capability, evidence_kind, observed_at)
);
CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('accepted', 'rejected', 'executing', 'succeeded', 'failed', 'cancelled')),
  created_at TEXT NOT NULL
);
CREATE TABLE delivery_envelopes (
  delivery_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES commands(command_id),
  endpoint_id TEXT NOT NULL REFERENCES endpoint_claims(endpoint_id),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'delivered', 'acknowledged', 'failed', 'cancelled', 'expired')),
  created_at TEXT NOT NULL
);
CREATE TABLE delivery_acknowledgements (
  delivery_id TEXT NOT NULL REFERENCES delivery_envelopes(delivery_id),
  acknowledgement_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY(delivery_id, acknowledgement_id)
);
CREATE TABLE projection_cursors (
  projection TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE runtime_outbox (
  id TEXT PRIMARY KEY,
  destination TEXT NOT NULL CHECK(destination IN ('tracker', 'management')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'published', 'permanent_failure')),
  created_at TEXT NOT NULL,
  published_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0 AND attempts <= 5),
  claim_owner TEXT,
  claim_token TEXT,
  claim_until TEXT,
  retry_started_at TEXT,
  next_attempt_at TEXT,
  last_error TEXT,
  permanent_failure_at TEXT,
  CHECK((status = 'claimed' AND claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_until IS NOT NULL) OR status <> 'claimed'),
  CHECK((status = 'permanent_failure' AND permanent_failure_at IS NOT NULL) OR status <> 'permanent_failure')
);
CREATE TABLE diagnostics (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE migration_audit (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('runtime', 'tracker')),
  plan_hash TEXT NOT NULL,
  backup_path TEXT,
  applied_at TEXT NOT NULL
);
CREATE TABLE migration_runs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('runtime', 'tracker')),
  plan_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('planned', 'dry_run', 'applying', 'applied', 'failed', 'rolled_back')),
  backup_path TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE migration_findings (
  id TEXT PRIMARY KEY,
  migration_run_id TEXT NOT NULL REFERENCES migration_runs(id),
  code TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE migration_decisions (
  id TEXT PRIMARY KEY,
  migration_run_id TEXT NOT NULL REFERENCES migration_runs(id),
  finding_id TEXT REFERENCES migration_findings(id),
  decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected', 'deferred', 'applied', 'rolled_back')),
  decided_at TEXT NOT NULL
);
CREATE TABLE legacy_snapshots (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_checksum TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  UNIQUE(source_kind, source_checksum)
);
CREATE VIEW live_sessions AS
  SELECT generation_id, session_id, project_id, harness, lifecycle_state, ordinal, activity_at
  FROM session_generations
  WHERE lifecycle_state NOT IN ('ended', 'errored', 'superseded');
CREATE VIEW session_history AS
  SELECT generation_id, session_id, project_id, harness, lifecycle_state, ordinal, source_observed_at, activity_at, materialized_at, ended_at
  FROM session_generations;
CREATE VIEW runtime_diagnostics AS SELECT id, code, details_json, created_at FROM diagnostics;
CREATE INDEX runtime_events_received_at ON runtime_events(received_at);
CREATE INDEX runtime_outbox_claimable ON runtime_outbox(status, next_attempt_at, created_at);
CREATE INDEX capability_observations_endpoint ON capability_observations(endpoint_id, capability, observed_at);
CREATE TABLE session_projection (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  field_provenance_json TEXT NOT NULL DEFAULT '{}',
  role_json TEXT,
  actor_activity_at TEXT,
  observed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, session_id),
  FOREIGN KEY(project_id, session_id) REFERENCES logical_sessions(project_id, session_id) ON DELETE CASCADE
);
CREATE TABLE generation_projection (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  field_provenance_json TEXT NOT NULL DEFAULT '{}',
  parent_generation_id TEXT,
  continuation TEXT,
  actor_activity_at TEXT,
  observed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, session_id, generation_id),
  FOREIGN KEY(project_id, session_id, generation_id) REFERENCES session_generations(project_id, session_id, generation_id) ON DELETE CASCADE
);
CREATE INDEX session_projection_revision ON session_projection(project_id, revision, session_id);
CREATE INDEX generation_projection_revision ON generation_projection(project_id, session_id, revision, generation_id);
CREATE TABLE session_pending_events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  event_json TEXT NOT NULL,
  source_observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  producer_instance_id TEXT NOT NULL
);
`)
];
var trackerMigrations = [
  migration("tracker/001-baseline", `
CREATE TABLE migration_audit (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  backup_path TEXT,
  applied_at TEXT NOT NULL
);
`),
  migration("tracker/002-durable-delivery-bus", `
CREATE TABLE tracker_envelopes (
  id TEXT PRIMARY KEY CHECK(length(id) > 0),
  root_id TEXT NOT NULL REFERENCES tracker_envelopes(id),
  parent_id TEXT REFERENCES tracker_envelopes(id),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) > 0),
  fingerprint TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  reply_to_recipient_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  endpoint_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'delivered', 'acknowledged', 'retrying', 'dead_letter', 'expired', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 20),
  deadline_at TEXT,
  next_attempt_at TEXT,
  claim_owner TEXT,
  claim_token TEXT,
  claim_until TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  acknowledged_at TEXT,
  last_error TEXT,
  CHECK((status = 'claimed' AND claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_until IS NOT NULL) OR status <> 'claimed')
);
CREATE INDEX tracker_envelopes_claimable ON tracker_envelopes(status, next_attempt_at, created_at);
CREATE INDEX tracker_envelopes_recipient ON tracker_envelopes(recipient_id, status);
CREATE TABLE tracker_envelope_acknowledgements (
  envelope_id TEXT NOT NULL REFERENCES tracker_envelopes(id) ON DELETE CASCADE,
  acknowledgement_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY(envelope_id, acknowledgement_id)
);
CREATE TABLE tracker_bus_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  deduplication_key TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  topic TEXT NOT NULL,
  class TEXT NOT NULL CHECK(class IN ('tracker', 'lifecycle', 'custom')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX tracker_bus_events_topic_sequence ON tracker_bus_events(topic, sequence);
CREATE TABLE tracker_subscriptions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  classes_json TEXT NOT NULL,
  cursor_sequence INTEGER NOT NULL DEFAULT 0 CHECK(cursor_sequence >= 0),
  manual INTEGER NOT NULL CHECK(manual IN (0, 1)),
  status TEXT NOT NULL CHECK(status IN ('active', 'offline', 'suspended')),
  created_at TEXT NOT NULL,
  UNIQUE(recipient_id, name)
);
CREATE INDEX tracker_subscriptions_topic_cursor ON tracker_subscriptions(topic, cursor_sequence, status);
CREATE TABLE tracker_passive_slots (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  category TEXT NOT NULL,
  baseline_json TEXT NOT NULL,
  value_json TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(recipient_id, ticket_id, category)
);
CREATE INDEX tracker_passive_slots_recipient ON tracker_passive_slots(recipient_id, sequence);
CREATE TABLE tracker_passive_cursors (
  recipient_id TEXT PRIMARY KEY,
  cursor_sequence INTEGER NOT NULL DEFAULT 0 CHECK(cursor_sequence >= 0),
  pending_json TEXT,
  pending_to_sequence INTEGER,
  lease_id TEXT,
  lease_until TEXT,
  updated_at TEXT NOT NULL,
  CHECK((pending_json IS NULL AND pending_to_sequence IS NULL) OR (pending_json IS NOT NULL AND pending_to_sequence IS NOT NULL)),
  CHECK((lease_id IS NULL AND lease_until IS NULL) OR (lease_id IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE TABLE tracker_delivery_audit (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX tracker_delivery_audit_subject ON tracker_delivery_audit(subject_id, created_at);
`),
  migration("tracker/003-live-tracker-core", `
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, project_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'work-item', title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'todo',
  phase TEXT, priority TEXT, labels TEXT NOT NULL DEFAULT '[]',
  stream_id TEXT, parent_id TEXT, wave INTEGER, assignee TEXT,
  created_by TEXT NOT NULL DEFAULT 'human', dispatched_to TEXT,
  dispatched_at TEXT, source_ref TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, rank INTEGER NOT NULL DEFAULT 0,
  state_changed_at TEXT, done_at TEXT, archived_at TEXT,
  pseq INTEGER, display_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_id);
CREATE INDEX IF NOT EXISTS idx_tickets_state ON tickets(state);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee);
CREATE INDEX IF NOT EXISTS idx_tickets_dispatched_to ON tickets(dispatched_to);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_display ON tickets(display_id) WHERE display_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author TEXT NOT NULL, body TEXT NOT NULL, quote TEXT, prefix TEXT,
  suffix TEXT, section TEXT, section_id TEXT, tag TEXT NOT NULL DEFAULT 'note',
  status TEXT NOT NULL DEFAULT 'open', dispatch_state TEXT NOT NULL DEFAULT 'undispatched',
  parent_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id);
CREATE TABLE IF NOT EXISTS streams (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'parallel', description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_streams_project ON streams(project_id);
CREATE TABLE IF NOT EXISTS links (
  from_ticket TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  to_ticket TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  type TEXT NOT NULL, PRIMARY KEY(from_ticket, to_ticket, type)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_uuid TEXT, ticket_id TEXT,
  project_id TEXT, topic TEXT, class TEXT NOT NULL DEFAULT 'tracker',
  type TEXT NOT NULL, actor TEXT, actor_kind TEXT NOT NULL DEFAULT 'system',
  actor_label TEXT, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON events(ticket_id);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_uuid ON events(event_uuid) WHERE event_uuid IS NOT NULL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_prefixes (project_id TEXT PRIMARY KEY, prefix TEXT NOT NULL UNIQUE);
		`),
  migration("tracker/004-management-services", `
CREATE TABLE management_roles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0 AND length(name) <= 128),
  scope TEXT NOT NULL CHECK(scope IN ('project', 'session', 'generation')),
  definition_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);
CREATE TABLE management_role_assignments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT,
  generation_id TEXT,
  role_id TEXT NOT NULL REFERENCES management_roles(id) ON DELETE CASCADE,
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  idempotency_key TEXT NOT NULL CHECK(length(trim(idempotency_key)) > 0),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key)
);
CREATE TABLE management_gates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('approval', 'input')),
  status TEXT NOT NULL CHECK(status IN ('awaiting', 'approved', 'denied', 'cancelled')),
  question TEXT NOT NULL CHECK(length(trim(question)) > 0 AND length(question) <= 4096),
  assignee TEXT NOT NULL CHECK(length(trim(assignee)) > 0),
  verdict_json TEXT,
  idempotency_key TEXT NOT NULL CHECK(length(trim(idempotency_key)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key),
  CHECK((status = 'awaiting' AND verdict_json IS NULL) OR (status <> 'awaiting' AND verdict_json IS NOT NULL))
);
CREATE TABLE management_ideas (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK(length(trim(body)) > 0 AND length(body) <= 16384),
  status TEXT NOT NULL CHECK(status IN ('pending', 'popped', 'promoted')),
  promoted_ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL CHECK(length(trim(idempotency_key)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key),
  CHECK((status = 'promoted' AND promoted_ticket_id IS NOT NULL) OR (status <> 'promoted'))
);
CREATE TABLE management_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL CHECK(length(relative_path) > 0 AND relative_path NOT LIKE '/%' AND relative_path NOT LIKE '%..%'),
  mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0 AND byte_size <= 10485760),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, ticket_id, relative_path)
);
CREATE TABLE management_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT,
  generation_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('chat', 'brief', 'interrupt', 'halt', 'control')),
  command TEXT NOT NULL CHECK(length(trim(command)) > 0 AND length(command) <= 128),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'ineligible', 'delivered')),
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  idempotency_key TEXT NOT NULL CHECK(length(trim(idempotency_key)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key)
);
CREATE TABLE management_audit (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE management_outbox (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'published')),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key)
);
CREATE INDEX management_roles_project ON management_roles(project_id, name);
CREATE INDEX management_gates_project_status ON management_gates(project_id, status, created_at);
CREATE INDEX management_ideas_project_status ON management_ideas(project_id, status, created_at);
CREATE INDEX management_operations_project_created ON management_operations(project_id, created_at);
CREATE INDEX management_audit_project_created ON management_audit(project_id, created_at);
`),
  migration("tracker/005-comment-dispatches", `
CREATE TABLE IF NOT EXISTS comment_dispatches (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  batch_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'addressed', 'cancelled')),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  addressed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_comment_dispatches_comment ON comment_dispatches(comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_dispatches_ticket_session_status ON comment_dispatches(ticket_id, session_id, status);
CREATE INDEX IF NOT EXISTS idx_comment_dispatches_pending ON comment_dispatches(status) WHERE status IN ('pending', 'delivered');
`),
  migration("tracker/006-browser-principal-policy", `
CREATE TABLE browser_principal_bindings (
  id TEXT PRIMARY KEY CHECK(length(id) >= 8),
  actor_id TEXT NOT NULL CHECK(length(trim(actor_id)) > 0),
  role TEXT NOT NULL CHECK(role IN ('operator', 'viewer')),
  default_project_id TEXT NOT NULL CHECK(length(trim(default_project_id)) > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE browser_principal_scopes (
  binding_id TEXT NOT NULL REFERENCES browser_principal_bindings(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL CHECK(length(trim(project_id)) > 0),
  PRIMARY KEY(binding_id, project_id)
);
CREATE TABLE browser_principal_credentials (
  adapter TEXT NOT NULL CHECK(adapter IN ('bearer', 'mcp', 'internal')),
  credential_digest TEXT NOT NULL CHECK(length(credential_digest) = 64),
  binding_id TEXT NOT NULL REFERENCES browser_principal_bindings(id) ON DELETE CASCADE,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(adapter, credential_digest)
);
CREATE TABLE browser_principal_sessions (
  session_digest TEXT PRIMARY KEY CHECK(length(session_digest) = 64),
  csrf_digest TEXT NOT NULL CHECK(length(csrf_digest) = 64),
  binding_id TEXT NOT NULL REFERENCES browser_principal_bindings(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX browser_principal_scope_project ON browser_principal_scopes(project_id, binding_id);
CREATE INDEX browser_principal_sessions_binding ON browser_principal_sessions(binding_id, expires_at);
`),
  migration("tracker/007-command-receipts", `
CREATE TABLE command_receipts (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) > 0),
  project_id TEXT NOT NULL CHECK(length(trim(project_id)) > 0),
  idempotency_key TEXT NOT NULL CHECK(length(trim(idempotency_key)) > 0),
  command_kind TEXT NOT NULL CHECK(length(command_kind) > 0),
  actor_id TEXT NOT NULL CHECK(length(trim(actor_id)) > 0),
  resource_type TEXT NOT NULL CHECK(length(resource_type) > 0),
  resource_id TEXT NOT NULL CHECK(length(resource_id) > 0),
  correlation_id TEXT NOT NULL CHECK(length(correlation_id) > 0),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) > 0),
  outcome_status TEXT NOT NULL CHECK(outcome_status IN ('accepted','completed','rejected','conflict','pending','idempotency_mismatch')),
  reason_code TEXT,
  operation_id TEXT,
  result_json TEXT NOT NULL DEFAULT '{}',
  committed_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key)
);
CREATE INDEX command_receipts_lookup ON command_receipts(project_id, idempotency_key);
CREATE INDEX command_receipts_resource ON command_receipts(project_id, resource_type, resource_id);
		`),
  migration("tracker/008-committed-publication-outbox", `
/*
 * GOL-80 publication is a persistence-owned extension of GOL-36, never a
 * browser event store.  Rows carry only allowlisted category/scope/revision
 * facts.  Historic management_outbox payloads remain preserved in place and
 * are deliberately not replayed by this new dispatcher.
 */
CREATE TABLE committed_project_revisions (
  project_id TEXT PRIMARY KEY CHECK(length(trim(project_id)) > 0),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_at TEXT NOT NULL
);
CREATE TABLE committed_resource_revisions (
  project_id TEXT NOT NULL REFERENCES committed_project_revisions(project_id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK(length(resource_type) > 0 AND length(resource_type) <= 64),
  resource_id TEXT NOT NULL CHECK(length(resource_id) > 0 AND length(resource_id) <= 256),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, resource_type, resource_id)
);
CREATE TABLE committed_publication_outbox (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES committed_project_revisions(project_id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK(category IN ('tracker', 'management', 'communication', 'asset', 'delivery')),
  resource_type TEXT NOT NULL CHECK(length(resource_type) > 0 AND length(resource_type) <= 64),
  resource_id TEXT NOT NULL CHECK(length(resource_id) > 0 AND length(resource_id) <= 256),
  resource_revision INTEGER NOT NULL CHECK(resource_revision >= 1),
  project_revision INTEGER NOT NULL CHECK(project_revision >= 1),
  schema_version TEXT NOT NULL CHECK(schema_version = 'golem.committed-invalidation/v1'),
  policy_version INTEGER NOT NULL CHECK(policy_version >= 1),
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'published')),
  created_at TEXT NOT NULL,
  published_at TEXT,
  claim_owner TEXT,
  claim_token TEXT,
  claim_until TEXT,
  CHECK((status = 'claimed' AND claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_until IS NOT NULL) OR status <> 'claimed')
);
CREATE INDEX committed_publication_claimable ON committed_publication_outbox(status, created_at, id);
CREATE INDEX committed_publication_project ON committed_publication_outbox(project_id, project_revision);

/* Delivery and bus rows predate project-scoped invalidations.  Preserve every
 * historic row as system-scoped (there is no safe inference), while all new
 * typed callers provide the project id. */
ALTER TABLE tracker_envelopes ADD COLUMN project_id TEXT NOT NULL DEFAULT 'system';
ALTER TABLE tracker_bus_events ADD COLUMN project_id TEXT NOT NULL DEFAULT 'system';
CREATE INDEX tracker_envelopes_project ON tracker_envelopes(project_id, status);
CREATE INDEX tracker_bus_events_project_sequence ON tracker_bus_events(project_id, sequence);

/* Each trigger advances one resource revision and one project-visible revision,
 * then appends one opaque row in the enclosing SQLite transaction. */
CREATE TRIGGER committed_pub_ticket_insert AFTER INSERT ON tickets BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at)
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'tracker.ticket', NEW.id, 1, NEW.updated_at)
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'tracker', 'tracker.ticket', NEW.id,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'tracker.ticket' AND resource_id = NEW.id),
      (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_ticket_update AFTER UPDATE ON tickets WHEN NEW.updated_at <> OLD.updated_at BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at)
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'tracker.ticket', NEW.id, 1, NEW.updated_at)
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'tracker', 'tracker.ticket', NEW.id,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'tracker.ticket' AND resource_id = NEW.id),
      (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_comment_insert AFTER INSERT ON comments BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) SELECT project_id, 1, NEW.updated_at FROM tickets WHERE id = NEW.ticket_id
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) SELECT project_id, 'tracker.comment', NEW.id, 1, NEW.updated_at FROM tickets WHERE id = NEW.ticket_id
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    SELECT 'cpub_' || lower(hex(randomblob(16))), project_id, 'tracker', 'tracker.comment', NEW.id,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = tickets.project_id AND resource_type = 'tracker.comment' AND resource_id = NEW.id),
      (SELECT revision FROM committed_project_revisions WHERE project_id = tickets.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at FROM tickets WHERE id = NEW.ticket_id;
END;
CREATE TRIGGER committed_pub_comment_update AFTER UPDATE ON comments WHEN NEW.updated_at <> OLD.updated_at BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) SELECT project_id, 1, NEW.updated_at FROM tickets WHERE id = NEW.ticket_id
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) SELECT project_id, 'tracker.comment', NEW.id, 1, NEW.updated_at FROM tickets WHERE id = NEW.ticket_id
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    SELECT 'cpub_' || lower(hex(randomblob(16))), project_id, 'tracker', 'tracker.comment', NEW.id,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = tickets.project_id AND resource_type = 'tracker.comment' AND resource_id = NEW.id),
      (SELECT revision FROM committed_project_revisions WHERE project_id = tickets.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at FROM tickets WHERE id = NEW.ticket_id;
END;
CREATE TRIGGER committed_pub_stream_insert AFTER INSERT ON streams BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at)
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'tracker.stream', NEW.id, 1, NEW.updated_at)
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'tracker', 'tracker.stream', NEW.id,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'tracker.stream' AND resource_id = NEW.id),
      (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_stream_update AFTER UPDATE ON streams WHEN NEW.updated_at <> OLD.updated_at BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at)
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'tracker.stream', NEW.id, 1, NEW.updated_at)
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'tracker', 'tracker.stream', NEW.id,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'tracker.stream' AND resource_id = NEW.id),
      (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_link_insert AFTER INSERT ON links BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) SELECT project_id, 1, updated_at FROM tickets WHERE id = NEW.from_ticket
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) SELECT project_id, 'tracker.link', NEW.from_ticket || ':' || NEW.to_ticket || ':' || NEW.type, 1, updated_at FROM tickets WHERE id = NEW.from_ticket
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    SELECT 'cpub_' || lower(hex(randomblob(16))), project_id, 'tracker', 'tracker.link', NEW.from_ticket || ':' || NEW.to_ticket || ':' || NEW.type,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = tickets.project_id AND resource_type = 'tracker.link' AND resource_id = NEW.from_ticket || ':' || NEW.to_ticket || ':' || NEW.type),
      (SELECT revision FROM committed_project_revisions WHERE project_id = tickets.project_id), 'golem.committed-invalidation/v1', 1, 'pending', updated_at FROM tickets WHERE id = NEW.from_ticket;
END;
CREATE TRIGGER committed_pub_link_delete AFTER DELETE ON links BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) SELECT project_id, 1, updated_at FROM tickets WHERE id = OLD.from_ticket
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) SELECT project_id, 'tracker.link', OLD.from_ticket || ':' || OLD.to_ticket || ':' || OLD.type, 1, updated_at FROM tickets WHERE id = OLD.from_ticket
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    SELECT 'cpub_' || lower(hex(randomblob(16))), project_id, 'tracker', 'tracker.link', OLD.from_ticket || ':' || OLD.to_ticket || ':' || OLD.type,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = tickets.project_id AND resource_type = 'tracker.link' AND resource_id = OLD.from_ticket || ':' || OLD.to_ticket || ':' || OLD.type),
      (SELECT revision FROM committed_project_revisions WHERE project_id = tickets.project_id), 'golem.committed-invalidation/v1', 1, 'pending', updated_at FROM tickets WHERE id = OLD.from_ticket;
END;

CREATE TRIGGER committed_pub_management_role_insert AFTER INSERT ON management_roles BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.role', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.role', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.role' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_management_role_update AFTER UPDATE ON management_roles WHEN NEW.updated_at <> OLD.updated_at BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.role', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.role', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.role' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_management_assignment_insert AFTER INSERT ON management_role_assignments BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.created_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.assignment', NEW.id, 1, NEW.created_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.assignment', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.assignment' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.created_at);
END;
CREATE TRIGGER committed_pub_management_gate_insert AFTER INSERT ON management_gates BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.gate', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.gate', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.gate' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_management_gate_update AFTER UPDATE ON management_gates WHEN NEW.updated_at <> OLD.updated_at BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.gate', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.gate', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.gate' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_management_idea_insert AFTER INSERT ON management_ideas BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.idea', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.idea', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.idea' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_management_idea_update AFTER UPDATE ON management_ideas WHEN NEW.updated_at <> OLD.updated_at BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.idea', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.idea', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.idea' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_management_asset_insert AFTER INSERT ON management_assets BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.created_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.asset', NEW.id, 1, NEW.created_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'asset', 'management.asset', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.asset' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.created_at);
END;
CREATE TRIGGER committed_pub_management_operation_insert AFTER INSERT ON management_operations BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'communication.operation', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'communication', 'communication.operation', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'communication.operation' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;
CREATE TRIGGER committed_pub_management_operation_update AFTER UPDATE ON management_operations WHEN NEW.updated_at <> OLD.updated_at BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'communication.operation', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'communication', 'communication.operation', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'communication.operation' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;

CREATE TRIGGER committed_pub_delivery_envelope_insert AFTER INSERT ON tracker_envelopes BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.created_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'delivery.envelope', NEW.id, 1, NEW.created_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'delivery', 'delivery.envelope', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'delivery.envelope' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.created_at);
END;
CREATE TRIGGER committed_pub_delivery_envelope_settlement AFTER UPDATE ON tracker_envelopes WHEN NEW.status <> OLD.status AND NEW.status <> 'claimed' BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, COALESCE(NEW.delivered_at, NEW.created_at)) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'delivery.envelope', NEW.id, 1, COALESCE(NEW.delivered_at, NEW.created_at)) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'delivery', 'delivery.envelope', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'delivery.envelope' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', COALESCE(NEW.delivered_at, NEW.created_at));
END;
CREATE TRIGGER committed_pub_delivery_ack_insert AFTER INSERT ON tracker_envelope_acknowledgements BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) SELECT project_id, 1, NEW.acknowledged_at FROM tracker_envelopes WHERE id = NEW.envelope_id ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) SELECT project_id, 'delivery.ack', NEW.envelope_id || ':' || NEW.acknowledgement_id, 1, NEW.acknowledged_at FROM tracker_envelopes WHERE id = NEW.envelope_id ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) SELECT 'cpub_' || lower(hex(randomblob(16))), project_id, 'delivery', 'delivery.ack', NEW.envelope_id || ':' || NEW.acknowledgement_id, (SELECT revision FROM committed_resource_revisions WHERE project_id = tracker_envelopes.project_id AND resource_type = 'delivery.ack' AND resource_id = NEW.envelope_id || ':' || NEW.acknowledgement_id), (SELECT revision FROM committed_project_revisions WHERE project_id = tracker_envelopes.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.acknowledged_at FROM tracker_envelopes WHERE id = NEW.envelope_id;
END;
CREATE TRIGGER committed_pub_bus_insert AFTER INSERT ON tracker_bus_events BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.created_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'delivery.bus', NEW.id, 1, NEW.created_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'delivery', 'delivery.bus', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'delivery.bus' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.created_at);
END;
`),
  migration("tracker/009-semantic-committed-publication", `
/* GOL-80 repair: timestamps are observation facts, not semantic change
 * detectors.  Recreate the update triggers with null-safe domain-column
 * predicates so fixed clocks cannot hide a committed mutation and an actual
 * no-op cannot manufacture a revision/outbox row. */
DROP TRIGGER committed_pub_ticket_update;
DROP TRIGGER committed_pub_comment_update;
DROP TRIGGER committed_pub_stream_update;
DROP TRIGGER committed_pub_management_role_update;
DROP TRIGGER committed_pub_management_gate_update;
DROP TRIGGER committed_pub_management_idea_update;
DROP TRIGGER committed_pub_management_operation_update;
DROP TRIGGER committed_pub_delivery_envelope_settlement;

CREATE TRIGGER committed_pub_ticket_update AFTER UPDATE ON tickets
WHEN NEW.kind IS NOT OLD.kind OR NEW.title IS NOT OLD.title
  OR NEW.body IS NOT OLD.body OR NEW.state IS NOT OLD.state
  OR NEW.phase IS NOT OLD.phase OR NEW.priority IS NOT OLD.priority
  OR NEW.labels IS NOT OLD.labels OR NEW.stream_id IS NOT OLD.stream_id
  OR NEW.parent_id IS NOT OLD.parent_id OR NEW.wave IS NOT OLD.wave
  OR NEW.assignee IS NOT OLD.assignee OR NEW.created_by IS NOT OLD.created_by
  OR NEW.dispatched_to IS NOT OLD.dispatched_to
  OR NEW.source_ref IS NOT OLD.source_ref OR NEW.rank IS NOT OLD.rank
  OR NEW.display_id IS NOT OLD.display_id
BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at)
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'tracker.ticket', NEW.id, 1, NEW.updated_at)
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'tracker', 'tracker.ticket', NEW.id,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'tracker.ticket' AND resource_id = NEW.id),
      (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;

CREATE TRIGGER committed_pub_comment_update AFTER UPDATE ON comments
WHEN NEW.ticket_id IS NOT OLD.ticket_id OR NEW.author IS NOT OLD.author
  OR NEW.body IS NOT OLD.body OR NEW.quote IS NOT OLD.quote
  OR NEW.prefix IS NOT OLD.prefix OR NEW.suffix IS NOT OLD.suffix
  OR NEW.section IS NOT OLD.section OR NEW.section_id IS NOT OLD.section_id
  OR NEW.tag IS NOT OLD.tag OR NEW.status IS NOT OLD.status
  OR NEW.dispatch_state IS NOT OLD.dispatch_state OR NEW.parent_id IS NOT OLD.parent_id
BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) SELECT project_id, 1, NEW.updated_at FROM tickets WHERE id = NEW.ticket_id
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) SELECT project_id, 'tracker.comment', NEW.id, 1, NEW.updated_at FROM tickets WHERE id = NEW.ticket_id
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    SELECT 'cpub_' || lower(hex(randomblob(16))), project_id, 'tracker', 'tracker.comment', NEW.id,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = tickets.project_id AND resource_type = 'tracker.comment' AND resource_id = NEW.id),
      (SELECT revision FROM committed_project_revisions WHERE project_id = tickets.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at FROM tickets WHERE id = NEW.ticket_id;
END;

CREATE TRIGGER committed_pub_stream_update AFTER UPDATE ON streams
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.name IS NOT OLD.name
  OR NEW.mode IS NOT OLD.mode OR NEW.description IS NOT OLD.description
BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at)
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'tracker.stream', NEW.id, 1, NEW.updated_at)
    ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at)
    VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'tracker', 'tracker.stream', NEW.id,
      (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'tracker.stream' AND resource_id = NEW.id),
      (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;

CREATE TRIGGER committed_pub_management_role_update AFTER UPDATE ON management_roles
WHEN NEW.name IS NOT OLD.name OR NEW.scope IS NOT OLD.scope
  OR NEW.definition_json IS NOT OLD.definition_json
BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.role', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.role', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.role' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;

CREATE TRIGGER committed_pub_management_gate_update AFTER UPDATE ON management_gates
WHEN NEW.kind IS NOT OLD.kind OR NEW.status IS NOT OLD.status
  OR NEW.question IS NOT OLD.question OR NEW.assignee IS NOT OLD.assignee
  OR NEW.verdict_json IS NOT OLD.verdict_json
BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.gate', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.gate', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.gate' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;

CREATE TRIGGER committed_pub_management_idea_update AFTER UPDATE ON management_ideas
WHEN NEW.body IS NOT OLD.body OR NEW.status IS NOT OLD.status
  OR NEW.promoted_ticket_id IS NOT OLD.promoted_ticket_id
BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'management.idea', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'management', 'management.idea', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'management.idea' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;

CREATE TRIGGER committed_pub_management_operation_update AFTER UPDATE ON management_operations
WHEN NEW.session_id IS NOT OLD.session_id OR NEW.generation_id IS NOT OLD.generation_id
  OR NEW.kind IS NOT OLD.kind OR NEW.command IS NOT OLD.command
  OR NEW.payload_json IS NOT OLD.payload_json OR NEW.status IS NOT OLD.status
  OR NEW.actor IS NOT OLD.actor
BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, NEW.updated_at) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'communication.operation', NEW.id, 1, NEW.updated_at) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'communication', 'communication.operation', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'communication.operation' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', NEW.updated_at);
END;

/* acknowledgeEnvelope inserts one acknowledgement and changes status in one
 * transaction.  The acknowledgement trigger is the sole canonical owner for
 * that event; every other terminal delivery status stays envelope-owned. */
CREATE TRIGGER committed_pub_delivery_envelope_settlement AFTER UPDATE ON tracker_envelopes
WHEN NEW.status <> OLD.status AND NEW.status <> 'claimed' AND NEW.status <> 'acknowledged'
BEGIN
  INSERT INTO committed_project_revisions(project_id, revision, updated_at) VALUES (NEW.project_id, 1, COALESCE(NEW.delivered_at, NEW.created_at)) ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_resource_revisions(project_id, resource_type, resource_id, revision, updated_at) VALUES (NEW.project_id, 'delivery.envelope', NEW.id, 1, COALESCE(NEW.delivered_at, NEW.created_at)) ON CONFLICT(project_id, resource_type, resource_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
  INSERT INTO committed_publication_outbox(id, project_id, category, resource_type, resource_id, resource_revision, project_revision, schema_version, policy_version, status, created_at) VALUES ('cpub_' || lower(hex(randomblob(16))), NEW.project_id, 'delivery', 'delivery.envelope', NEW.id, (SELECT revision FROM committed_resource_revisions WHERE project_id = NEW.project_id AND resource_type = 'delivery.envelope' AND resource_id = NEW.id), (SELECT revision FROM committed_project_revisions WHERE project_id = NEW.project_id), 'golem.committed-invalidation/v1', 1, 'pending', COALESCE(NEW.delivered_at, NEW.created_at));
END;
`)
];
function migrationSet(scope) {
  return scope === "runtime" ? runtimeMigrations : trackerMigrations;
}
function latestVersion(scope) {
  return scope === "runtime" ? latestRuntimeVersion : latestTrackerVersion;
}
function numericPragma(database, source2) {
  const result2 = database.pragma(source2, { simple: true });
  const value2 = Array.isArray(result2) ? result2[0] : result2;
  return typeof value2 === "number" ? value2 : Number(value2);
}
function textPragma(database, source2) {
  const result2 = database.pragma(source2, { simple: true });
  const value2 = Array.isArray(result2) ? result2[0] : result2;
  return String(value2).toLowerCase();
}
function configure(database) {
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma(`busy_timeout = ${busyTimeoutMs}`);
  database.pragma("synchronous = FULL");
}
function currentVersion(database) {
  return numericPragma(database, "user_version");
}
function tableExists(database, name) {
  return Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}
function hasTrackerTables(database) {
  const result2 = database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT IN ('sqlite_sequence', 'golem_migrations', 'migration_audit')").get();
  return (result2?.count ?? 0) > 0;
}
function hasManagedTrackerSchema(database) {
  return tableExists(database, "golem_migrations") && tableExists(database, "tracker_envelopes") && tableExists(database, "tracker_bus_events");
}
function sha256(value2) {
  return crypto.createHash("sha256").update(value2).digest("hex");
}

// packages/persistence/dist/types.js
var PersistenceMigrationError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "PersistenceMigrationError";
    this.code = code;
  }
};
var PersistenceOwnerConflictError = class extends Error {
  diagnostic;
  constructor(diagnostic) {
    super("persistence owner already holds the runtime lock");
    this.name = "PersistenceOwnerConflictError";
    this.diagnostic = diagnostic;
  }
};
var RuntimeFailpointError = class extends Error {
  failpoint;
  constructor(failpoint) {
    super(`runtime failpoint reached: ${failpoint}`);
    this.name = "RuntimeFailpointError";
    this.failpoint = failpoint;
  }
};

// packages/persistence/dist/backup-health.js
function sqlString(value2) {
  return `'${value2.replace(/'/gu, "''")}'`;
}
function health(database) {
  return Object.freeze({
    foreignKeys: numericPragma(database, "foreign_keys") === 1,
    journalMode: textPragma(database, "journal_mode"),
    busyTimeoutMs: numericPragma(database, "busy_timeout"),
    synchronous: textPragma(database, "synchronous"),
    integrity: textPragma(database, "integrity_check"),
    foreignKeyViolations: database.prepare("PRAGMA foreign_key_check").all().length,
    userVersion: currentVersion(database)
  });
}
function verifyDatabase(target) {
  const verified = new Database(target, {
    readonly: true,
    fileMustExist: true
  });
  try {
    const result2 = health(verified);
    if (result2.integrity !== "ok" || result2.foreignKeyViolations > 0) {
      throw new PersistenceMigrationError("backup_failed", `database verification failed: integrity=${result2.integrity} foreign_keys=${result2.foreignKeyViolations}`);
    }
    return result2;
  } finally {
    verified.close();
  }
}
function backupDatabase(database, databasePath, clock) {
  const backupPath = `${databasePath}.golem-backup-${clock.now().replaceAll(/[:.]/gu, "-")}.db`;
  try {
    database.pragma("wal_checkpoint(PASSIVE)");
    database.exec(`VACUUM INTO ${sqlString(backupPath)}`);
    verifyDatabase(backupPath);
    return backupPath;
  } catch (error) {
    if (error instanceof PersistenceMigrationError)
      throw error;
    throw new PersistenceMigrationError("backup_failed", `backup failed before migration: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function cloneDatabase(database, databasePath, clock) {
  const clonePath = `${databasePath}.golem-dry-run-${process.pid}-${clock.now().replaceAll(/[:.]/gu, "-")}.db`;
  database.exec(`VACUUM INTO ${sqlString(clonePath)}`);
  return clonePath;
}

// packages/persistence/dist/browser-principal-repository.js
import crypto2 from "node:crypto";
function digest(value2) {
  return crypto2.createHash("sha256").update(value2).digest("hex");
}
function validText(value2) {
  return value2.trim().length > 0 && value2.length <= 512;
}
function validTimestamp(value2) {
  return Number.isFinite(Date.parse(value2));
}
function active(row, now3) {
  return row.enabled === 1 && row.revoked_at === null && (row.expires_at === null || validTimestamp(row.expires_at) && Date.parse(row.expires_at) > Date.parse(now3));
}
var BrowserPrincipalRepository = class {
  #database;
  #clock;
  constructor(database, clock) {
    this.#database = database;
    this.#clock = clock;
  }
  #binding(row, now3) {
    if (now3 !== void 0 && !active(row, now3))
      return void 0;
    const scopes = this.#database.prepare("SELECT project_id FROM browser_principal_scopes WHERE binding_id = ? ORDER BY project_id").all(row.id).map((scope) => scope.project_id);
    if (!scopes.includes(row.default_project_id))
      return void 0;
    return Object.freeze({
      id: row.id,
      actorId: row.actor_id,
      role: row.role,
      defaultProjectId: row.default_project_id,
      scopeProjectIds: Object.freeze(scopes),
      enabled: row.enabled === 1,
      version: Number(row.version),
      ...row.expires_at ? { expiresAt: row.expires_at } : {},
      ...row.revoked_at ? { revokedAt: row.revoked_at } : {}
    });
  }
  provision(input) {
    if (!validText(input.id) || !validText(input.actorId) || !validText(input.defaultProjectId) || input.scopeProjectIds.length === 0 || !input.scopeProjectIds.every(validText) || !input.scopeProjectIds.includes(input.defaultProjectId) || input.expiresAt !== void 0 && !validTimestamp(input.expiresAt))
      throw new Error("principal binding provision is invalid");
    const scopes = [...new Set(input.scopeProjectIds)].sort();
    const now3 = this.#clock.now();
    const transaction = this.#database.transaction(() => {
      this.#database.prepare("INSERT INTO browser_principal_bindings (id, actor_id, role, default_project_id, enabled, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(input.id, input.actorId, input.role, input.defaultProjectId, input.enabled === false ? 0 : 1, input.expiresAt ?? null, now3, now3);
      const insertScope = this.#database.prepare("INSERT INTO browser_principal_scopes (binding_id, project_id) VALUES (?, ?)");
      for (const projectId3 of scopes)
        insertScope.run(input.id, projectId3);
    });
    transaction.immediate();
    const row = this.#database.prepare("SELECT id, actor_id, role, default_project_id, enabled, version, expires_at, revoked_at FROM browser_principal_bindings WHERE id = ?").get(input.id);
    if (!row)
      throw new Error("principal binding provision was not durable");
    const binding = this.#binding(row);
    if (!binding)
      throw new Error("principal binding scope is invalid");
    return binding;
  }
  bindCredential(input) {
    if (!validText(input.credential))
      throw new Error("principal credential is invalid");
    if (input.expiresAt !== void 0 && !validTimestamp(input.expiresAt))
      throw new Error("principal credential expiry is invalid");
    const exists = this.#database.prepare("SELECT id FROM browser_principal_bindings WHERE id = ?").get(input.bindingId);
    if (!exists)
      throw new Error("principal binding is unknown");
    this.#database.prepare("INSERT INTO browser_principal_credentials (adapter, credential_digest, binding_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(input.adapter, digest(input.credential), input.bindingId, input.expiresAt ?? null, this.#clock.now());
  }
  resolveCredential(input) {
    if (!validText(input.credential))
      return void 0;
    const row = this.#database.prepare(`SELECT binding.id, binding.actor_id, binding.role, binding.default_project_id, binding.enabled, binding.version, binding.expires_at, binding.revoked_at, credential.expires_at AS credential_expires_at FROM browser_principal_credentials AS credential JOIN browser_principal_bindings AS binding ON binding.id = credential.binding_id WHERE credential.adapter = ? AND credential.credential_digest = ? AND credential.revoked_at IS NULL AND (credential.expires_at IS NULL OR credential.expires_at > ?)`).get(input.adapter, digest(input.credential), input.now);
    if (row && row.credential_expires_at !== null && (!validTimestamp(row.credential_expires_at) || Date.parse(row.credential_expires_at) <= Date.parse(input.now)))
      return void 0;
    return row ? this.#binding(row, input.now) : void 0;
  }
  createBrowserSession(input) {
    if (!validText(input.session) || !validText(input.csrf) || !validTimestamp(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(input.now))
      return false;
    const binding = this.#database.prepare("SELECT id, actor_id, role, default_project_id, enabled, version, expires_at, revoked_at FROM browser_principal_bindings WHERE id = ?").get(input.bindingId);
    const resolved = binding ? this.#binding(binding, input.now) : void 0;
    if (!resolved || input.requireOperator && resolved.role !== "operator")
      return false;
    this.#database.prepare("INSERT INTO browser_principal_sessions (session_digest, csrf_digest, binding_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(digest(input.session), digest(input.csrf), input.bindingId, input.expiresAt, input.now);
    return true;
  }
  resolveBrowserSession(input) {
    if (!validText(input.session))
      return void 0;
    const row = this.#database.prepare(`SELECT binding.id, binding.actor_id, binding.role, binding.default_project_id, binding.enabled, binding.version, binding.expires_at, binding.revoked_at, session.csrf_digest, session.expires_at AS session_expires_at FROM browser_principal_sessions AS session JOIN browser_principal_bindings AS binding ON binding.id = session.binding_id WHERE session.session_digest = ? AND session.revoked_at IS NULL AND session.expires_at > ?`).get(digest(input.session), input.now);
    if (!row || !validTimestamp(row.session_expires_at) || Date.parse(row.session_expires_at) <= Date.parse(input.now) || input.csrf !== void 0 && digest(input.csrf) !== row.csrf_digest)
      return void 0;
    return this.#binding(row, input.now);
  }
  revokeBinding(id, now3) {
    const transaction = this.#database.transaction(() => {
      const result2 = this.#database.prepare("UPDATE browser_principal_bindings SET revoked_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND revoked_at IS NULL").run(now3, now3, id);
      if (result2.changes > 0)
        this.#database.prepare("UPDATE browser_principal_sessions SET revoked_at = ? WHERE binding_id = ? AND revoked_at IS NULL").run(now3, id);
      return result2.changes > 0;
    });
    return transaction.immediate();
  }
};

// packages/persistence/dist/clock.js
import crypto3 from "node:crypto";
var systemPersistenceClock = Object.freeze({
  now: () => (/* @__PURE__ */ new Date()).toISOString(),
  after: (milliseconds) => new Date(Date.now() + milliseconds).toISOString()
});
function createOwnerNonce() {
  return `owner_${crypto3.randomUUID()}`;
}

// packages/persistence/dist/kysely-sync.js
var SyncKyselyTrackerStore = class {
  #database;
  #queries;
  constructor(queries, database) {
    this.#queries = queries;
    this.#database = database;
  }
  get queries() {
    return this.#queries;
  }
  run(query) {
    const compiled = query.compile();
    return this.#database.prepare(compiled.sql).run(...compiled.parameters);
  }
  get(query) {
    const compiled = query.compile();
    return this.#database.prepare(compiled.sql).get(...compiled.parameters);
  }
  all(query) {
    const compiled = query.compile();
    return this.#database.prepare(compiled.sql).all(...compiled.parameters);
  }
  transaction(fn) {
    return this.#database.transaction(() => fn()).immediate();
  }
};

// packages/persistence/dist/command-receipt-repository.js
function json(value2) {
  return JSON.stringify(value2);
}
function rowReceipt(row) {
  const parsed = (() => {
    try {
      const value2 = JSON.parse(row.result_json ?? "{}");
      return value2 && typeof value2 === "object" && !Array.isArray(value2) ? value2 : {};
    } catch {
      return {};
    }
  })();
  return Object.freeze({
    command_id: row.command_id,
    idempotency_key: row.idempotency_key,
    command_kind: row.command_kind,
    actor_id: row.actor_id,
    project_id: row.project_id,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    correlation_id: row.correlation_id,
    fingerprint: row.fingerprint,
    outcome_status: row.outcome_status,
    ...row.reason_code ? { reason_code: row.reason_code } : {},
    ...row.operation_id ? { operation_id: row.operation_id } : {},
    result: parsed,
    committed_at: row.committed_at
  });
}
var CommandReceiptRepository = class {
  #store;
  constructor(queries, database) {
    this.#store = new SyncKyselyTrackerStore(queries, database);
  }
  find(projectId3, idempotencyKey) {
    const row = this.#store.get(this.#store.queries.selectFrom("command_receipts").selectAll().where("project_id", "=", projectId3).where("idempotency_key", "=", idempotencyKey).limit(1));
    return row ? rowReceipt(row) : void 0;
  }
  record(input) {
    this.#store.run(this.#store.queries.insertInto("command_receipts").values({
      command_id: input.command_id,
      idempotency_key: input.idempotency_key,
      command_kind: input.command_kind,
      actor_id: input.actor_id,
      project_id: input.project_id,
      resource_type: input.resource_type,
      resource_id: input.resource_id,
      correlation_id: input.correlation_id,
      fingerprint: input.fingerprint,
      outcome_status: input.outcome_status,
      reason_code: input.reason_code ?? null,
      operation_id: input.operation_id ?? null,
      result_json: json(input.result),
      committed_at: input.committed_at
    }));
  }
  transaction(fn) {
    return this.#store.transaction(() => fn());
  }
  gateway() {
    const receipts = this;
    return Object.freeze({
      receipts,
      transaction: (fn) => this.transaction(fn)
    });
  }
};

// packages/persistence/dist/committed-publication-repository.js
import crypto4 from "node:crypto";
function rowPublication(row) {
  const base = Object.freeze({
    id: row.id,
    projectId: row.project_id,
    category: row.category,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    resourceRevision: row.resource_revision,
    projectRevision: row.project_revision,
    schemaVersion: row.schema_version,
    policyVersion: row.policy_version,
    createdAt: row.created_at
  });
  return row.claim_token ? Object.freeze({ ...base, claimToken: row.claim_token }) : base;
}
var CommittedPublicationRepository = class {
  #database;
  constructor(database) {
    this.#database = database;
  }
  claim(input) {
    if (!input.workerId || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 128)
      throw new Error("committed publication claim input is invalid");
    return this.#database.transaction(() => {
      this.recover(input.now);
      const rows = this.#database.prepare(`SELECT id, project_id, category, resource_type, resource_id,
              resource_revision, project_revision, schema_version,
              policy_version, created_at, claim_token
             FROM committed_publication_outbox
             WHERE status = 'pending'
             -- A project revision is the canonical cursor exposed by HTTP and
             -- WS. Timestamps may be equal (or supplied by a deterministic
             -- clock), so id ordering could publish revision N+1 before N.
             -- Scope first, then the committed revision, preserves the
             -- monotonic per-project replay contract without imposing a
             -- global cross-project sequence.
             ORDER BY project_id ASC, project_revision ASC, id ASC
             LIMIT ?`).all(input.limit);
      const claimed = [];
      for (const row of rows) {
        const claimToken = `cpub_${crypto4.randomUUID()}`;
        const changed = this.#database.prepare(`UPDATE committed_publication_outbox
               SET status = 'claimed', claim_owner = ?, claim_token = ?, claim_until = ?
               WHERE id = ? AND status = 'pending'`).run(input.workerId, claimToken, input.claimUntil, row.id);
        if (changed.changes !== 1)
          continue;
        claimed.push(rowPublication({
          ...row,
          claim_token: claimToken
        }));
      }
      return Object.freeze(claimed);
    }).immediate();
  }
  recover(now3) {
    const result2 = this.#database.prepare(`UPDATE committed_publication_outbox
         SET status = 'pending', claim_owner = NULL, claim_token = NULL, claim_until = NULL
         WHERE status = 'claimed' AND claim_until <= ?`).run(now3);
    return result2.changes;
  }
  ack(input) {
    return this.#database.prepare(`UPDATE committed_publication_outbox
           SET status = 'published', published_at = ?, claim_owner = NULL,
               claim_token = NULL, claim_until = NULL
           WHERE id = ? AND status = 'claimed' AND claim_token = ?`).run(input.publishedAt, input.id, input.claimToken).changes === 1;
  }
  projectRevision(projectId3) {
    const row = this.#database.prepare("SELECT revision FROM committed_project_revisions WHERE project_id = ?").get(projectId3);
    return row?.revision ?? 0;
  }
  outboxCount(projectId3) {
    const row = this.#database.prepare("SELECT count(*) AS count FROM committed_publication_outbox WHERE project_id = ?").get(projectId3);
    return Number(row?.count ?? 0);
  }
};

// packages/persistence/dist/lock.js
import fs2 from "node:fs";
import path from "node:path";
var fileSystem = fs2;
function guardPath(lockPath) {
  return `${lockPath}.guard`;
}
function metadataPath(ownerGuardPath) {
  return path.join(ownerGuardPath, "owner.json");
}
function processIsGone(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
  }
}
function readOwnerMetadata(target) {
  try {
    const parsed = JSON.parse(fileSystem.readFileSync(metadataPath(target), "utf8"));
    if (typeof parsed.owner_id !== "string" || !parsed.owner_id || typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.nonce !== "string" || !/^owner_[0-9a-f-]{36}$/iu.test(parsed.nonce) || typeof parsed.acquired_at !== "string")
      return void 0;
    return Object.freeze({
      owner_id: parsed.owner_id,
      pid: parsed.pid,
      nonce: parsed.nonce,
      acquired_at: parsed.acquired_at
    });
  } catch {
    return void 0;
  }
}
function isCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function isSameOwner(lock, current) {
  return Boolean(current && current.owner_id === lock.ownerId && current.pid === lock.pid && current.nonce === lock.nonce);
}
function writeDiagnosticPointer(lockPath, metadata) {
  const temporary = `${lockPath}.${metadata.nonce}.tmp`;
  fileSystem.writeFileSync(temporary, `${JSON.stringify(metadata)}
`, {
    encoding: "utf8",
    mode: 384
  });
  fileSystem.renameSync(temporary, lockPath);
}
function recoverStaleGuard(ownerGuardPath, expected) {
  const current = readOwnerMetadata(ownerGuardPath);
  if (!current || current.nonce !== expected.nonce || current.owner_id !== expected.owner_id || !processIsGone(current.pid))
    return false;
  try {
    fileSystem.renameSync(ownerGuardPath, `${ownerGuardPath}.stale-${current.nonce}`);
    return true;
  } catch {
    return false;
  }
}
function acquireOwnerLock(lockPath, ownerId, clock) {
  fileSystem.mkdirSync(path.dirname(lockPath), {
    recursive: true,
    mode: 448
  });
  const ownerGuardPath = guardPath(lockPath);
  const metadata = Object.freeze({
    owner_id: ownerId,
    pid: process.pid,
    nonce: createOwnerNonce(),
    acquired_at: clock.now()
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fileSystem.mkdirSync(ownerGuardPath, { mode: 448 });
      fileSystem.writeFileSync(metadataPath(ownerGuardPath), `${JSON.stringify(metadata)}
`, { encoding: "utf8", mode: 384 });
      writeDiagnosticPointer(lockPath, metadata);
      return Object.freeze({
        lockPath,
        guardPath: ownerGuardPath,
        ownerId,
        nonce: metadata.nonce,
        pid: process.pid
      });
    } catch (error) {
      if (!isCode(error, "EEXIST"))
        throw error;
      const existing = readOwnerMetadata(ownerGuardPath);
      if (attempt === 0 && existing && processIsGone(existing.pid)) {
        if (recoverStaleGuard(ownerGuardPath, existing))
          continue;
      }
      throw new PersistenceOwnerConflictError(existing ? {
        owner_id: existing.owner_id,
        owner_nonce: existing.nonce,
        pid: existing.pid,
        state: processIsGone(existing.pid) ? "stale_recovery_raced" : "active"
      } : { state: "invalid", lock_path: lockPath });
    }
  }
  throw new PersistenceOwnerConflictError({
    state: "recovery_exhausted",
    lock_path: lockPath
  });
}
function releaseOwnerLock(lock) {
  if (!isSameOwner(lock, readOwnerMetadata(lock.guardPath)))
    return;
  try {
    fileSystem.rmSync(lock.guardPath, { recursive: true, force: true });
  } catch (error) {
    if (!isCode(error, "ENOENT"))
      throw error;
  }
}

// packages/persistence/dist/management-repository.js
function parseJson(value2) {
  if (!value2)
    return {};
  try {
    const parsed = JSON.parse(value2);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function json2(value2) {
  return JSON.stringify(value2);
}
function rowRole(row) {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    scope: row.scope,
    definition: parseJson(row.definition_json),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}
function rowAssignment(row) {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    ...row.session_id ? { sessionId: row.session_id } : {},
    ...row.generation_id ? { generationId: row.generation_id } : {},
    roleId: row.role_id,
    actor: row.actor,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at
  });
}
function rowGate(row) {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    status: row.status,
    question: row.question,
    assignee: row.assignee,
    ...row.verdict_json ? { verdict: parseJson(row.verdict_json) } : {},
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}
function rowIdea(row) {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    body: row.body,
    status: row.status,
    ...row.promoted_ticket_id ? { promotedTicketId: row.promoted_ticket_id } : {},
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}
function rowAsset(row) {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    relativePath: row.relative_path,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    storagePath: row.storage_path,
    createdAt: row.created_at
  });
}
function rowOperation(row) {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    ...row.session_id ? { sessionId: row.session_id } : {},
    ...row.generation_id ? { generationId: row.generation_id } : {},
    kind: row.kind,
    command: row.command,
    payload: parseJson(row.payload_json),
    status: row.status,
    actor: row.actor,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}
function rowAudit(row) {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    subjectId: row.subject_id,
    actor: row.actor,
    details: parseJson(row.details_json),
    createdAt: row.created_at
  });
}
var TrackerManagementRepository = class {
  #store;
  constructor(queries, database) {
    this.#store = new SyncKyselyTrackerStore(queries, database);
  }
  #record(projectId3, kind, subjectId, idempotencyKey, actor2, details, now3) {
    this.#store.run(this.#store.queries.insertInto("management_audit").values({
      id: `maud_${globalThis.crypto.randomUUID()}`,
      project_id: projectId3,
      kind,
      subject_id: subjectId,
      actor: actor2,
      details_json: json2(details),
      created_at: now3
    }));
    this.#store.run(this.#store.queries.insertInto("management_outbox").values({
      id: `mout_${globalThis.crypto.randomUUID()}`,
      project_id: projectId3,
      kind,
      payload_json: json2({
        kind,
        subject_id: subjectId,
        ...details
      }),
      idempotency_key: idempotencyKey,
      status: "pending",
      created_at: now3
    }).onConflict((oc) => oc.columns(["project_id", "idempotency_key"]).doNothing()));
  }
  createRole(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("management_roles").selectAll().where("id", "=", input.id));
      if (existing) {
        if (existing.scope === input.scope && existing.definition_json === json2(input.definition))
          return rowRole(existing);
        this.#store.run(this.#store.queries.updateTable("management_roles").set({
          definition_json: json2(input.definition),
          scope: input.scope,
          revision: existing.revision + 1,
          updated_at: input.now
        }).where("id", "=", input.id));
        this.#record(input.projectId, "role.updated", input.id, `role:${input.id}:${existing.revision + 1}`, input.actor, { name: input.name }, input.now);
        return rowRole(this.#store.get(this.#store.queries.selectFrom("management_roles").selectAll().where("id", "=", input.id)));
      }
      this.#store.run(this.#store.queries.insertInto("management_roles").values({
        id: input.id,
        project_id: input.projectId,
        name: input.name,
        scope: input.scope,
        definition_json: json2(input.definition),
        revision: 1,
        created_at: input.now,
        updated_at: input.now
      }));
      this.#record(input.projectId, "role.created", input.id, `role:${input.id}:1`, input.actor, { name: input.name }, input.now);
      return rowRole(this.#store.get(this.#store.queries.selectFrom("management_roles").selectAll().where("id", "=", input.id)));
    });
  }
  listRoles(projectId3) {
    return Object.freeze(this.#store.all(this.#store.queries.selectFrom("management_roles").selectAll().where("project_id", "=", projectId3).orderBy("name", "asc")).map(rowRole));
  }
  assignRole(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("management_role_assignments").selectAll().where("project_id", "=", input.projectId).where("idempotency_key", "=", input.idempotencyKey));
      if (existing)
        return rowAssignment(existing);
      this.#store.run(this.#store.queries.insertInto("management_role_assignments").values({
        id: input.id,
        project_id: input.projectId,
        session_id: input.sessionId ?? null,
        generation_id: input.generationId ?? null,
        role_id: input.roleId,
        actor: input.actor,
        idempotency_key: input.idempotencyKey,
        created_at: input.now
      }));
      this.#record(input.projectId, "role.assigned", input.id, `assignment:${input.idempotencyKey}`, input.actor, {
        role_id: input.roleId,
        session_id: input.sessionId ?? null,
        generation_id: input.generationId ?? null
      }, input.now);
      return rowAssignment(this.#store.get(this.#store.queries.selectFrom("management_role_assignments").selectAll().where("id", "=", input.id)));
    });
  }
  createGate(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("management_gates").selectAll().where("project_id", "=", input.projectId).where("idempotency_key", "=", input.idempotencyKey));
      if (existing)
        return rowGate(existing);
      this.#store.run(this.#store.queries.insertInto("management_gates").values({
        id: input.id,
        project_id: input.projectId,
        kind: input.kind,
        status: "awaiting",
        question: input.question,
        assignee: input.assignee,
        verdict_json: null,
        idempotency_key: input.idempotencyKey,
        created_at: input.now,
        updated_at: input.now
      }));
      this.#record(input.projectId, "gate.created", input.id, `gate:${input.idempotencyKey}`, input.actor, { kind: input.kind, assignee: input.assignee }, input.now);
      return rowGate(this.#store.get(this.#store.queries.selectFrom("management_gates").selectAll().where("id", "=", input.id)));
    });
  }
  answerGate(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("management_gates").selectAll().where("id", "=", input.id).where("project_id", "=", input.projectId));
      if (!existing)
        return void 0;
      if (existing.status !== "awaiting")
        return rowGate(existing);
      this.#store.run(this.#store.queries.updateTable("management_gates").set({
        status: input.status,
        verdict_json: json2(input.verdict),
        updated_at: input.now
      }).where("id", "=", input.id).where("status", "=", "awaiting"));
      this.#record(input.projectId, `gate.${input.status}`, input.id, `gate:${input.id}:${input.status}`, input.actor, { verdict: input.verdict }, input.now);
      return rowGate(this.#store.get(this.#store.queries.selectFrom("management_gates").selectAll().where("id", "=", input.id)));
    });
  }
  listGates(projectId3) {
    return Object.freeze(this.#store.all(this.#store.queries.selectFrom("management_gates").selectAll().where("project_id", "=", projectId3).orderBy("created_at", "desc")).map(rowGate));
  }
  createIdea(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("management_ideas").selectAll().where("project_id", "=", input.projectId).where("idempotency_key", "=", input.idempotencyKey));
      if (existing)
        return rowIdea(existing);
      this.#store.run(this.#store.queries.insertInto("management_ideas").values({
        id: input.id,
        project_id: input.projectId,
        body: input.body,
        status: "pending",
        promoted_ticket_id: null,
        idempotency_key: input.idempotencyKey,
        created_at: input.now,
        updated_at: input.now
      }));
      this.#record(input.projectId, "idea.created", input.id, `idea:${input.idempotencyKey}`, input.actor, {}, input.now);
      return rowIdea(this.#store.get(this.#store.queries.selectFrom("management_ideas").selectAll().where("id", "=", input.id)));
    });
  }
  popIdea(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("management_ideas").selectAll().where("id", "=", input.id).where("project_id", "=", input.projectId));
      if (!existing)
        return void 0;
      if (existing.status !== "pending")
        return rowIdea(existing);
      this.#store.run(this.#store.queries.updateTable("management_ideas").set({ status: "popped", updated_at: input.now }).where("id", "=", input.id).where("status", "=", "pending"));
      this.#record(input.projectId, "idea.popped", input.id, `idea:${input.id}:popped`, input.actor, {}, input.now);
      return rowIdea(this.#store.get(this.#store.queries.selectFrom("management_ideas").selectAll().where("id", "=", input.id)));
    });
  }
  promoteIdea(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("management_ideas").selectAll().where("id", "=", input.id).where("project_id", "=", input.projectId));
      if (!existing)
        return void 0;
      if (existing.status === "promoted")
        return rowIdea(existing);
      this.#store.run(this.#store.queries.updateTable("management_ideas").set({
        status: "promoted",
        promoted_ticket_id: input.ticketId,
        updated_at: input.now
      }).where("id", "=", input.id).where("status", "in", ["pending", "popped"]));
      this.#record(input.projectId, "idea.promoted", input.id, `idea:${input.id}:promoted`, input.actor, { ticket_id: input.ticketId }, input.now);
      return rowIdea(this.#store.get(this.#store.queries.selectFrom("management_ideas").selectAll().where("id", "=", input.id)));
    });
  }
  listIdeas(projectId3) {
    return Object.freeze(this.#store.all(this.#store.queries.selectFrom("management_ideas").selectAll().where("project_id", "=", projectId3).orderBy("created_at", "asc")).map(rowIdea));
  }
  putAsset(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("management_assets").selectAll().where("project_id", "=", input.projectId).where("ticket_id", "=", input.ticketId).where("relative_path", "=", input.relativePath));
      if (existing)
        return rowAsset(existing);
      this.#store.run(this.#store.queries.insertInto("management_assets").values({
        id: input.id,
        project_id: input.projectId,
        ticket_id: input.ticketId,
        relative_path: input.relativePath,
        mime_type: input.mimeType,
        byte_size: input.byteSize,
        sha256: input.sha256,
        storage_path: input.storagePath,
        created_at: input.now
      }));
      this.#record(input.projectId, "asset.stored", input.id, `asset:${input.projectId}:${input.ticketId}:${input.relativePath}`, input.actor, {
        ticket_id: input.ticketId,
        mime_type: input.mimeType,
        byte_size: input.byteSize
      }, input.now);
      return rowAsset(this.#store.get(this.#store.queries.selectFrom("management_assets").selectAll().where("id", "=", input.id)));
    });
  }
  getAsset(input) {
    const row = this.#store.get(this.#store.queries.selectFrom("management_assets").selectAll().where("id", "=", input.id).where("project_id", "=", input.projectId).where("ticket_id", "=", input.ticketId));
    return row ? rowAsset(row) : void 0;
  }
  listAssets(input) {
    return Object.freeze(this.#store.all(this.#store.queries.selectFrom("management_assets").selectAll().where("project_id", "=", input.projectId).where("ticket_id", "=", input.ticketId).orderBy("created_at", "asc")).map(rowAsset));
  }
  createOperation(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("management_operations").selectAll().where("project_id", "=", input.projectId).where("idempotency_key", "=", input.idempotencyKey));
      if (existing)
        return rowOperation(existing);
      this.#store.run(this.#store.queries.insertInto("management_operations").values({
        id: input.id,
        project_id: input.projectId,
        session_id: input.sessionId ?? null,
        generation_id: input.generationId ?? null,
        kind: input.kind,
        command: input.command,
        payload_json: json2(input.payload),
        status: "queued",
        actor: input.actor,
        idempotency_key: input.idempotencyKey,
        created_at: input.now,
        updated_at: input.now
      }));
      this.#record(input.projectId, `control.${input.command}`, input.id, `operation:${input.idempotencyKey}`, input.actor, {
        command: input.command,
        kind: input.kind,
        session_id: input.sessionId ?? null,
        generation_id: input.generationId ?? null
      }, input.now);
      return rowOperation(this.#store.get(this.#store.queries.selectFrom("management_operations").selectAll().where("id", "=", input.id)));
    });
  }
  getOperation(id, projectId3) {
    const row = this.#store.get(this.#store.queries.selectFrom("management_operations").selectAll().where("id", "=", id).where("project_id", "=", projectId3));
    return row ? rowOperation(row) : void 0;
  }
  listOperations(projectId3) {
    return Object.freeze(this.#store.all(this.#store.queries.selectFrom("management_operations").selectAll().where("project_id", "=", projectId3).orderBy("created_at", "desc")).map(rowOperation));
  }
  auditManagement(projectId3) {
    return Object.freeze(this.#store.all(this.#store.queries.selectFrom("management_audit").selectAll().where("project_id", "=", projectId3).orderBy("created_at", "desc")).map(rowAudit));
  }
};

// packages/persistence/dist/migrations.js
import fs3 from "node:fs";
import path2 from "node:path";
import Database2 from "better-sqlite3";
var fileSystem2 = fs3;
var pathBoundary = path2;
function ensureMigrationLedger(database) {
  database.exec(`
CREATE TABLE IF NOT EXISTS golem_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`);
}
function appliedMigrations(database) {
  if (!tableExists(database, "golem_migrations"))
    return Object.freeze({ exists: false, rows: /* @__PURE__ */ new Map() });
  const rows = /* @__PURE__ */ new Map();
  try {
    for (const row of database.prepare("SELECT id, checksum FROM golem_migrations ORDER BY id").all()) {
      if (typeof row.id !== "string" || !row.id || typeof row.checksum !== "string" || !row.checksum || rows.has(row.id)) {
        throw new PersistenceMigrationError("migration_ledger_invalid", "migration ledger contains a malformed row");
      }
      rows.set(row.id, row.checksum);
    }
  } catch (error) {
    if (error instanceof PersistenceMigrationError)
      throw error;
    throw new PersistenceMigrationError("migration_ledger_invalid", `migration ledger is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Object.freeze({ exists: true, rows });
}
function assertMigrationState(database, scope) {
  const expected = migrationSet(scope);
  const ledger = appliedMigrations(database);
  const version2 = currentVersion(database);
  if (version2 > latestVersion(scope)) {
    throw new PersistenceMigrationError("schema_too_new", `${scope} schema version ${version2} is newer than supported version ${latestVersion(scope)}`);
  }
  const known2 = new Set(expected.map((entry2) => entry2.id));
  for (const id of ledger.rows.keys()) {
    if (!known2.has(id)) {
      throw new PersistenceMigrationError("schema_too_new", `${scope} migration ledger contains an unknown migration: ${id}`);
    }
  }
  for (const entry2 of expected) {
    const stored = ledger.rows.get(entry2.id);
    if (stored && stored !== entry2.checksum) {
      throw new PersistenceMigrationError("checksum_drift", `${scope} migration checksum drift: ${entry2.id}`);
    }
  }
  return ledger.rows;
}
function planFor(database, scope, mode) {
  const migrations = migrationSet(scope);
  const applied = assertMigrationState(database, scope);
  const pending = migrations.filter((entry2) => !applied.has(entry2.id));
  const plan = {
    scope,
    mode,
    currentVersion: currentVersion(database),
    targetVersion: latestVersion(scope),
    migrations: migrations.map(({ id, checksum }) => ({ id, checksum })),
    pending: pending.map(({ id, checksum }) => ({ id, checksum })),
    requiresBackup: pending.length > 0,
    estimatedBackupBytes: numericPragma(database, "page_count") * numericPragma(database, "page_size")
  };
  const stablePlan = {
    scope: plan.scope,
    currentVersion: plan.currentVersion,
    targetVersion: plan.targetVersion,
    migrations: plan.migrations,
    pending: plan.pending,
    requiresBackup: plan.requiresBackup,
    estimatedBackupBytes: plan.estimatedBackupBytes
  };
  return Object.freeze({
    ...plan,
    planHash: sha256(JSON.stringify(stablePlan))
  });
}
function migrationAlreadyProvidesBaseline(database, scope, id) {
  return scope === "tracker" && id === "tracker/001-baseline" && tableExists(database, "migration_audit");
}
function applyPlan(database, databasePath, plan, clock) {
  if (plan.pending.length === 0)
    return Object.freeze({ ...plan, applied: [] });
  const backupPath = backupDatabase(database, databasePath, clock);
  const definitions = migrationSet(plan.scope).filter((entry2) => plan.pending.some((pending) => pending.id === entry2.id));
  try {
    database.transaction(() => {
      ensureMigrationLedger(database);
      for (const definition of definitions) {
        if (!migrationAlreadyProvidesBaseline(database, plan.scope, definition.id))
          database.exec(definition.sql);
        database.prepare("INSERT INTO golem_migrations(id, checksum, applied_at) VALUES (?, ?, ?)").run(definition.id, definition.checksum, clock.now());
      }
      database.pragma(`user_version = ${plan.targetVersion}`);
      const appliedAt = clock.now();
      const auditId = sha256(`${plan.scope}:${plan.planHash}:${appliedAt}`).slice(0, 32);
      if (tableExists(database, "migration_audit"))
        database.prepare("INSERT INTO migration_audit(id, scope, plan_hash, backup_path, applied_at) VALUES (?, ?, ?, ?, ?)").run(auditId, plan.scope, plan.planHash, backupPath, appliedAt);
    })();
  } catch (error) {
    throw new PersistenceMigrationError("migration_failed", `${plan.scope} migration failed; source rolled back: ${error instanceof Error ? error.message : String(error)}`);
  }
  verifyDatabase(databasePath);
  return Object.freeze({
    ...plan,
    backupPath,
    applied: definitions.map((definition) => definition.id)
  });
}
function dryRunPlan(database, databasePath, scope, clock) {
  const plan = planFor(database, scope, "dry-run");
  const clonePath = cloneDatabase(database, databasePath, clock);
  let clone;
  try {
    clone = new Database2(clonePath);
    configure(clone);
    const clonedPlan = planFor(clone, scope, "apply");
    const result2 = applyPlan(clone, clonePath, clonedPlan, clock);
    const checked = health(clone);
    if (checked.integrity !== "ok" || checked.foreignKeyViolations !== 0)
      throw new PersistenceMigrationError("migration_failed", `dry-run clone failed integrity=${checked.integrity} foreign_keys=${checked.foreignKeyViolations}`);
    return Object.freeze({
      ...plan,
      dryRun: {
        integrity: checked.integrity,
        foreignKeyViolations: checked.foreignKeyViolations,
        applied: result2.applied
      }
    });
  } finally {
    try {
      clone?.close();
    } catch {
    }
    try {
      fileSystem2.rmSync(clonePath, { force: true });
      const cloneName = pathBoundary.basename(clonePath);
      for (const entry2 of fileSystem2.readdirSync(pathBoundary.dirname(clonePath))) {
        if (entry2.startsWith(`${cloneName}.golem-backup-`))
          fileSystem2.rmSync(pathBoundary.join(pathBoundary.dirname(clonePath), entry2), { force: true });
      }
    } catch {
    }
  }
}

// packages/persistence/dist/repositories.js
import crypto5 from "node:crypto";

// packages/persistence/dist/endpoint-repository.js
function json3(value2) {
  return JSON.stringify(value2);
}
function accepted(endpointId, revision, fence) {
  return Object.freeze({
    disposition: "accepted",
    code: "runtime.endpoint.accepted",
    endpointId,
    revision,
    ...fence === void 0 ? {} : { ownerFence: fence }
  });
}
function rejected(code, details) {
  return Object.freeze({
    disposition: "rejected",
    code,
    ...details ? { details } : {}
  });
}
function live(state) {
  return state === "claiming" || state === "healthy" || state === "degraded";
}
function terminal(state) {
  return state === "ended" || state === "errored" || state === "superseded";
}
function compareTime(left, right) {
  return Date.parse(left) - Date.parse(right);
}
function redactIdentifier(value2) {
  return value2.replace(/((?:owner[_-]?token|access[_-]?token|api[_-]?key|openai[_-]?api[_-]?key|token|credential|password|secret|bearer)\s*[=:]\s*)([^\s,;|]+)/giu, "$1[REDACTED]");
}
function consumedEvidence(evidence) {
  return evidence.consumed === true || evidence.consumptionObserved === true || evidence.consumption === "observed";
}
var RuntimeEndpointRepository = class {
  #database;
  #clock;
  constructor(database, clock) {
    this.#database = database;
    this.#clock = clock;
  }
  #emit(row, kind, now3) {
    const id = sha256(`endpoint:${row.endpoint_id}:${row.revision}:${kind}`).slice(0, 32);
    this.#database.prepare("INSERT OR IGNORE INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, 'tracker', ?, 'pending', ?, 0)").run(id, json3({
      kind,
      endpointId: row.endpoint_id,
      generationId: row.generation_id,
      routeKind: row.route_kind,
      revision: row.revision,
      ownerFence: row.owner_fence
    }), new Date(Date.parse(now3) + row.revision).toISOString());
  }
  #row(endpointId) {
    return this.#database.prepare("SELECT endpoint_id, generation_id, route_kind, revision, state, owner_fence, owner_instance_id, delivery_mode, readiness_state, control_state, consumer_ready, consumption_observed, delivery_observed, delivery_failed, claimed_at, heartbeat_at, expires_at, superseded_at FROM endpoint_claims WHERE endpoint_id = ?").get(endpointId);
  }
  #nextRevision(generationId) {
    const row = this.#database.prepare("SELECT MAX(revision) AS revision FROM endpoint_claims WHERE generation_id = ?").get(generationId);
    return (row?.revision ?? 0) + 1;
  }
  #validateGeneration(generationId) {
    const row = this.#database.prepare("SELECT lifecycle_state FROM session_generations WHERE generation_id = ?").get(generationId);
    if (!row)
      return rejected("runtime.endpoint.generation_unresolved");
    if (terminal(row.lifecycle_state))
      return rejected("runtime.endpoint.generation_terminal", {
        remedy: "select a non-terminal generation"
      });
    return void 0;
  }
  #validateOwner(input) {
    const row = this.#row(input.endpointId);
    if (!row)
      return { error: rejected("runtime.endpoint.unresolved") };
    if (row.generation_id !== input.generationId || row.owner_instance_id !== input.ownerInstanceId || row.owner_fence !== input.ownerFence)
      return {
        error: rejected("runtime.endpoint.fence_stale", {
          generationId: row.generation_id,
          expectedFence: row.owner_fence,
          receivedFence: input.ownerFence
        })
      };
    if (!live(row.state))
      return { error: rejected("runtime.endpoint.fence_stale") };
    const now3 = this.#clock.now();
    if (row.expires_at && compareTime(row.expires_at, now3) <= 0)
      return { error: rejected("runtime.endpoint.lease_expired") };
    return { row };
  }
  claim(input) {
    if (!input.ownerInstanceId.trim())
      return rejected("runtime.endpoint.owner_invalid");
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1)
      return rejected("runtime.endpoint.lease_invalid");
    return this.#database.transaction(() => {
      const generationError = this.#validateGeneration(input.generationId);
      if (generationError)
        return generationError;
      const now3 = this.#clock.now();
      const fenceRow = this.#database.prepare("SELECT MAX(fence) AS fence FROM endpoint_fences WHERE generation_id = ? AND route_kind = ?").get(input.generationId, input.routeKind);
      const fence = (fenceRow?.fence ?? 0) + 1;
      const endpointId = input.endpointId ?? `endpoint_${sha256(`${input.generationId}:${input.routeKind}:${input.ownerInstanceId}:${fence}`).slice(0, 24)}`;
      const existing = this.#row(endpointId);
      if (existing) {
        if (live(existing.state) && existing.generation_id === input.generationId && existing.route_kind === input.routeKind && existing.owner_instance_id === input.ownerInstanceId)
          return accepted(existing.endpoint_id, existing.revision, existing.owner_fence);
        return rejected("runtime.endpoint.endpoint_conflict");
      }
      const prior = this.#database.prepare("SELECT endpoint_id, generation_id, route_kind, revision, state, owner_fence, owner_instance_id, delivery_mode, readiness_state, control_state, consumer_ready, consumption_observed, delivery_observed, delivery_failed, claimed_at, heartbeat_at, expires_at, superseded_at FROM endpoint_claims WHERE generation_id = ? AND route_kind = ? AND state IN ('claiming', 'healthy', 'degraded') ORDER BY owner_fence DESC LIMIT 1").get(input.generationId, input.routeKind);
      const revision = this.#nextRevision(input.generationId);
      if (prior) {
        this.#database.prepare("UPDATE endpoint_claims SET state = 'superseded', superseded_at = ?, revision = ? WHERE endpoint_id = ?").run(now3, revision, prior.endpoint_id);
      }
      const expiresAt = this.#clock.after(input.leaseMs);
      this.#database.prepare("INSERT INTO endpoint_fences(generation_id, route_kind, fence, allocated_at, owner_instance_id) VALUES (?, ?, ?, ?, ?)").run(input.generationId, input.routeKind, fence, now3, input.ownerInstanceId);
      this.#database.prepare("INSERT INTO endpoint_claims(endpoint_id, generation_id, route_kind, revision, state, owner_fence, owner_instance_id, delivery_mode, readiness_state, control_state, consumer_ready, consumption_observed, delivery_observed, delivery_failed, claimed_at, heartbeat_at, expires_at, superseded_at) VALUES (?, ?, ?, ?, 'claiming', ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, NULL)").run(endpointId, input.generationId, input.routeKind, revision, fence, input.ownerInstanceId, input.deliveryMode, input.readiness ?? "uninitialized", input.controlState ?? "disabled", now3, now3, expiresAt);
      this.#emit({
        endpoint_id: endpointId,
        generation_id: input.generationId,
        route_kind: input.routeKind,
        revision,
        owner_fence: fence
      }, "endpoint.claimed", now3);
      return accepted(endpointId, revision, fence);
    })();
  }
  heartbeat(input) {
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1)
      return rejected("runtime.endpoint.lease_invalid");
    return this.#database.transaction(() => {
      const generationError = this.#validateGeneration(input.generationId);
      if (generationError)
        return generationError;
      const checked = this.#validateOwner(input);
      if (checked.error)
        return checked.error;
      const row = checked.row;
      const now3 = this.#clock.now();
      const revision = row.revision + 1;
      this.#database.prepare("UPDATE endpoint_claims SET revision = ?, heartbeat_at = ?, expires_at = ? WHERE endpoint_id = ?").run(revision, input.heartbeatAt ?? now3, this.#clock.after(input.leaseMs), row.endpoint_id);
      this.#emit({ ...row, revision }, "endpoint.heartbeat", now3);
      return accepted(row.endpoint_id, revision);
    })();
  }
  reportHealth(input) {
    return this.#database.transaction(() => {
      const generationError = this.#validateGeneration(input.generationId);
      if (generationError)
        return generationError;
      const checked = this.#validateOwner(input);
      if (checked.error)
        return checked.error;
      const row = checked.row;
      const now3 = this.#clock.now();
      const revision = row.revision + 1;
      this.#database.prepare("UPDATE endpoint_claims SET state = ?, revision = ? WHERE endpoint_id = ?").run(input.state, revision, row.endpoint_id);
      this.#emit({ ...row, revision }, "endpoint.health", now3);
      return accepted(row.endpoint_id, revision);
    })();
  }
  reportReadiness(input) {
    return this.#database.transaction(() => {
      const generationError = this.#validateGeneration(input.generationId);
      if (generationError)
        return generationError;
      const checked = this.#validateOwner(input);
      if (checked.error)
        return checked.error;
      const row = checked.row;
      const now3 = this.#clock.now();
      const revision = row.revision + 1;
      this.#database.prepare("UPDATE endpoint_claims SET delivery_mode = ?, readiness_state = ?, control_state = ?, revision = ? WHERE endpoint_id = ?").run(input.deliveryMode, input.readiness, input.controlState ?? row.control_state, revision, row.endpoint_id);
      this.#emit({ ...row, revision }, "endpoint.readiness", now3);
      return accepted(row.endpoint_id, revision);
    })();
  }
  probe(input) {
    return this.#database.transaction(() => {
      const generationError = this.#validateGeneration(input.generationId);
      if (generationError)
        return generationError;
      const checked = this.#validateOwner(input);
      if (checked.error)
        return checked.error;
      const row = checked.row;
      const now3 = this.#clock.now();
      const revision = row.revision + 1;
      const readiness = input.readiness ?? (input.consumerReady ? "ready" : "held_waiting");
      this.#database.prepare("UPDATE endpoint_claims SET readiness_state = ?, consumer_ready = ?, revision = ? WHERE endpoint_id = ?").run(readiness, input.consumerReady ? 1 : 0, revision, row.endpoint_id);
      this.#emit({ ...row, revision }, "endpoint.consumer_probe", now3);
      return accepted(row.endpoint_id, revision);
    })();
  }
  reportDelivery(input) {
    return this.#database.transaction(() => {
      const generationError = this.#validateGeneration(input.generationId);
      if (generationError)
        return generationError;
      const checked = this.#validateOwner(input);
      if (checked.error)
        return checked.error;
      const row = checked.row;
      const now3 = this.#clock.now();
      const revision = row.revision + 1;
      const readiness = input.readiness ?? (input.status === "failed" ? "unhealthy" : row.readiness_state);
      this.#database.prepare("UPDATE endpoint_claims SET readiness_state = ?, delivery_observed = ?, delivery_failed = ?, revision = ? WHERE endpoint_id = ?").run(readiness, input.status === "delivered" ? 1 : row.delivery_observed, input.status === "failed" ? 1 : input.status === "delivered" ? 0 : row.delivery_failed, revision, row.endpoint_id);
      this.#emit({ ...row, revision }, `endpoint.delivery.${input.status}`, now3);
      return accepted(row.endpoint_id, revision);
    })();
  }
  reportCapability(input) {
    if (!input.capability.capability.trim())
      return rejected("runtime.endpoint.capability_invalid");
    return this.#database.transaction(() => {
      const generationError = this.#validateGeneration(input.generationId);
      if (generationError)
        return generationError;
      const checked = this.#validateOwner(input);
      if (checked.error)
        return checked.error;
      const row = checked.row;
      const now3 = this.#clock.now();
      const revision = row.revision + 1;
      const id = sha256(
        // A readiness transition can legitimately follow the initial status
        // observation in the same clock tick. Include the observed capability
        // facts, not just the timestamp, so the durable projection records that
        // transition instead of mistaking it for a replay.
        `${row.endpoint_id}:${input.capability.capability}:${input.capability.evidenceKind}:${input.capability.observedAt}:${input.capability.qualification}:${input.capability.deliveryMode}:${input.capability.readiness}:${json3(input.evidence)}`
      ).slice(0, 32);
      if (this.#database.prepare("SELECT id FROM capability_observations WHERE id = ?").get(id))
        return {
          disposition: "ignored",
          code: "runtime.endpoint.capability_duplicate",
          endpointId: row.endpoint_id,
          revision: row.revision
        };
      this.#database.prepare("INSERT OR REPLACE INTO capability_observations(id, endpoint_id, capability, adapter_id, adapter_version, qualification_state, delivery_mode, readiness_state, evidence_kind, evidence_json, observed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, row.endpoint_id, input.capability.capability, input.capability.adapterId, input.capability.adapterVersion, input.capability.qualification, input.capability.deliveryMode, input.capability.readiness, input.capability.evidenceKind, json3(input.evidence), input.capability.observedAt, input.capability.expiresAt ?? null);
      this.#database.prepare("UPDATE endpoint_claims SET consumption_observed = CASE WHEN ? = 1 THEN 1 ELSE consumption_observed END, revision = ? WHERE endpoint_id = ?").run(consumedEvidence(input.evidence) ? 1 : 0, revision, row.endpoint_id);
      this.#emit({ ...row, revision }, "endpoint.capability", now3);
      return accepted(row.endpoint_id, revision);
    })();
  }
  release(input) {
    return this.#database.transaction(() => {
      const generationError = this.#validateGeneration(input.generationId);
      if (generationError)
        return generationError;
      const checked = this.#validateOwner(input);
      if (checked.error)
        return checked.error;
      const row = checked.row;
      const now3 = this.#clock.now();
      const revision = row.revision + 1;
      this.#database.prepare("UPDATE endpoint_claims SET state = 'released', readiness_state = 'uninitialized', control_state = 'disabled', revision = ?, expires_at = NULL WHERE endpoint_id = ?").run(revision, row.endpoint_id);
      this.#emit({ ...row, revision }, "endpoint.released", now3);
      return accepted(row.endpoint_id, revision);
    })();
  }
  expire(now3 = this.#clock.now()) {
    return this.#database.transaction(() => {
      const rows = this.#database.prepare("SELECT endpoint_claims.endpoint_id, endpoint_claims.generation_id, endpoint_claims.route_kind, endpoint_claims.revision, endpoint_claims.state, endpoint_claims.owner_fence, endpoint_claims.owner_instance_id, endpoint_claims.delivery_mode, endpoint_claims.readiness_state, endpoint_claims.control_state, endpoint_claims.consumer_ready, endpoint_claims.consumption_observed, endpoint_claims.delivery_observed, endpoint_claims.delivery_failed, endpoint_claims.claimed_at, endpoint_claims.heartbeat_at, endpoint_claims.expires_at, endpoint_claims.superseded_at, session_generations.lifecycle_state AS generation_lifecycle_state FROM endpoint_claims JOIN session_generations ON session_generations.generation_id = endpoint_claims.generation_id WHERE endpoint_claims.state IN ('claiming', 'healthy', 'degraded') AND endpoint_claims.expires_at IS NOT NULL AND endpoint_claims.expires_at <= ? ORDER BY endpoint_claims.generation_id, endpoint_claims.route_kind, endpoint_claims.owner_fence").all(now3);
      return rows.map((row) => {
        if (terminal(row.generation_lifecycle_state))
          return rejected("runtime.endpoint.generation_terminal", {
            remedy: "select a non-terminal generation"
          });
        const revision = row.revision + 1;
        this.#database.prepare("UPDATE endpoint_claims SET state = 'expired', readiness_state = 'uninitialized', control_state = 'disabled', revision = ?, superseded_at = NULL, expires_at = NULL WHERE endpoint_id = ?").run(revision, row.endpoint_id);
        this.#emit({ ...row, revision }, "endpoint.expired", now3);
        return accepted(row.endpoint_id, revision);
      });
    })();
  }
  #getCapabilities(endpointId, redact = true) {
    return Object.freeze(this.#database.prepare("SELECT id, capability, adapter_id, adapter_version, qualification_state, delivery_mode, readiness_state, evidence_kind, observed_at, expires_at FROM capability_observations WHERE endpoint_id = ? ORDER BY observed_at DESC, id DESC").all(endpointId).map((row) => Object.freeze({
      capability: redact ? redactIdentifier(row.capability) : row.capability,
      adapterId: redact ? redactIdentifier(row.adapter_id) : row.adapter_id,
      adapterVersion: row.adapter_version,
      qualification: row.qualification_state,
      deliveryMode: row.delivery_mode,
      readiness: row.readiness_state,
      evidenceKind: row.evidence_kind,
      observedAt: row.observed_at,
      ...row.expires_at ? { expiresAt: row.expires_at } : {}
    })));
  }
  #viewRow(row) {
    return Object.freeze({
      endpointId: redactIdentifier(row.endpoint_id),
      generationId: row.generation_id,
      routeKind: row.route_kind,
      revision: row.revision,
      state: row.state,
      ownerFence: row.owner_fence,
      ownerInstanceId: redactIdentifier(row.owner_instance_id),
      deliveryMode: row.delivery_mode,
      readiness: row.readiness_state,
      controlState: row.control_state,
      consumerReady: row.consumer_ready === 1,
      consumptionObserved: row.consumption_observed === 1,
      deliveryObserved: row.delivery_observed === 1,
      deliveryFailed: row.delivery_failed === 1,
      claimedAt: row.claimed_at,
      ...row.heartbeat_at ? { heartbeatAt: row.heartbeat_at } : {},
      ...row.expires_at ? { expiresAt: row.expires_at } : {},
      ...row.superseded_at ? { supersededAt: row.superseded_at } : {},
      capabilities: this.#getCapabilities(row.endpoint_id)
    });
  }
  get(endpointId) {
    const row = this.#row(endpointId);
    return row ? this.#viewRow(row) : void 0;
  }
  list(generationId) {
    return Object.freeze(this.#database.prepare("SELECT endpoint_id, generation_id, route_kind, revision, state, owner_fence, owner_instance_id, delivery_mode, readiness_state, control_state, consumer_ready, consumption_observed, delivery_observed, delivery_failed, claimed_at, heartbeat_at, expires_at, superseded_at FROM endpoint_claims WHERE generation_id = ? ORDER BY route_kind, owner_fence DESC, endpoint_id").all(generationId).map((row) => this.#viewRow(row)));
  }
  eligibility(input) {
    return this.#classifyEligibility(input, ["ready"], false);
  }
  deliveryEligibility(input) {
    const result2 = this.#classifyEligibility(input, ["ready", "pull_only", "next_turn"], true);
    if (result2.disposition !== "eligible" || !result2.endpoint)
      return Object.freeze({ ...result2, disposition: "ineligible" });
    const disposition = result2.endpoint.readiness === "ready" ? "ready" : result2.endpoint.readiness === "pull_only" ? "pull_only" : "next_turn";
    return Object.freeze({ ...result2, disposition });
  }
  #classifyEligibility(input, acceptedReadiness, requireControl) {
    const now3 = input.now ?? this.#clock.now();
    const generation2 = this.#database.prepare("SELECT lifecycle_state FROM session_generations WHERE generation_id = ?").get(input.generationId);
    const facts = {
      generationId: input.generationId,
      routeKind: input.routeKind
    };
    if (!generation2)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.generation_unresolved",
        remedy: "select a known generation",
        facts
      };
    if (terminal(generation2.lifecycle_state))
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.generation_terminal",
        remedy: "select a non-terminal generation",
        facts
      };
    const row = this.#database.prepare("SELECT endpoint_id, generation_id, route_kind, revision, state, owner_fence, owner_instance_id, delivery_mode, readiness_state, control_state, consumer_ready, consumption_observed, delivery_observed, delivery_failed, claimed_at, heartbeat_at, expires_at, superseded_at FROM endpoint_claims WHERE generation_id = ? AND route_kind = ? AND state IN ('claiming', 'healthy', 'degraded') ORDER BY owner_fence DESC LIMIT 1").get(input.generationId, input.routeKind);
    if (!row)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.unclaimed",
        remedy: "claim the endpoint",
        facts
      };
    const endpoint3 = this.#viewRow(row);
    const endpointFacts = {
      ...facts,
      endpointId: redactIdentifier(row.endpoint_id),
      ownerFence: row.owner_fence
    };
    const expectedFence = input.expectedOwnerFence ?? input.expectedFence;
    if (expectedFence !== void 0 && expectedFence !== row.owner_fence)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.queued_fence_stale",
        remedy: "refresh endpoint eligibility before delivery",
        endpoint: endpoint3,
        facts: {
          ...endpointFacts,
          expectedFence,
          currentFence: row.owner_fence
        }
      };
    if (row.expires_at && compareTime(row.expires_at, now3) <= 0)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.lease_expired",
        remedy: "renew the endpoint lease",
        endpoint: endpoint3,
        facts: endpointFacts
      };
    if (row.state !== "healthy")
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.health_unready",
        remedy: "report a healthy endpoint",
        endpoint: endpoint3,
        facts: endpointFacts
      };
    if (row.control_state !== "enabled" && (input.routeKind === "control" || requireControl))
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.control_disabled",
        remedy: "enable endpoint control",
        endpoint: endpoint3,
        facts: endpointFacts
      };
    if (!acceptedReadiness.includes(row.readiness_state))
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.readiness_unready",
        remedy: "report delivery readiness",
        endpoint: endpoint3,
        facts: endpointFacts
      };
    if (!input.requiredCapability)
      return {
        disposition: "eligible",
        code: "runtime.endpoint.eligible",
        remedy: "none",
        endpoint: endpoint3,
        facts: endpointFacts
      };
    if (!row.consumer_ready)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.consumer_unready",
        remedy: "probe a ready consumer",
        endpoint: endpoint3,
        facts: endpointFacts
      };
    if (row.delivery_failed || !row.delivery_observed && !row.consumption_observed)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.delivery_unready",
        remedy: "report successful delivery",
        endpoint: endpoint3,
        facts: endpointFacts
      };
    const storedCapability = this.#getCapabilities(row.endpoint_id, false).find((candidate) => candidate.capability === input.requiredCapability && (!candidate.expiresAt || compareTime(candidate.expiresAt, now3) > 0));
    if (!storedCapability)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.capability_unqualified",
        remedy: "report verified capability evidence",
        endpoint: endpoint3,
        facts: endpointFacts
      };
    const capability2 = Object.freeze({
      ...storedCapability,
      capability: redactIdentifier(storedCapability.capability),
      adapterId: redactIdentifier(storedCapability.adapterId)
    });
    const capabilityFacts = {
      ...endpointFacts,
      capability: redactIdentifier(capability2.capability)
    };
    if (capability2.deliveryMode !== row.delivery_mode)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.capability_mode_mismatch",
        remedy: "report capability for endpoint delivery mode",
        endpoint: endpoint3,
        capability: capability2,
        facts: capabilityFacts
      };
    if (capability2.qualification !== "supported")
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.capability_unqualified",
        remedy: "report supported capability evidence",
        endpoint: endpoint3,
        capability: capability2,
        facts: capabilityFacts
      };
    if (capability2.readiness !== row.readiness_state)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.capability_unready",
        remedy: "report ready capability evidence",
        endpoint: endpoint3,
        capability: capability2,
        facts: capabilityFacts
      };
    if (!row.consumption_observed)
      return {
        disposition: "ineligible",
        code: "runtime.endpoint.capability_consumption_unverified",
        remedy: "report verified consumption evidence",
        endpoint: endpoint3,
        capability: capability2,
        facts: capabilityFacts
      };
    return {
      disposition: "eligible",
      code: "runtime.endpoint.eligible",
      remedy: "none",
      endpoint: endpoint3,
      capability: capability2,
      facts: capabilityFacts
    };
  }
};

// packages/domain/dist/explain.js
function explanation(code, severity, facts) {
  return { code, severity, facts };
}

// packages/domain/dist/lifecycle.js
var lifecycleRank = {
  starting: 0,
  idle: 1,
  active: 1,
  waiting: 1,
  ending: 2,
  ended: 3,
  errored: 3,
  superseded: 3
};
var terminalStates = /* @__PURE__ */ new Set([
  "ended",
  "errored",
  "superseded"
]);
function isTerminal(state) {
  return terminalStates.has(state);
}
function lifecycleDecision(current, next) {
  const currentRank = lifecycleRank[current] ?? 0;
  const nextRank = lifecycleRank[next] ?? 0;
  const facts = { current, next, currentRank, nextRank };
  if (current === next)
    return {
      disposition: "ignored",
      explanation: explanation("domain.lifecycle.duplicate", "info", facts)
    };
  if (nextRank < currentRank)
    return {
      disposition: "rejected",
      explanation: explanation(isTerminal(current) ? "domain.lifecycle.terminal" : "domain.lifecycle.regression", "error", facts)
    };
  if (isTerminal(current) && !isTerminal(next))
    return {
      disposition: "rejected",
      explanation: explanation("domain.lifecycle.terminal", "error", facts)
    };
  return {
    disposition: "applied",
    explanation: explanation("domain.event.applied", "info", facts)
  };
}

// packages/persistence/dist/session-repository.js
function objectJson(value2) {
  if (!value2)
    return {};
  try {
    const parsed = JSON.parse(value2);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function stableValue(value2) {
  if (Array.isArray(value2))
    return value2.map(stableValue);
  if (!value2 || typeof value2 !== "object")
    return value2;
  return Object.fromEntries(Object.entries(value2).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stableValue(nested)]));
}
function json4(value2) {
  return JSON.stringify(stableValue(value2));
}
function terminal2(value2) {
  return value2 === "ended" || value2 === "errored" || value2 === "superseded";
}
function rank(value2) {
  return lifecycleRank[value2] ?? 0;
}
function version(signal2) {
  return {
    source: signal2.clocks.source_event_at ?? signal2.clocks.source_observed_at,
    tie: `${signal2.event_id}:${signal2.producer_instance_id}`
  };
}
function compareVersion(left, right) {
  const source2 = left.source.localeCompare(right.source);
  if (source2 !== 0)
    return source2;
  return left.tie.localeCompare(right.tie);
}
function provenance2(version_, signal2) {
  return {
    eventId: signal2.event_id,
    producerInstanceId: signal2.producer_instance_id,
    sourceTime: version_.source,
    tieBreak: version_.tie
  };
}
function readVersion(value2) {
  if (typeof value2.sourceTime !== "string" || typeof value2.tieBreak !== "string")
    return void 0;
  return { source: value2.sourceTime, tie: value2.tieBreak };
}
function readFieldVersion(value2, key) {
  const candidate = value2[key];
  return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? readVersion(candidate) : void 0;
}
function isTerminalState(value2) {
  return terminal2(value2);
}
function generationRef(signal2) {
  const payload = signal2.payload;
  if ("generation" in payload)
    return {
      projectId: payload.generation.project_id,
      sessionId: payload.generation.session_id,
      generationId: payload.generation.generation_id
    };
  return void 0;
}
function aliasKey(input) {
  return [
    input.projectId,
    input.harness,
    input.aliasKind,
    input.producerId ?? null,
    input.alias
  ];
}
var RuntimeSessionRepository = class {
  #database;
  #clock;
  constructor(database, clock) {
    this.#database = database;
    this.#clock = clock;
  }
  attachAlias(input) {
    const transaction = this.#database.transaction(() => {
      const result2 = this.#attachAlias(input);
      if (result2.disposition === "accepted" && result2.sessionId)
        this.#recordAliasEffect(input, result2.sessionId, result2.generationId);
      return result2;
    });
    return transaction();
  }
  apply(input) {
    const transaction = this.#database.transaction(() => this.#apply(input));
    return transaction();
  }
  #apply(input) {
    const signal2 = input.signal;
    const ref = generationRef(signal2);
    if (!ref)
      return {
        disposition: "rejected",
        code: "runtime.session.invalid_payload"
      };
    const project2 = this.#database.prepare("SELECT project_id FROM projects WHERE project_id = ?").get(ref.projectId);
    if (!project2)
      return {
        disposition: "rejected",
        code: "runtime.session.project_unresolved",
        details: { projectId: ref.projectId }
      };
    if (input.alias) {
      if (input.alias.projectId !== ref.projectId || input.alias.harness !== signal2.harness)
        return {
          disposition: "review",
          code: "runtime.session.alias_scope_conflict"
        };
      const existing = this.#database.prepare("SELECT session_id, generation_id FROM session_aliases WHERE project_id = ? AND harness = ? AND alias_kind = ? AND COALESCE(producer_id, '') = COALESCE(?, '') AND alias = ?").get(...aliasKey(input.alias));
      if (existing && existing.session_id !== ref.sessionId)
        return {
          disposition: "review",
          code: "runtime.session.alias_conflict",
          details: { scope: "project_harness_producer" }
        };
      if (!existing && !input.alias.sessionId)
        return {
          disposition: "review",
          code: "runtime.session.alias_unresolved"
        };
      if (existing && existing.session_id === null)
        return {
          disposition: "review",
          code: "runtime.session.alias_unresolved"
        };
    }
    if (signal2.payload.kind === "session.started" || signal2.payload.kind === "session.resumed")
      return this.#start(signal2, input.alias);
    const row = this.#database.prepare("SELECT * FROM session_generations WHERE project_id = ? AND session_id = ? AND generation_id = ?").get(ref.projectId, ref.sessionId, ref.generationId);
    if (!row) {
      this.#queuePending(signal2, ref);
      return {
        disposition: "review",
        code: "runtime.session.generation_pending",
        sessionId: ref.sessionId,
        generationId: ref.generationId
      };
    }
    if (signal2.payload.kind === "session.metadata_patched")
      return this.#patchMetadata(row, signal2);
    if (signal2.payload.kind === "session.activity" || signal2.payload.kind === "session.idle" || signal2.payload.kind === "session.waiting" || signal2.payload.kind === "session.ended")
      return this.#lifecycle(row, signal2);
    return {
      disposition: "rejected",
      code: "runtime.session.unsupported_event"
    };
  }
  #queuePending(signal2, ref) {
    this.#database.prepare("INSERT OR REPLACE INTO session_pending_events(event_id, project_id, session_id, generation_id, event_json, source_observed_at, received_at, producer_instance_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(signal2.event_id, ref.projectId, ref.sessionId, ref.generationId, json4(signal2), signal2.clocks.source_event_at ?? signal2.clocks.source_observed_at, signal2.clocks.received_at, signal2.producer_instance_id);
  }
  #start(signal2, alias) {
    const ref = generationRef(signal2);
    if (!ref)
      return {
        disposition: "rejected",
        code: "runtime.session.invalid_payload"
      };
    const payload = signal2.payload;
    if (payload.kind !== "session.started" && payload.kind !== "session.resumed")
      return {
        disposition: "rejected",
        code: "runtime.session.invalid_payload"
      };
    const existing = this.#database.prepare("SELECT * FROM session_generations WHERE project_id = ? AND session_id = ? AND generation_id = ?").get(ref.projectId, ref.sessionId, ref.generationId);
    if (existing)
      return {
        disposition: "duplicate",
        code: "runtime.session.generation_duplicate",
        sessionId: ref.sessionId,
        generationId: ref.generationId
      };
    if (payload.kind === "session.resumed") {
      const parentId = payload.resumed_from_generation_id;
      const parent2 = typeof parentId === "string" && parentId.length > 0 ? this.#database.prepare("SELECT generation_id FROM session_generations WHERE project_id = ? AND session_id = ? AND generation_id = ?").get(ref.projectId, ref.sessionId, parentId) : void 0;
      if (!parent2) {
        this.#queuePending(signal2, ref);
        return {
          disposition: "review",
          code: "runtime.session.generation_parent_pending",
          sessionId: ref.sessionId,
          generationId: ref.generationId
        };
      }
    }
    const now3 = this.#clock.now();
    const v = version(signal2);
    this.#database.prepare("INSERT OR IGNORE INTO logical_sessions(session_id, project_id, provenance_json, created_at) VALUES (?, ?, ?, ?)").run(ref.sessionId, ref.projectId, json4(provenance2(v, signal2)), now3);
    const active2 = this.#database.prepare("SELECT generation_id, lifecycle_state, lifecycle_provenance_json FROM session_generations WHERE project_id = ? AND session_id = ? AND lifecycle_state NOT IN ('ended','errored','superseded') ORDER BY ordinal DESC").get(ref.projectId, ref.sessionId);
    let createdState = "starting";
    let createdLifecycle = provenance2(v, signal2);
    let createdEndedAt = null;
    if (active2) {
      const prior = objectJson(active2.lifecycle_provenance_json);
      const priorVersion = readVersion(prior);
      if (!priorVersion || compareVersion(v, priorVersion) > 0) {
        this.#database.prepare("UPDATE session_generations SET lifecycle_state = 'superseded', lifecycle_provenance_json = ?, ended_at = ? WHERE generation_id = ?").run(json4(provenance2(v, signal2)), v.source, active2.generation_id);
      } else {
        createdState = "superseded";
        createdLifecycle = prior;
        createdEndedAt = priorVersion.source;
      }
    }
    const ordinal = Number(this.#database.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM session_generations WHERE project_id = ? AND session_id = ?").get(ref.projectId, ref.sessionId)?.next ?? 1);
    const metadata = payload.kind === "session.started" ? payload.metadata ?? {} : {};
    const fieldProv = Object.fromEntries(Object.keys(metadata).map((key) => [key, provenance2(v, signal2)]));
    const parent = payload.kind === "session.resumed" ? payload.resumed_from_generation_id ?? null : null;
    this.#database.prepare("INSERT INTO session_generations(generation_id, session_id, project_id, ordinal, harness, lifecycle_state, lifecycle_schema_version, lifecycle_provenance_json, field_schema_version, field_provenance_json, source_observed_at, received_at, activity_at, materialized_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, 'golem.lifecycle/v1', ?, 'golem.fields/v1', ?, ?, ?, NULL, ?, ?)").run(ref.generationId, ref.sessionId, ref.projectId, ordinal, signal2.harness, createdState, json4(createdLifecycle), json4(fieldProv), signal2.clocks.source_observed_at, signal2.clocks.received_at, now3, createdEndedAt);
    this.#database.prepare("INSERT INTO generation_projection(project_id, session_id, generation_id, revision, metadata_json, field_provenance_json, parent_generation_id, continuation, actor_activity_at, observed_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, ?)").run(ref.projectId, ref.sessionId, ref.generationId, json4(metadata), json4(fieldProv), parent, parent ? "resume" : null, now3);
    const sessionRevision = this.#ensureSessionProjection(ref.projectId, ref.sessionId, metadata, fieldProv, now3);
    const started = this.#accepted(ref, sessionRevision, "runtime.session.generation_started", signal2);
    if (alias) {
      const aliasResult = this.#attachAlias(alias, ref.sessionId, ref.generationId);
      if (aliasResult.disposition === "accepted")
        this.#recordAliasEffect(alias, ref.sessionId, ref.generationId);
    }
    this.#replayPending(ref.projectId, ref.sessionId);
    return started;
  }
  #replayPending(projectId3, sessionId) {
    const pending = this.#database.prepare("SELECT event_id, event_json FROM session_pending_events WHERE project_id = ? AND session_id = ? ORDER BY source_observed_at, event_id, producer_instance_id").all(projectId3, sessionId);
    for (const item of pending) {
      const pendingSignal = JSON.parse(item.event_json);
      const result2 = this.#apply({ signal: pendingSignal });
      if (result2.disposition !== "review")
        this.#database.prepare("DELETE FROM session_pending_events WHERE event_id = ?").run(item.event_id);
    }
  }
  #patchMetadata(row, signal2) {
    if (terminal2(row.lifecycle_state))
      return {
        disposition: "ignored",
        code: "runtime.session.terminal_immutable",
        sessionId: row.session_id,
        generationId: row.generation_id
      };
    if (signal2.payload.kind !== "session.metadata_patched")
      return {
        disposition: "rejected",
        code: "runtime.session.invalid_payload"
      };
    const projection = this.#database.prepare("SELECT * FROM generation_projection WHERE project_id = ? AND session_id = ? AND generation_id = ?").get(row.project_id, row.session_id, row.generation_id);
    if (!projection)
      return {
        disposition: "rejected",
        code: "runtime.session.projection_missing"
      };
    const incoming = version(signal2);
    const metadata = { ...objectJson(projection.metadata_json) };
    const provenanceMap = { ...objectJson(projection.field_provenance_json) };
    let changed = false;
    for (const [key, value2] of Object.entries(signal2.payload.metadata)) {
      const prior = readVersion(provenanceMap[key] && typeof provenanceMap[key] === "object" ? provenanceMap[key] : {});
      if (!prior || compareVersion(incoming, prior) > 0) {
        metadata[key] = value2;
        provenanceMap[key] = provenance2(incoming, signal2);
        changed = true;
      }
    }
    for (const key of signal2.clear_fields) {
      const prior = readVersion(provenanceMap[key] && typeof provenanceMap[key] === "object" ? provenanceMap[key] : {});
      if (!prior || compareVersion(incoming, prior) > 0) {
        delete metadata[key];
        provenanceMap[key] = provenance2(incoming, signal2);
        changed = true;
      }
    }
    if (!changed)
      return {
        disposition: "ignored",
        code: "runtime.session.field_stale",
        sessionId: row.session_id,
        generationId: row.generation_id,
        revision: projection.revision
      };
    const now3 = this.#clock.now();
    const revision = projection.revision + 1;
    this.#database.prepare("UPDATE generation_projection SET revision = ?, metadata_json = ?, field_provenance_json = ?, updated_at = ? WHERE project_id = ? AND session_id = ? AND generation_id = ?").run(revision, json4(metadata), json4(provenanceMap), now3, row.project_id, row.session_id, row.generation_id);
    this.#updateSessionProjection(row.project_id, row.session_id, metadata, provenanceMap, now3);
    return this.#accepted({
      projectId: row.project_id,
      sessionId: row.session_id,
      generationId: row.generation_id
    }, revision, "runtime.session.metadata_patched", signal2);
  }
  #lifecycle(row, signal2) {
    const projection = this.#database.prepare("SELECT * FROM generation_projection WHERE project_id = ? AND session_id = ? AND generation_id = ?").get(row.project_id, row.session_id, row.generation_id);
    if (!projection)
      return {
        disposition: "rejected",
        code: "runtime.session.projection_missing"
      };
    const payload = signal2.payload;
    const next = payload.kind === "session.ended" ? payload.disposition : payload.kind === "session.activity" ? "active" : payload.kind === "session.idle" ? "idle" : "waiting";
    const incoming = version(signal2);
    const prior = readVersion(objectJson(row.lifecycle_provenance_json));
    const currentFields = objectJson(projection.field_provenance_json);
    const priorActivity = readFieldVersion(currentFields, "__activity");
    const activityApplies = payload.kind === "session.activity" && (!priorActivity || compareVersion(incoming, priorActivity) > 0);
    const decision = lifecycleDecision(row.lifecycle_state, next);
    const lifecycleApplies = decision.disposition === "applied" && (rank(next) > rank(row.lifecycle_state) || rank(next) === rank(row.lifecycle_state) && (!prior || compareVersion(incoming, prior) > 0));
    if (!lifecycleApplies && !activityApplies)
      return {
        disposition: "ignored",
        code: isTerminalState(row.lifecycle_state) ? "runtime.session.terminal_immutable" : "runtime.session.lifecycle_stale",
        sessionId: row.session_id,
        generationId: row.generation_id,
        revision: projection.revision
      };
    const now3 = this.#clock.now();
    const activity = activityApplies ? incoming.source : row.activity_at;
    const state = lifecycleApplies ? next : row.lifecycle_state;
    const activityPresent = Boolean(activity || priorActivity);
    const canonicalRevision = (isTerminalState(state) ? 3 : rank(state) > 0 ? 2 : 1) + (activityPresent ? 1 : 0);
    const revision = Math.max(projection.revision, canonicalRevision);
    const lifecycleProvenance = lifecycleApplies ? provenance2(incoming, signal2) : objectJson(row.lifecycle_provenance_json);
    const endedAt = isTerminalState(state) ? lifecycleApplies ? incoming.source : row.ended_at : null;
    const fieldProvenance = {
      ...currentFields,
      ...activityApplies ? { __activity: provenance2(incoming, signal2) } : {}
    };
    this.#database.prepare("UPDATE session_generations SET lifecycle_state = ?, lifecycle_provenance_json = ?, activity_at = ?, ended_at = ? WHERE project_id = ? AND session_id = ? AND generation_id = ?").run(state, json4(lifecycleProvenance), activity, endedAt, row.project_id, row.session_id, row.generation_id);
    this.#database.prepare("UPDATE generation_projection SET revision = ?, field_provenance_json = ?, actor_activity_at = ?, updated_at = ? WHERE project_id = ? AND session_id = ? AND generation_id = ?").run(revision, json4(fieldProvenance), activity, now3, row.project_id, row.session_id, row.generation_id);
    this.#touchSessionProjection(row.project_id, row.session_id, activityApplies ? activity : void 0, now3, revision);
    return this.#accepted({
      projectId: row.project_id,
      sessionId: row.session_id,
      generationId: row.generation_id
    }, revision, activityApplies && !lifecycleApplies ? "runtime.session.activity_after_terminal" : `runtime.session.lifecycle_${state}`, signal2);
  }
  #accepted(ref, revision, code, signal2) {
    const outboxId = sha256(`session:${signal2.event_id}:${ref.sessionId}:${revision}`).slice(0, 32);
    const now3 = this.#clock.now();
    this.#database.prepare("INSERT OR IGNORE INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, 'tracker', ?, 'pending', ?, 0)").run(outboxId, json4({
      event_id: signal2.event_id,
      event_kind: signal2.event_kind,
      session_id: ref.sessionId,
      generation_id: ref.generationId,
      revision
    }), now3);
    return {
      disposition: "accepted",
      code,
      sessionId: ref.sessionId,
      ...ref.generationId ? { generationId: ref.generationId } : {},
      revision
    };
  }
  #commandSignal(context, kind, payload, clearFields = []) {
    return {
      schema_version: "golem.runtime-signal/v1",
      event_id: context.eventId,
      event_kind: kind,
      producer: "session-command",
      producer_instance_id: context.producerInstanceId,
      harness: context.harness,
      correlation_id: context.eventId,
      deduplication_key: `session-command:${context.eventId}`,
      clocks: {
        source_observed_at: context.sourceObservedAt,
        received_at: context.receivedAt,
        materialized_at: context.receivedAt
      },
      provenance: {
        source: "api",
        confidence: "verified",
        evidence_id: context.eventId
      },
      clear_fields: [...clearFields],
      payload
    };
  }
  #checkRevision(context) {
    const view = this.get(context.projectId, context.sessionId);
    if (!view)
      return {
        disposition: "rejected",
        code: "runtime.session.session_unresolved"
      };
    if (view.revision !== context.expectedRevision)
      return {
        disposition: "rejected",
        code: "runtime.session.revision_conflict",
        revision: view.revision,
        sessionId: context.sessionId,
        generationId: context.generationId
      };
    return void 0;
  }
  rename(input) {
    const conflict = this.#checkRevision(input);
    if (conflict)
      return conflict;
    return this.apply({
      signal: this.#commandSignal(input, "session.metadata_patched", {
        kind: "session.metadata_patched",
        generation: {
          project_id: input.projectId,
          session_id: input.sessionId,
          generation_id: input.generationId
        },
        metadata: { name: input.name }
      })
    });
  }
  patchMetadata(input) {
    const conflict = this.#checkRevision(input);
    if (conflict)
      return conflict;
    return this.apply({
      signal: this.#commandSignal(input, "session.metadata_patched", {
        kind: "session.metadata_patched",
        generation: {
          project_id: input.projectId,
          session_id: input.sessionId,
          generation_id: input.generationId
        },
        metadata: input.metadata
      }, input.clearFields ?? [])
    });
  }
  end(input) {
    const conflict = this.#checkRevision(input);
    if (conflict)
      return conflict;
    return this.apply({
      signal: this.#commandSignal(input, "session.ended", {
        kind: "session.ended",
        generation: {
          project_id: input.projectId,
          session_id: input.sessionId,
          generation_id: input.generationId
        },
        disposition: input.disposition
      })
    });
  }
  #ensureSessionProjection(projectId3, sessionId, metadata, fields, now3) {
    const before = this.#database.prepare("SELECT revision FROM session_projection WHERE project_id = ? AND session_id = ?").get(projectId3, sessionId);
    if (before) {
      this.#database.prepare("UPDATE session_projection SET revision = revision + 1, updated_at = ? WHERE project_id = ? AND session_id = ?").run(now3, projectId3, sessionId);
      return before.revision + 1;
    }
    this.#database.prepare("INSERT OR IGNORE INTO session_projection(project_id, session_id, revision, metadata_json, field_provenance_json, role_json, actor_activity_at, observed_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, NULL, NULL, ?)").run(projectId3, sessionId, json4(metadata), json4(fields), typeof metadata.role === "string" ? metadata.role : null, now3);
    return 1;
  }
  #updateSessionProjection(projectId3, sessionId, metadata, fields, now3) {
    this.#database.prepare("UPDATE session_projection SET revision = revision + 1, metadata_json = ?, field_provenance_json = ?, role_json = ?, updated_at = ? WHERE project_id = ? AND session_id = ?").run(json4(metadata), json4(fields), typeof metadata.role === "string" ? metadata.role : null, now3, projectId3, sessionId);
  }
  #touchSessionProjection(projectId3, sessionId, activity, now3, minimumRevision) {
    const revision = minimumRevision ? this.#database.prepare("SELECT revision FROM session_projection WHERE project_id = ? AND session_id = ?").get(projectId3, sessionId)?.revision ?? 0 : void 0;
    if (activity === void 0)
      this.#database.prepare(`UPDATE session_projection SET revision = ${revision === void 0 ? "revision + 1" : `MAX(revision, ${revision})`}, updated_at = ? WHERE project_id = ? AND session_id = ?`).run(now3, projectId3, sessionId);
    else
      this.#database.prepare(`UPDATE session_projection SET revision = ${revision === void 0 ? "revision + 1" : `MAX(revision, ${revision})`}, actor_activity_at = ?, updated_at = ? WHERE project_id = ? AND session_id = ?`).run(activity, now3, projectId3, sessionId);
  }
  #attachAlias(input, sessionId = input.sessionId, generationId = input.generationId) {
    if (!sessionId)
      return {
        disposition: "review",
        code: "runtime.session.alias_unresolved"
      };
    const session2 = this.#database.prepare("SELECT project_id FROM logical_sessions WHERE project_id = ? AND session_id = ?").get(input.projectId, sessionId);
    if (!session2)
      return {
        disposition: "review",
        code: "runtime.session.alias_unresolved"
      };
    if (generationId) {
      const generation2 = this.#database.prepare("SELECT project_id FROM session_generations WHERE project_id = ? AND session_id = ? AND generation_id = ?").get(input.projectId, sessionId, generationId);
      if (!generation2)
        return {
          disposition: "review",
          code: "runtime.session.alias_unresolved"
        };
    }
    const existing = this.#database.prepare("SELECT session_id, generation_id FROM session_aliases WHERE project_id = ? AND harness = ? AND alias_kind = ? AND COALESCE(producer_id, '') = COALESCE(?, '') AND alias = ?").get(...aliasKey(input));
    if (existing && (existing.session_id !== sessionId || generationId && existing.generation_id && existing.generation_id !== generationId))
      return { disposition: "review", code: "runtime.session.alias_conflict" };
    if (existing && existing.session_id === sessionId && (existing.generation_id ?? null) === (generationId ?? null))
      return {
        disposition: "duplicate",
        code: "runtime.session.alias_duplicate",
        sessionId,
        ...generationId ? { generationId } : {}
      };
    if (!existing)
      this.#database.prepare("INSERT INTO session_aliases(project_id, harness, alias_kind, producer_id, alias, session_id, generation_id, source, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(input.projectId, input.harness, input.aliasKind, input.producerId ?? null, input.alias, sessionId, generationId ?? null, input.source, json4(input.provenance), this.#clock.now());
    return {
      disposition: "accepted",
      code: "runtime.session.alias_attached",
      sessionId,
      ...generationId ? { generationId } : {}
    };
  }
  #recordAliasEffect(input, sessionId, generationId) {
    const now3 = this.#clock.now();
    const row = this.#database.prepare("SELECT revision FROM session_projection WHERE project_id = ? AND session_id = ?").get(input.projectId, sessionId);
    if (!row)
      return;
    const revision = row.revision + 1;
    this.#database.prepare("UPDATE session_projection SET revision = ?, updated_at = ? WHERE project_id = ? AND session_id = ?").run(revision, now3, input.projectId, sessionId);
    const identity = [
      input.projectId,
      input.harness,
      input.aliasKind,
      input.producerId ?? "",
      input.alias,
      sessionId,
      generationId ?? ""
    ].join("|");
    const outboxId = sha256(`session.alias:${identity}:${revision}`).slice(0, 32);
    this.#database.prepare("INSERT OR IGNORE INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, 'tracker', ?, 'pending', ?, 0)").run(outboxId, json4({
      event_id: `alias:${sha256(identity).slice(0, 24)}`,
      event_kind: "session.alias_attached",
      session_id: sessionId,
      generation_id: generationId,
      revision
    }), now3);
  }
  observe(input) {
    const transaction = this.#database.transaction(() => {
      const row = this.#database.prepare("SELECT * FROM session_projection WHERE project_id = ? AND session_id = ?").get(input.projectId, input.sessionId);
      if (!row)
        return {
          disposition: "rejected",
          code: "runtime.session.session_unresolved"
        };
      const generation2 = input.generationId ? this.#database.prepare("SELECT * FROM generation_projection WHERE project_id = ? AND session_id = ? AND generation_id = ?").get(input.projectId, input.sessionId, input.generationId) : void 0;
      if (input.generationId && !generation2)
        return {
          disposition: "rejected",
          code: "runtime.session.generation_unresolved",
          sessionId: input.sessionId,
          generationId: input.generationId
        };
      if (row.observed_at && input.observedAt <= row.observed_at || generation2?.observed_at && input.observedAt <= generation2.observed_at)
        return {
          disposition: "ignored",
          code: "runtime.session.observation_stale",
          sessionId: input.sessionId,
          ...input.generationId ? { generationId: input.generationId } : {},
          revision: row.revision
        };
      const now3 = this.#clock.now();
      const revision = row.revision + 1;
      const sessionFields = {
        ...objectJson(row.field_provenance_json),
        __observed: {
          sourceTime: input.observedAt,
          tieBreak: `observe:${input.sessionId}`
        }
      };
      this.#database.prepare("UPDATE session_projection SET revision = ?, field_provenance_json = ?, observed_at = ?, updated_at = ? WHERE project_id = ? AND session_id = ?").run(revision, json4(sessionFields), input.observedAt, now3, input.projectId, input.sessionId);
      if (generation2 && input.generationId) {
        const generationFields = {
          ...objectJson(generation2.field_provenance_json),
          __observed: {
            sourceTime: input.observedAt,
            tieBreak: `observe:${input.sessionId}`
          }
        };
        this.#database.prepare("UPDATE generation_projection SET revision = revision + 1, field_provenance_json = ?, observed_at = ?, updated_at = ? WHERE project_id = ? AND session_id = ? AND generation_id = ?").run(json4(generationFields), input.observedAt, now3, input.projectId, input.sessionId, input.generationId);
      }
      const identity = `observe:${input.projectId}:${input.sessionId}:${input.generationId ?? "session"}:${input.observedAt}`;
      const outboxId = sha256(identity).slice(0, 32);
      this.#database.prepare("INSERT OR IGNORE INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, 'tracker', ?, 'pending', ?, 0)").run(outboxId, json4({
        event_id: identity,
        event_kind: "session.observed",
        session_id: input.sessionId,
        generation_id: input.generationId,
        revision,
        observed_at: input.observedAt
      }), now3);
      return {
        disposition: "accepted",
        code: "runtime.session.observed",
        sessionId: input.sessionId,
        ...input.generationId ? { generationId: input.generationId } : {},
        revision
      };
    });
    return transaction();
  }
  findAlias(input) {
    const row = this.#database.prepare("SELECT session_id, generation_id FROM session_aliases WHERE project_id = ? AND harness = ? AND alias_kind = ? AND COALESCE(producer_id, '') = COALESCE(?, '') AND alias = ?").get(...aliasKey(input));
    if (!row)
      return void 0;
    return {
      ...row.session_id ? { sessionId: row.session_id } : {},
      ...row.generation_id ? { generationId: row.generation_id } : {}
    };
  }
  resolveLogicalSession(projectId3, reference) {
    const candidates = /* @__PURE__ */ new Set();
    const direct = this.#database.prepare("SELECT session_id FROM logical_sessions WHERE project_id = ? AND session_id = ?").get(projectId3, reference);
    if (direct)
      candidates.add(direct.session_id);
    for (const row of this.#database.prepare("SELECT DISTINCT session_id FROM session_aliases WHERE project_id = ? AND alias = ? AND session_id IS NOT NULL").all(projectId3, reference))
      candidates.add(row.session_id);
    if (candidates.size !== 1)
      return void 0;
    const sessionId = [...candidates][0];
    if (!sessionId)
      return void 0;
    const session2 = this.get(projectId3, sessionId);
    return session2?.activeGenerationId ? Object.freeze({ sessionId, generationId: session2.activeGenerationId }) : void 0;
  }
  get(projectId3, sessionId) {
    const session2 = this.#database.prepare("SELECT * FROM session_projection WHERE project_id = ? AND session_id = ?").get(projectId3, sessionId);
    if (!session2)
      return void 0;
    const rows = this.#database.prepare("SELECT g.*, p.metadata_json, p.field_provenance_json, p.parent_generation_id, p.continuation, p.actor_activity_at, p.observed_at, p.revision FROM session_generations g JOIN generation_projection p ON p.project_id = g.project_id AND p.session_id = g.session_id AND p.generation_id = g.generation_id WHERE g.project_id = ? AND g.session_id = ? ORDER BY g.ordinal").all(projectId3, sessionId);
    const generations = rows.map((row) => ({
      generationId: row.generation_id,
      sessionId: row.session_id,
      projectId: row.project_id,
      ordinal: row.ordinal,
      harness: row.harness,
      state: row.lifecycle_state,
      metadata: objectJson(row.metadata_json),
      fieldProvenance: objectJson(row.field_provenance_json),
      lifecycleProvenance: objectJson(row.lifecycle_provenance_json),
      ...row.parent_generation_id ? {
        parentGenerationId: row.parent_generation_id,
        continuation: "resume"
      } : {},
      ...row.activity_at ? { activityAt: row.activity_at } : {},
      ...row.observed_at ? { observedAt: row.observed_at } : {},
      ...row.ended_at ? { endedAt: row.ended_at } : {},
      revision: row.revision
    }));
    const active2 = generations.find((generation2) => !terminal2(generation2.state));
    return {
      sessionId,
      projectId: projectId3,
      revision: session2.revision,
      metadata: objectJson(session2.metadata_json),
      fieldProvenance: objectJson(session2.field_provenance_json),
      ...session2.role_json ? { role: session2.role_json } : {},
      ...session2.actor_activity_at ? { activityAt: session2.actor_activity_at } : {},
      ...session2.observed_at ? { observedAt: session2.observed_at } : {},
      generationIds: generations.map((generation2) => generation2.generationId),
      ...active2 ? { activeGenerationId: active2.generationId } : {},
      generations
    };
  }
  list(projectId3) {
    return this.#database.prepare("SELECT session_id FROM logical_sessions WHERE project_id = ? ORDER BY session_id").all(projectId3).flatMap((row) => {
      const value2 = this.get(projectId3, row.session_id);
      return value2 ? [value2] : [];
    });
  }
};

// packages/persistence/dist/repositories.js
var cryptoBoundary = crypto5;
var maxOutboxAttempts = 5;
function json5(value2) {
  return JSON.stringify(value2);
}
function boundedLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("runtime outbox claim limit must be an integer from 1 to 100");
  return limit;
}
function retryDelayMs(attempts) {
  return Math.min(6e4, 1e3 * 2 ** Math.max(0, attempts - 1));
}
function redactOutboxError(value2) {
  return value2.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@").replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, "Bearer [REDACTED]").replace(/\b(token|authorization|password|secret)=([^\s&]+)/giu, "$1=[REDACTED]").replace(/\/[A-Za-z0-9._~\-/]{12,}/gu, "[PATH]").slice(0, 512);
}
function terminal3(state) {
  return state === "ended" || state === "errored" || state === "superseded";
}
function objectJson2(value2) {
  if (!value2)
    return {};
  try {
    const parsed = JSON.parse(value2);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function projectId() {
  return `prj_${cryptoBoundary.randomUUID()}`;
}
var RuntimeProjectRepository = class {
  #database;
  #clock;
  constructor(database, clock) {
    this.#database = database;
    this.#clock = clock;
  }
  #view(projectIdValue) {
    const project2 = this.#database.prepare("SELECT project_id, name, created_at FROM projects WHERE project_id = ?").get(projectIdValue);
    if (!project2)
      return void 0;
    const metadata = this.#database.prepare("SELECT name_source, metadata_json FROM project_metadata WHERE project_id = ?").get(projectIdValue);
    const identityKeys = this.#database.prepare("SELECT identity_key FROM project_identity_keys WHERE project_id = ? ORDER BY identity_key").all(projectIdValue).map((row) => row.identity_key);
    const locations = this.#database.prepare("SELECT location_id, project_id, canonical_path, observed_path, relation FROM project_locations WHERE project_id = ? ORDER BY created_at, location_id").all(projectIdValue).map((row) => {
      const state = this.#database.prepare("SELECT status, last_confirmed_at, provenance_json FROM project_location_state WHERE project_id = ? AND location_id = ?").get(row.project_id, row.location_id);
      return Object.freeze({
        locationId: row.location_id,
        canonicalPath: row.canonical_path,
        ...row.observed_path ? { observedPath: row.observed_path } : {},
        relation: row.relation,
        status: state?.status ?? "active",
        ...state?.last_confirmed_at ? { lastConfirmedAt: state.last_confirmed_at } : {},
        provenance: objectJson2(state?.provenance_json)
      });
    });
    return Object.freeze({
      projectId: project2.project_id,
      name: project2.name,
      nameSource: metadata?.name_source ?? "legacy_import",
      metadata: objectJson2(metadata?.metadata_json),
      identityKeys: Object.freeze(identityKeys),
      locations: Object.freeze(locations)
    });
  }
  get(projectIdValue) {
    return this.#view(projectIdValue);
  }
  findByCanonicalPath(canonicalPath) {
    const row = this.#database.prepare("SELECT project_id FROM project_locations WHERE canonical_path = ?").get(canonicalPath);
    return row ? this.#view(row.project_id) : void 0;
  }
  findByIdentityKey(identityKey) {
    const row = this.#database.prepare("SELECT project_id FROM project_identity_keys WHERE identity_key = ?").get(identityKey);
    return row ? this.#view(row.project_id) : void 0;
  }
  #ensureMetadata(projectIdValue, name, source2, metadata, provenance3, now3) {
    const existing = this.#database.prepare("SELECT name_source FROM project_metadata WHERE project_id = ?").get(projectIdValue);
    const manual = existing?.name_source === "register";
    if (!existing) {
      this.#database.prepare("INSERT INTO project_metadata(project_id, name_source, metadata_json, provenance_json, updated_at) VALUES (?, ?, ?, ?, ?)").run(projectIdValue, source2, json5(metadata), json5(provenance3), now3);
    } else {
      this.#database.prepare("UPDATE project_metadata SET name_source = ?, metadata_json = ?, provenance_json = ?, updated_at = ? WHERE project_id = ?").run(manual ? "register" : source2, json5(metadata), json5(provenance3), now3, projectIdValue);
    }
    if (!manual || source2 === "register")
      this.#database.prepare("UPDATE projects SET name = ? WHERE project_id = ?").run(name, projectIdValue);
  }
  #ensureLocation(projectIdValue, location2, provenance3, now3) {
    const existingPath = this.#database.prepare("SELECT location_id, project_id, canonical_path, observed_path, relation FROM project_locations WHERE canonical_path = ?").get(location2.canonicalPath);
    if (existingPath && existingPath.project_id !== projectIdValue)
      throw new Error("runtime.project.identity_conflict");
    const existingLocation = this.#database.prepare("SELECT location_id, project_id, canonical_path, observed_path, relation FROM project_locations WHERE project_id = ? AND location_id = ?").get(projectIdValue, location2.locationId);
    if (existingLocation && existingLocation.canonical_path !== location2.canonicalPath)
      throw new Error("runtime.project.location_conflict");
    const resolvedLocation = existingLocation ?? existingPath;
    if (!resolvedLocation) {
      this.#database.prepare("INSERT INTO project_locations(location_id, project_id, canonical_path, observed_path, relation, source_observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(location2.locationId, projectIdValue, location2.canonicalPath, location2.observedPath ?? null, location2.relation, location2.observedAt, now3);
    }
    const resolvedLocationId = resolvedLocation?.location_id ?? location2.locationId;
    this.#database.prepare("INSERT INTO project_location_state(project_id, location_id, status, last_confirmed_at, provenance_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, location_id) DO UPDATE SET status = excluded.status, last_confirmed_at = excluded.last_confirmed_at, provenance_json = excluded.provenance_json").run(projectIdValue, resolvedLocationId, location2.status ?? "active", now3, json5(provenance3));
    this.#database.prepare("INSERT OR IGNORE INTO location_aliases(project_id, location_id, alias_path, alias_kind, observed_at, provenance_json) VALUES (?, ?, ?, 'path', ?, ?)").run(projectIdValue, resolvedLocationId, location2.canonicalPath, now3, json5(provenance3));
    if (location2.observedPath)
      this.#database.prepare("INSERT OR IGNORE INTO location_aliases(project_id, location_id, alias_path, alias_kind, observed_at, provenance_json) VALUES (?, ?, ?, 'path', ?, ?)").run(projectIdValue, resolvedLocationId, location2.observedPath, now3, json5(provenance3));
    return resolvedLocationId;
  }
  #identityKey(projectIdValue, identityKey, source2, provenance3, now3) {
    if (!identityKey)
      return;
    const existing = this.#database.prepare("SELECT project_id FROM project_identity_keys WHERE identity_key = ?").get(identityKey);
    if (existing && existing.project_id !== projectIdValue)
      throw new Error("runtime.project.identity_conflict");
    this.#database.prepare("INSERT INTO project_identity_keys(project_id, identity_key, source, provenance_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, identity_key) DO UPDATE SET source = excluded.source, provenance_json = excluded.provenance_json, updated_at = excluded.updated_at").run(projectIdValue, identityKey, source2, json5(provenance3), now3);
  }
  #worktreeAlias(projectIdValue, locationId, identityKey, provenance3, now3) {
    if (!identityKey?.startsWith("git-common:", 0))
      return;
    this.#database.prepare("INSERT OR IGNORE INTO location_aliases(project_id, location_id, alias_path, alias_kind, observed_at, provenance_json) VALUES (?, ?, ?, 'worktree', ?, ?)").run(projectIdValue, locationId, identityKey, now3, json5(provenance3));
  }
  #writeOutbox(projectIdValue, event, payload, now3) {
    const outboxId = sha256(`project:${projectIdValue}:${event}:${JSON.stringify(payload)}`).slice(0, 32);
    this.#database.prepare("INSERT OR IGNORE INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, 'management', ?, 'pending', ?, 0)").run(outboxId, json5(payload), now3);
    return outboxId;
  }
  #writeProjectEvent(projectIdValue, event, payload, provenance3, now3) {
    const identity = `${projectIdValue}:${event}:${JSON.stringify(payload)}`;
    const eventId = `evt_${sha256(identity).slice(0, 32)}`;
    this.#database.prepare("INSERT OR IGNORE INTO runtime_events(event_id, deduplication_key, event_kind, payload_json, provenance_json, source_observed_at, received_at, materialized_at, activity_at, metadata_version, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'golem.runtime-signal/v1', 'accepted')").run(eventId, `project:${identity}`, event, json5(payload), json5(provenance3), now3, now3, now3, now3);
    return eventId;
  }
  observe(input) {
    return this.#database.transaction(() => {
      const now3 = this.#clock.now();
      const existingEvent = this.#database.prepare("SELECT event_id FROM runtime_events WHERE event_id = ? OR deduplication_key = ?").get(input.eventId, input.deduplicationKey);
      if (existingEvent) {
        const existing = this.#database.prepare("SELECT project_id, location_id FROM project_locations WHERE canonical_path = ?").get(input.location.canonicalPath);
        return Object.freeze({
          disposition: "duplicate",
          projectId: existing?.project_id ?? input.projectId ?? "",
          locationId: existing?.location_id ?? input.location.locationId
        });
      }
      const byIdentity = input.identityKey ? this.findByIdentityKey(input.identityKey) : void 0;
      const byPath = this.findByCanonicalPath(input.location.canonicalPath);
      if (byIdentity && byPath && byIdentity.projectId !== byPath.projectId)
        throw new Error("runtime.project.identity_conflict");
      const resolvedProjectId = input.projectId ?? byIdentity?.projectId ?? byPath?.projectId ?? projectId();
      if (input.projectId && byPath && byPath.projectId !== input.projectId)
        throw new Error("runtime.project.identity_conflict");
      this.#database.prepare("INSERT OR IGNORE INTO projects(project_id, name, created_at) VALUES (?, ?, ?)").run(resolvedProjectId, input.name, now3);
      this.#ensureMetadata(resolvedProjectId, input.name, input.source, input.metadata ?? {}, input.provenance, now3);
      const locationId = this.#ensureLocation(resolvedProjectId, input.location, input.provenance, now3);
      this.#worktreeAlias(resolvedProjectId, locationId, input.identityKey, input.provenance, now3);
      this.#identityKey(resolvedProjectId, input.identityKey, input.source, input.provenance, now3);
      this.#database.prepare("INSERT INTO runtime_events(event_id, deduplication_key, event_kind, payload_json, provenance_json, source_observed_at, received_at, materialized_at, activity_at, metadata_version, disposition) VALUES (?, ?, 'project.observed', ?, ?, ?, ?, ?, ?, 'golem.runtime-signal/v1', 'accepted')").run(input.eventId, input.deduplicationKey, json5(input.payload), json5(input.provenance), input.occurredAt, now3, now3, input.occurredAt);
      const outboxId = this.#writeOutbox(resolvedProjectId, "project.observed", {
        event_id: input.eventId,
        project_id: resolvedProjectId,
        location_id: locationId
      }, now3);
      return Object.freeze({
        disposition: "accepted",
        projectId: resolvedProjectId,
        locationId,
        outboxId
      });
    })();
  }
  attachLocation(input) {
    return this.#database.transaction(() => {
      const now3 = this.#clock.now();
      if (!this.#view(input.projectId))
        throw new Error("runtime.project.not_found");
      const provenance3 = {
        source: input.source,
        evidence: input.location.evidence
      };
      this.#ensureMetadata(input.projectId, input.name ?? this.#view(input.projectId)?.name ?? input.projectId, input.source, input.metadata ?? {}, provenance3, now3);
      const locationId = this.#ensureLocation(input.projectId, input.location, provenance3, now3);
      this.#worktreeAlias(input.projectId, locationId, input.identityKey, provenance3, now3);
      this.#identityKey(input.projectId, input.identityKey, input.source, provenance3, now3);
      const eventId = this.#writeProjectEvent(input.projectId, "project.location.attached", { project_id: input.projectId, location_id: locationId }, provenance3, now3);
      this.#writeOutbox(input.projectId, "project.location.attached", {
        event_id: eventId,
        project_id: input.projectId,
        location_id: locationId
      }, now3);
      return this.#view(input.projectId);
    })();
  }
  retireLocation(projectIdValue, locationId, reason) {
    return this.#database.transaction(() => {
      const now3 = this.#clock.now();
      if (!this.#view(projectIdValue))
        throw new Error("runtime.project.not_found");
      const changed = this.#database.prepare("UPDATE project_location_state SET status = 'retired', provenance_json = ? WHERE project_id = ? AND location_id = ?").run(json5({ source: "register", reason }), projectIdValue, locationId).changes;
      if (changed !== 1)
        throw new Error("runtime.project.location_not_found");
      const eventId = this.#writeProjectEvent(projectIdValue, "project.location.retired", { project_id: projectIdValue, location_id: locationId, reason }, { source: "register", reason }, now3);
      this.#writeOutbox(projectIdValue, "project.location.retired", {
        event_id: eventId,
        project_id: projectIdValue,
        location_id: locationId,
        reason
      }, now3);
      return this.#view(projectIdValue);
    })();
  }
  rename(projectIdValue, name, source2 = "register") {
    return this.#database.transaction(() => {
      const current = this.#view(projectIdValue);
      if (!current)
        throw new Error("runtime.project.not_found");
      const now3 = this.#clock.now();
      this.#ensureMetadata(projectIdValue, name, source2, current.metadata, { source: source2 }, now3);
      const eventId = this.#writeProjectEvent(projectIdValue, "project.renamed", { project_id: projectIdValue, name }, { source: source2 }, now3);
      this.#writeOutbox(projectIdValue, "project.renamed", { event_id: eventId, project_id: projectIdValue, name }, now3);
      return this.#view(projectIdValue);
    })();
  }
};
var RuntimeRepository = class {
  #database;
  #clock;
  constructor(database, clock) {
    this.#database = database;
    this.#clock = clock;
  }
  runtimeProjectStorage() {
    return new RuntimeProjectRepository(this.#database, this.#clock);
  }
  runtimeSessionStorage() {
    return new RuntimeSessionRepository(this.#database, this.#clock);
  }
  runtimeEndpointStorage() {
    return new RuntimeEndpointRepository(this.#database, this.#clock);
  }
  record(input) {
    const transaction = this.#database.transaction(() => {
      const receivedAt = this.#clock.now();
      const materializedAt = this.#clock.now();
      const inserted = this.#database.prepare("INSERT OR IGNORE INTO runtime_events(event_id, deduplication_key, event_kind, payload_json, provenance_json, source_observed_at, received_at, materialized_at, activity_at, metadata_version, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'golem.event/v1', 'accepted')").run(input.eventId, input.deduplicationKey, input.eventKind, json5(input.payload), json5(input.provenance), input.occurredAt, receivedAt, materializedAt, input.occurredAt);
      if (inserted.changes === 0)
        return { disposition: "duplicate" };
      if (input.mutation.project) {
        const project2 = input.mutation.project;
        this.#database.prepare("INSERT OR IGNORE INTO projects(project_id, name, created_at) VALUES (?, ?, ?)").run(project2.projectId, project2.name, materializedAt);
        this.#database.prepare("INSERT OR IGNORE INTO project_locations(location_id, project_id, canonical_path, observed_path, relation, source_observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(project2.locationId, project2.projectId, project2.canonicalPath, project2.observedPath ?? null, project2.relation, input.occurredAt, materializedAt);
      }
      if (input.mutation.generation) {
        const generation2 = input.mutation.generation;
        this.#database.prepare("INSERT OR IGNORE INTO logical_sessions(session_id, project_id, provenance_json, created_at) VALUES (?, ?, ?, ?)").run(generation2.sessionId, generation2.projectId, json5(input.provenance), materializedAt);
        this.#database.prepare("INSERT OR IGNORE INTO session_generations(generation_id, session_id, project_id, ordinal, harness, lifecycle_state, lifecycle_schema_version, lifecycle_provenance_json, field_schema_version, field_provenance_json, source_observed_at, received_at, activity_at, materialized_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(generation2.generationId, generation2.sessionId, generation2.projectId, generation2.ordinal, generation2.harness, generation2.state, generation2.lifecycleProvenance.schemaVersion, json5(generation2.lifecycleProvenance.details), generation2.fieldProvenance.schemaVersion, json5(generation2.fieldProvenance.details), input.occurredAt, receivedAt, input.occurredAt, materializedAt, terminal3(generation2.state) ? materializedAt : null);
      }
      const outboxId = sha256(`${input.eventId}:${input.outbox.destination}`).slice(0, 32);
      this.#database.prepare("INSERT INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, ?, ?, 'pending', ?, 0)").run(outboxId, input.outbox.destination, json5(input.outbox.payload), materializedAt);
      if (input.failpoint === "before_commit")
        throw new RuntimeFailpointError("before_commit");
      return { disposition: "accepted", outboxId };
    });
    const result2 = transaction();
    if (result2.disposition === "accepted" && input.failpoint === "after_commit")
      throw new RuntimeFailpointError("after_commit");
    return result2;
  }
  /**
   * The materializer's atomic boundary: source event, producer watermark,
   * canonical mutation, explanation, and optional cross-store outbox record.
   * A lower-or-equal producer sequence is retained as an auditable stale event
   * but cannot mutate canonical rows or enqueue delivery.
   */
  materialize(input) {
    return this.#database.transaction(() => {
      const receivedAt = this.#clock.now();
      const materializedAt = this.#clock.now();
      const currentWatermark = this.#database.prepare("SELECT watermark FROM producer_watermarks WHERE producer_id = ?").get(input.producer.id);
      const priorSequence = currentWatermark ? Number(/^([0-9]+):/u.exec(currentWatermark.watermark)?.[1]) : void 0;
      const stale = input.producer.sequence !== void 0 && priorSequence !== void 0 && Number.isSafeInteger(priorSequence) && input.producer.sequence <= priorSequence;
      const disposition = stale ? "stale" : input.disposition;
      const inserted = this.#database.prepare("INSERT OR IGNORE INTO runtime_events(event_id, deduplication_key, event_kind, payload_json, provenance_json, source_observed_at, received_at, materialized_at, activity_at, metadata_version, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'golem.runtime-signal/v1', ?)").run(input.eventId, input.deduplicationKey, input.eventKind, json5(input.payload), json5(input.provenance), input.occurredAt, receivedAt, materializedAt, disposition === "accepted" ? input.occurredAt : null, disposition);
      if (inserted.changes === 0)
        return Object.freeze({ disposition: "duplicate" });
      this.#database.prepare("INSERT OR REPLACE INTO diagnostics(id, code, details_json, created_at) VALUES (?, ?, ?, ?)").run(sha256(`${input.eventId}:${input.explanation.code}`).slice(0, 32), input.explanation.code, json5({
        event_id: input.eventId,
        disposition,
        ...input.explanation.details
      }), materializedAt);
      if (disposition !== "accepted")
        return Object.freeze({
          disposition,
          materializedAt
        });
      if (input.producer.sequence !== void 0) {
        const watermark = `${input.producer.sequence}:${input.eventId}`;
        this.#database.prepare("INSERT INTO producer_watermarks(producer_id, watermark, source_observed_at, received_at, materialized_at, provenance_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(producer_id) DO UPDATE SET watermark = excluded.watermark, source_observed_at = excluded.source_observed_at, received_at = excluded.received_at, materialized_at = excluded.materialized_at, provenance_json = excluded.provenance_json").run(input.producer.id, watermark, input.occurredAt, receivedAt, materializedAt, json5(input.provenance));
      }
      if (input.mutation?.project) {
        const project2 = input.mutation.project;
        this.#database.prepare("INSERT OR IGNORE INTO projects(project_id, name, created_at) VALUES (?, ?, ?)").run(project2.projectId, project2.name, materializedAt);
        this.#database.prepare("INSERT OR IGNORE INTO project_locations(location_id, project_id, canonical_path, observed_path, relation, source_observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(project2.locationId, project2.projectId, project2.canonicalPath, project2.observedPath ?? null, project2.relation, input.occurredAt, materializedAt);
      }
      let outboxId;
      if (input.outbox) {
        outboxId = sha256(`${input.eventId}:${input.outbox.destination}`).slice(0, 32);
        this.#database.prepare("INSERT INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, ?, ?, 'pending', ?, 0)").run(outboxId, input.outbox.destination, json5(input.outbox.payload), materializedAt);
      }
      return Object.freeze({
        disposition: "accepted",
        ...outboxId ? { outboxId } : {},
        materializedAt
      });
    })();
  }
  #failClaim(id, claimToken, error) {
    const row = this.#database.prepare("SELECT attempts FROM runtime_outbox WHERE id = ? AND status = 'claimed' AND claim_token = ?").get(id, claimToken);
    if (!row)
      return void 0;
    const permanent = row.attempts >= maxOutboxAttempts;
    const at = this.#clock.now();
    const nextAttemptAt = permanent ? void 0 : this.#clock.after(retryDelayMs(row.attempts));
    this.#database.prepare("UPDATE runtime_outbox SET status = ?, claim_owner = NULL, claim_token = NULL, claim_until = NULL, retry_started_at = ?, next_attempt_at = ?, last_error = ?, permanent_failure_at = ? WHERE id = ? AND status = 'claimed' AND claim_token = ?").run(permanent ? "permanent_failure" : "pending", permanent ? null : at, nextAttemptAt ?? null, redactOutboxError(error), permanent ? at : null, id, claimToken);
    return Object.freeze({
      status: permanent ? "permanent_failure" : "pending",
      attempts: row.attempts,
      ...nextAttemptAt ? { nextAttemptAt } : {},
      ...permanent ? { permanentFailureAt: at } : {}
    });
  }
  #replayExpiredClaims() {
    const now3 = this.#clock.now();
    const expired = this.#database.prepare("SELECT id, claim_token FROM runtime_outbox WHERE status = 'claimed' AND claim_until < ? ORDER BY claim_until, id").all(now3);
    let replayed = 0;
    for (const row of expired)
      if (this.#failClaim(row.id, row.claim_token, "claim lease expired"))
        replayed += 1;
    return replayed;
  }
  claim(workerId, limit, leaseMs = 3e4) {
    if (!workerId.trim() || !Number.isInteger(leaseMs) || leaseMs < 1)
      throw new Error("runtime outbox claim requires a worker id and positive lease");
    const maximum = boundedLimit(limit);
    return this.#database.transaction(() => {
      this.#replayExpiredClaims();
      const now3 = this.#clock.now();
      const rows = this.#database.prepare("SELECT id, destination, payload_json, attempts FROM runtime_outbox WHERE status = 'pending' AND attempts < ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at, id LIMIT ?").all(maxOutboxAttempts, now3, maximum);
      const claimUntil = this.#clock.after(leaseMs);
      return rows.map((row) => {
        const claimToken = cryptoBoundary.randomUUID();
        const changed = this.#database.prepare("UPDATE runtime_outbox SET status = 'claimed', claim_owner = ?, claim_token = ?, claim_until = ?, next_attempt_at = NULL, attempts = attempts + 1 WHERE id = ? AND status = 'pending' AND attempts < ?").run(workerId, claimToken, claimUntil, row.id, maxOutboxAttempts).changes;
        if (changed !== 1)
          throw new Error("runtime outbox claim lost its transaction lease");
        return Object.freeze({
          id: row.id,
          destination: row.destination,
          payload: JSON.parse(row.payload_json),
          claimToken,
          attempts: row.attempts + 1
        });
      });
    })();
  }
  replay() {
    return this.#database.transaction(() => this.#replayExpiredClaims())();
  }
  ack(id, claimToken) {
    return this.#database.prepare("UPDATE runtime_outbox SET status = 'published', published_at = ?, claim_owner = NULL, claim_token = NULL, claim_until = NULL, next_attempt_at = NULL WHERE id = ? AND status = 'claimed' AND claim_token = ?").run(this.#clock.now(), id, claimToken).changes === 1;
  }
  fail(id, claimToken, error) {
    if (!error.trim())
      throw new Error("runtime outbox failure requires an error");
    return this.#database.transaction(() => this.#failClaim(id, claimToken, error))();
  }
  health() {
    const now3 = this.#clock.now();
    const row = this.#database.prepare("SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed, SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published, SUM(CASE WHEN status = 'permanent_failure' THEN 1 ELSE 0 END) AS permanent_failures, MIN(CASE WHEN status = 'pending' AND retry_started_at IS NOT NULL THEN retry_started_at END) AS oldest_retry_at, MAX(published_at) AS last_success_at FROM runtime_outbox").get();
    const oldestRetryAt = row?.oldest_retry_at ?? void 0;
    return Object.freeze({
      pending: Number(row?.pending ?? 0),
      claimed: Number(row?.claimed ?? 0),
      published: Number(row?.published ?? 0),
      permanentFailures: Number(row?.permanent_failures ?? 0),
      ...oldestRetryAt ? {
        oldestRetryAgeMs: Math.max(0, Date.parse(now3) - Date.parse(oldestRetryAt))
      } : {},
      ...row?.last_success_at ? { lastSuccessAt: row.last_success_at } : {}
    });
  }
};

// packages/persistence/dist/runtime-projection-repository.js
function objectJson3(value2) {
  if (!value2)
    return {};
  try {
    const parsed = JSON.parse(value2);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function safeRows(rows, limit = 2e3) {
  return rows.length <= limit ? rows : rows.slice(0, limit);
}
var RuntimeProjectionRepository = class {
  #database;
  #projects;
  #sessions;
  #endpoints;
  constructor(database, projects, sessions, endpoints) {
    this.#database = database;
    this.#projects = projects;
    this.#sessions = sessions;
    this.#endpoints = endpoints;
  }
  projects() {
    const rows = this.#database.prepare("SELECT project_id FROM projects ORDER BY project_id LIMIT 2000").all();
    return rows.flatMap((row) => {
      const project2 = this.#projects.get(row.project_id);
      return project2 ? [project2] : [];
    });
  }
  sessions(projectId3) {
    if (projectId3)
      return this.#sessions.list(projectId3);
    return this.projects().flatMap((project2) => this.#sessions.list(project2.projectId));
  }
  endpoints(generationId) {
    if (generationId)
      return this.#endpoints.list(generationId);
    return this.sessions().flatMap((session2) => session2.generations.flatMap((generation2) => this.#endpoints.list(generation2.generationId)));
  }
  events() {
    const rows = this.#database.prepare("SELECT event_id, event_kind, payload_json, provenance_json, source_observed_at, received_at, materialized_at, disposition FROM runtime_events ORDER BY received_at, event_id LIMIT 2000").all();
    return safeRows(rows.map((row) => Object.freeze({
      eventId: row.event_id,
      eventKind: row.event_kind,
      payload: objectJson3(row.payload_json),
      provenance: objectJson3(row.provenance_json),
      sourceObservedAt: row.source_observed_at,
      receivedAt: row.received_at,
      materializedAt: row.materialized_at,
      disposition: row.disposition
    })));
  }
  diagnostics() {
    const rows = this.#database.prepare("SELECT id, code, details_json, created_at FROM diagnostics ORDER BY created_at, id LIMIT 2000").all();
    return safeRows(rows.map((row) => Object.freeze({
      id: row.id,
      code: row.code,
      details: objectJson3(row.details_json),
      createdAt: row.created_at
    })));
  }
  watermarks() {
    const rows = this.#database.prepare("SELECT producer_id, watermark, source_observed_at, received_at, materialized_at FROM producer_watermarks ORDER BY producer_id LIMIT 2000").all();
    return rows.map((row) => Object.freeze({
      producerId: row.producer_id,
      watermark: row.watermark,
      sourceObservedAt: row.source_observed_at,
      receivedAt: row.received_at,
      materializedAt: row.materialized_at
    }));
  }
  revision() {
    const row = this.#database.prepare("SELECT (SELECT COUNT(*) FROM runtime_events) AS events, (SELECT COUNT(*) FROM diagnostics) AS diagnostics, COALESCE((SELECT MAX(revision) FROM session_projection), 0) AS sessions, COALESCE((SELECT MAX(revision) FROM generation_projection), 0) AS generations, COALESCE((SELECT MAX(revision) FROM endpoint_claims), 0) AS endpoints").get();
    return row ? Math.max(row.events, row.diagnostics, row.sessions, row.generations, row.endpoints) : 0;
  }
};

// packages/persistence/dist/tracker-core-repository.js
import { sql } from "kysely";
function parseLabels(value2) {
  try {
    const parsed = JSON.parse(value2);
    return Array.isArray(parsed) ? Object.freeze(parsed.filter((item) => typeof item === "string")) : Object.freeze([]);
  } catch {
    return Object.freeze([]);
  }
}
function json6(value2) {
  return JSON.stringify(value2);
}
function rowTicket(row) {
  return Object.freeze({
    id: row.id,
    displayId: row.display_id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    priority: row.priority,
    labels: parseLabels(row.labels),
    ...row.stream_id ? { streamId: row.stream_id } : {},
    ...row.parent_id ? { parentId: row.parent_id } : {},
    ...row.assignee ? { assignee: row.assignee } : {},
    ...row.dispatched_to ? { dispatchedTo: row.dispatched_to } : {},
    ...row.dispatched_at ? { dispatchedAt: row.dispatched_at } : {},
    state: row.state,
    phase: row.phase ?? "queued",
    rank: Number(row.rank),
    ...row.wave === null ? {} : { wave: Number(row.wave) },
    revision: Number(row.revision),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}
function rowComment(row) {
  const anchor = Object.fromEntries(Object.entries({
    quote: row.quote,
    prefix: row.prefix,
    suffix: row.suffix,
    section: row.section,
    sectionId: row.section_id
  }).filter(([, value2]) => value2 !== null));
  return Object.freeze({
    id: row.id,
    ticketId: row.ticket_id,
    ...row.parent_id ? { parentId: row.parent_id } : {},
    author: row.author,
    body: row.body,
    ...Object.keys(anchor).length ? { anchor } : {},
    tag: row.tag,
    status: row.status,
    dispatchState: row.dispatch_state,
    revision: 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}
function ticketPrefix(projectId3) {
  const slug = projectId3.replace(/-[0-9a-f]{6}$/u, "");
  return (slug.slice(0, 3) || "TKT").toUpperCase();
}
function actorKind(actor2) {
  if (!actor2)
    return "system";
  if (actor2 === "system" || actor2.startsWith("system:") || actor2.startsWith("golem-") || actor2 === "golem-drainer")
    return "system";
  if (actor2 === "human" || actor2 === "you" || actor2.startsWith("human:"))
    return "human";
  return "session";
}
function actorLabel(actor2, kind) {
  const value2 = actor2.trim();
  if (!value2)
    return kind;
  const prefix = `${kind}:`;
  return value2.startsWith(prefix) ? value2.slice(prefix.length) || kind : value2;
}
var TrackerCoreRepository = class {
  #store;
  constructor(queries, database) {
    this.#store = new SyncKyselyTrackerStore(queries, database);
  }
  #ticket(id) {
    return this.#store.get(this.#store.queries.selectFrom("tickets").select([
      "tickets.id",
      "tickets.seq",
      "tickets.pseq",
      "tickets.display_id",
      "tickets.project_id",
      "tickets.kind",
      "tickets.title",
      "tickets.body",
      "tickets.state",
      "tickets.phase",
      "tickets.priority",
      "tickets.labels",
      "tickets.stream_id",
      "tickets.parent_id",
      "tickets.assignee",
      "tickets.dispatched_to",
      "tickets.dispatched_at",
      "tickets.source_ref",
      "tickets.wave",
      "tickets.created_by",
      "tickets.created_at",
      "tickets.updated_at",
      "tickets.state_changed_at",
      "tickets.done_at",
      "tickets.archived_at",
      "tickets.rank",
      sql`coalesce((select max(id) from events where events.ticket_id = tickets.id), 1)`.as("revision")
    ]).where((eb) => eb.or([eb("tickets.id", "=", id), eb("tickets.display_id", "=", id)])).limit(1));
  }
  #emit(input) {
    const actor2 = input.mutation.actor;
    const kind = actorKind(actor2);
    const topic = input.ticket ? `ticket/${input.ticket.displayId}` : `project/${input.projectId}/events`;
    const eventData = {
      event_id: input.mutation.eventId,
      outbox_id: input.mutation.outboxId,
      audit_id: input.mutation.auditId,
      actor_kind: kind,
      actor_label: actorLabel(actor2, kind),
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      revision: input.revision ?? input.ticket?.revision ?? 1,
      ...input.details
    };
    const event = this.#store.get(this.#store.queries.insertInto("events").values({
      event_uuid: input.mutation.eventId,
      ticket_id: input.ticket?.id ?? null,
      project_id: input.projectId,
      topic,
      class: "tracker",
      type: input.type,
      actor: actor2,
      actor_kind: kind,
      actor_label: actorLabel(actor2, kind),
      data: json6(eventData),
      created_at: input.mutation.now
    }).returning("id"));
    if (!event)
      throw new Error("tracker event insert did not return an id");
    this.#store.run(this.#store.queries.updateTable("events").set({
      data: json6({
        ...eventData,
        event_id: String(event.id),
        outbox_id: String(event.id),
        audit_id: String(event.id),
        revision: event.id
      })
    }).where("id", "=", event.id));
    if (input.ticket?.parentId) {
      const parent = this.#ticket(input.ticket.parentId);
      if (parent?.kind === "spec") {
        this.#store.run(this.#store.queries.insertInto("events").values({
          event_uuid: null,
          ticket_id: input.ticket.id,
          project_id: input.projectId,
          topic: `spec/${parent.display_id}/tree`,
          class: "tracker",
          type: input.type,
          actor: actor2,
          actor_kind: kind,
          actor_label: actorLabel(actor2, kind),
          data: json6({
            ...eventData,
            event_id: String(event.id),
            outbox_id: String(event.id),
            audit_id: String(event.id),
            revision: event.id,
            mirrored_from_topic: topic
          }),
          created_at: input.mutation.now
        }));
      }
    }
    return event.id;
  }
  allocateDisplayId(prefix) {
    return this.#store.transaction(() => {
      const key = `compat:${prefix}:display_seq`;
      const current = Number(this.#store.get(this.#store.queries.selectFrom("meta").select("value").where("key", "=", key))?.value ?? "0") + 1;
      this.#store.run(this.#store.queries.insertInto("meta").values({ key, value: String(current) }).onConflict((oc) => oc.column("key").doUpdateSet({ value: String(current) })));
      return `${prefix}-${current}`;
    });
  }
  createWorkItem(input) {
    return this.#store.transaction(() => {
      const item = input.workItem;
      const existingPrefix = this.#store.get(this.#store.queries.selectFrom("project_prefixes").select("prefix").where("project_id", "=", item.projectId));
      let prefix = existingPrefix?.prefix;
      if (!prefix) {
        const base = ticketPrefix(item.projectId);
        const taken = new Set(this.#store.all(this.#store.queries.selectFrom("project_prefixes").select("prefix")).map((row) => row.prefix));
        prefix = base;
        for (let suffix = 2; taken.has(prefix); suffix += 1)
          prefix = `${base}${suffix}`;
        this.#store.run(this.#store.queries.insertInto("project_prefixes").values({ project_id: item.projectId, prefix }));
      }
      const ticketSeq = Number(this.#store.get(this.#store.queries.selectFrom("meta").select("value").where("key", "=", "ticket_seq"))?.value ?? "0") + 1;
      this.#store.run(this.#store.queries.insertInto("meta").values({ key: "ticket_seq", value: String(ticketSeq) }).onConflict((oc) => oc.column("key").doUpdateSet({ value: String(ticketSeq) })));
      const pseqKey = `pseq:${item.projectId}`;
      const projectSeq = Number(this.#store.get(this.#store.queries.selectFrom("meta").select("value").where("key", "=", pseqKey))?.value ?? "0") + 1;
      this.#store.run(this.#store.queries.insertInto("meta").values({ key: pseqKey, value: String(projectSeq) }).onConflict((oc) => oc.column("key").doUpdateSet({ value: String(projectSeq) })));
      const id = `TKT-${String(ticketSeq).padStart(4, "0")}`;
      const displayId = `${prefix}-${projectSeq}`;
      this.#store.run(this.#store.queries.insertInto("tickets").values({
        id,
        seq: ticketSeq,
        pseq: projectSeq,
        display_id: displayId,
        project_id: item.projectId,
        kind: item.kind,
        title: item.title,
        body: item.body,
        state: item.state,
        phase: item.phase,
        priority: item.priority,
        labels: json6(item.labels),
        stream_id: item.streamId ?? null,
        parent_id: item.parentId ?? null,
        assignee: item.assignee ?? null,
        dispatched_to: null,
        dispatched_at: null,
        source_ref: null,
        wave: item.wave ?? null,
        created_by: item.createdBy,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
        state_changed_at: item.updatedAt,
        done_at: null,
        archived_at: null,
        rank: item.rank
      }));
      const stored = this.getWorkItem(id);
      if (!stored)
        throw new Error("created ticket cannot be read");
      this.#emit({
        mutation: input.mutation,
        ticket: stored,
        projectId: stored.projectId,
        type: "created",
        resourceType: "ticket",
        resourceId: id,
        details: {
          kind: stored.kind,
          phase: stored.phase,
          title: stored.title
        }
      });
      const created = this.getWorkItem(id);
      if (!created)
        throw new Error("created ticket cannot be read after event");
      return created;
    });
  }
  getWorkItem(id) {
    const row = this.#ticket(id);
    return row ? rowTicket(row) : void 0;
  }
  phaseEvidence(id) {
    const current = this.getWorkItem(id);
    const comments = this.#store.all(this.#store.queries.selectFrom("comments").select(["body", "author"]).where("ticket_id", "=", id));
    const children = this.#store.all(this.#store.queries.selectFrom("tickets").select("state").where("parent_id", "=", id));
    const waves = this.#store.get(this.#store.queries.selectFrom("tickets").select((eb) => eb.fn.count("id").as("count")).where("parent_id", "=", id).where("wave", "is not", null));
    const authorizationEvents = this.#store.all(this.#store.queries.selectFrom("events").select([
      "id",
      "event_uuid",
      "ticket_id",
      "project_id",
      "actor",
      "actor_kind",
      "actor_label",
      "type",
      "data",
      "created_at"
    ]).where("ticket_id", "=", id).where("type", "=", "manager_skip_authorized"));
    const hasComment = (pattern) => comments.some((comment) => pattern.test(comment.body));
    return Object.freeze({
      closingBrief: hasComment(/closing\s+brief/iu),
      verificationReport: hasComment(/verification|verify-done|smoke|test/iu),
      answerComment: comments.length > 0,
      decisionComment: hasComment(/decision|decided/iu),
      reason: hasComment(/reason|blocked/iu),
      groundingSummary: hasComment(/grounding|grounded/iu),
      design: hasComment(/design/iu),
      concerns: hasComment(/concern/iu),
      humanFinalise: comments.some((comment) => (comment.author === "human" || comment.author.startsWith("human:")) && /finali[sz]e|manager/iu.test(comment.body)),
      children: children.length > 0,
      childrenTerminal: children.length > 0 && children.every((child) => child.state === "done" || child.state === "archived"),
      waves: Number(waves?.count ?? 0) > 0,
      childStarted: children.some((child) => child.state !== "todo"),
      managerDispatch: Boolean(this.getWorkItem(id)?.dispatchedTo),
      managerSkip: authorizationEvents.some((event) => {
        try {
          const details = JSON.parse(event.data);
          return details.target_phase === "done" && details.authenticated === true && // Exceptional close is one-step and CAS-bound. The
          // authorization event itself advances the canonical revision,
          // so historic evidence can never be replayed after closure or
          // resurrection. Keep the explicit equality checks here as a
          // defense-in-depth guard for any future two-step adapter.
          event.id === current?.revision && details.current_revision === current?.revision && details.source_phase === current?.phase && details.consumed !== true && (details.role === "human" || details.role === "manager");
        } catch {
          return false;
        }
      })
    });
  }
  listWorkItems(input = {}) {
    let query = this.#store.queries.selectFrom("tickets").select([
      "tickets.id",
      "tickets.seq",
      "tickets.pseq",
      "tickets.display_id",
      "tickets.project_id",
      "tickets.kind",
      "tickets.title",
      "tickets.body",
      "tickets.state",
      "tickets.phase",
      "tickets.priority",
      "tickets.labels",
      "tickets.stream_id",
      "tickets.parent_id",
      "tickets.assignee",
      "tickets.dispatched_to",
      "tickets.dispatched_at",
      "tickets.source_ref",
      "tickets.wave",
      "tickets.created_by",
      "tickets.created_at",
      "tickets.updated_at",
      "tickets.state_changed_at",
      "tickets.done_at",
      "tickets.archived_at",
      "tickets.rank",
      sql`coalesce((select max(id) from events where events.ticket_id = tickets.id), 1)`.as("revision")
    ]);
    if (input.projectId !== void 0)
      query = query.where("tickets.project_id", "=", input.projectId);
    if (input.kind !== void 0)
      query = query.where("tickets.kind", "=", input.kind);
    if (input.phase !== void 0)
      query = query.where("tickets.phase", "=", input.phase);
    if (input.assignee !== void 0)
      query = query.where("tickets.assignee", "=", input.assignee);
    return Object.freeze(this.#store.all(query.orderBy("tickets.seq", "asc")).map(rowTicket));
  }
  searchWorkItems(query, projectId3) {
    const term = `%${query.replace(/[\\%_]/gu, "\\$&")}%`;
    let builder = this.#store.queries.selectFrom("tickets").select([
      "tickets.id",
      "tickets.seq",
      "tickets.pseq",
      "tickets.display_id",
      "tickets.project_id",
      "tickets.kind",
      "tickets.title",
      "tickets.body",
      "tickets.state",
      "tickets.phase",
      "tickets.priority",
      "tickets.labels",
      "tickets.stream_id",
      "tickets.parent_id",
      "tickets.assignee",
      "tickets.dispatched_to",
      "tickets.dispatched_at",
      "tickets.source_ref",
      "tickets.wave",
      "tickets.created_by",
      "tickets.created_at",
      "tickets.updated_at",
      "tickets.state_changed_at",
      "tickets.done_at",
      "tickets.archived_at",
      "tickets.rank",
      sql`coalesce((select max(id) from events where events.ticket_id = tickets.id), 1)`.as("revision")
    ]).where((eb) => eb.or([
      eb("tickets.title", "like", term),
      eb("tickets.body", "like", term),
      eb("tickets.display_id", "like", term)
    ]));
    if (projectId3 !== void 0)
      builder = builder.where("tickets.project_id", "=", projectId3);
    return Object.freeze(this.#store.all(builder.orderBy("tickets.updated_at", "desc")).map(rowTicket));
  }
  updateWorkItem(input) {
    return this.#store.transaction(() => {
      const current = this.getWorkItem(input.id);
      if (!current)
        return void 0;
      if (current.revision !== input.expectedRevision)
        return void 0;
      const patch = input.patch;
      const nextKind = patch.kind ?? current.kind;
      const nextPhase = patch.phase ?? current.phase;
      const nextState = patch.state ?? current.state;
      const stateChanged = nextState !== current.state;
      const phaseChanged = nextPhase !== current.phase;
      const assigneeChanged = patch.assignee !== void 0 && patch.assignee !== current.assignee;
      const changedFields = Object.keys(patch).filter((field) => {
        const key = field;
        return patch[key] !== current[key];
      });
      const lifecycleFields = {
        ...patch.kind === void 0 ? {} : { kind: nextKind },
        ...patch.state === void 0 ? {} : { state: nextState },
        ...patch.phase === void 0 ? {} : { phase: nextPhase }
      };
      if (input.exceptionalClose) {
        const context = input.exceptionalClose.actorContext;
        if (context.authenticated !== true || context.role !== "human" && context.role !== "manager" || typeof context.actor !== "string" || context.actor.trim().length === 0 || typeof input.exceptionalClose.reason !== "string" || input.exceptionalClose.reason.trim().length === 0)
          throw new Error("tracker exceptional close requires trusted authority");
      }
      let eventOrdinal = 0;
      const emit = (event) => {
        eventOrdinal += 1;
        const suffix = eventOrdinal === 1 ? "" : `-${eventOrdinal}`;
        return this.#emit({
          ...event,
          mutation: {
            ...input.mutation,
            eventId: `${input.mutation.eventId}${suffix}`,
            outboxId: `${input.mutation.outboxId}${suffix}`,
            auditId: `${input.mutation.auditId}${suffix}`
          }
        });
      };
      const changed = this.#store.run(this.#store.queries.updateTable("tickets").set({
        ...lifecycleFields,
        ...patch.title === void 0 ? {} : { title: patch.title },
        ...patch.body === void 0 ? {} : { body: patch.body },
        ...patch.priority === void 0 ? {} : { priority: patch.priority },
        ...patch.labels === void 0 ? {} : { labels: json6(patch.labels) },
        ...patch.streamId === void 0 ? {} : { stream_id: patch.streamId },
        ...patch.parentId === void 0 ? {} : { parent_id: patch.parentId },
        ...patch.assignee === void 0 ? {} : { assignee: patch.assignee },
        ...patch.rank === void 0 ? {} : { rank: patch.rank },
        ...patch.wave === void 0 ? {} : { wave: patch.wave },
        ...stateChanged ? { state_changed_at: input.mutation.now } : {},
        ...stateChanged && nextState === "done" ? { done_at: input.mutation.now } : {},
        ...stateChanged && nextState === "archived" ? { archived_at: input.mutation.now } : {},
        updated_at: input.mutation.now
      }).where("tickets.id", "=", current.id));
      if (changed.changes !== 1)
        return void 0;
      const stored = this.getWorkItem(current.id);
      if (!stored)
        throw new Error("updated ticket cannot be read");
      let emittedEvent = false;
      let completionEventId;
      if (input.exceptionalClose) {
        emit({
          ticket: stored,
          projectId: stored.projectId,
          type: "manager_skip_authorized",
          resourceType: "ticket",
          resourceId: stored.id,
          details: {
            source_phase: current.phase,
            target_phase: nextPhase,
            current_revision: current.revision,
            authenticated: true,
            role: input.exceptionalClose.actorContext.role,
            authorized_actor: input.exceptionalClose.actorContext.actor,
            authority_source: input.exceptionalClose.actorContext.source,
            consumed: true,
            reason: input.exceptionalClose.reason.trim()
          }
        });
        emittedEvent = true;
      }
      if (stateChanged) {
        emit({
          ticket: stored,
          projectId: stored.projectId,
          type: "state_change",
          resourceType: "ticket",
          resourceId: stored.id,
          details: {
            from: current.state,
            to: nextState,
            from_phase: current.phase,
            to_phase: nextPhase
          }
        });
        emittedEvent = true;
      }
      if (phaseChanged && !stateChanged) {
        emit({
          ticket: stored,
          projectId: stored.projectId,
          type: "phase_change",
          resourceType: "ticket",
          resourceId: stored.id,
          details: {
            from: current.phase,
            to: nextPhase,
            state: nextState
          }
        });
        emittedEvent = true;
      }
      if (assigneeChanged) {
        emit({
          ticket: stored,
          projectId: stored.projectId,
          type: "assigned",
          resourceType: "ticket",
          resourceId: stored.id,
          details: {
            from: current.assignee ?? null,
            to: patch.assignee ?? null
          }
        });
        emittedEvent = true;
      }
      if (stateChanged || phaseChanged) {
        const actorForms = [
          input.mutation.actor,
          input.mutation.actor.replace(/^session:/u, ""),
          input.mutation.actor.replace(/^human:/u, "")
        ].filter(Boolean);
        this.#store.run(this.#store.queries.updateTable("comment_dispatches").set({ status: "addressed", addressed_at: input.mutation.now }).where("ticket_id", "=", current.id).where("status", "in", ["pending", "delivered"]).where("session_id", "in", actorForms));
        const dispatchedComments = this.#store.all(this.#store.queries.selectFrom("comment_dispatches").select("comment_id").where("ticket_id", "=", current.id));
        for (const { comment_id: commentId } of dispatchedComments) {
          const outstanding = this.#store.get(this.#store.queries.selectFrom("comment_dispatches").select((eb) => eb.fn.count("id").as("count")).where("comment_id", "=", commentId).where("status", "in", ["pending", "delivered"]));
          if (Number(outstanding?.count ?? 0) === 0)
            this.#store.run(this.#store.queries.updateTable("comments").set({
              dispatch_state: "addressed",
              updated_at: input.mutation.now
            }).where("id", "=", commentId).where("dispatch_state", "!=", "n/a"));
        }
      }
      if (["built", "verified", "rejected", "done"].includes(nextPhase) && (input.exceptionalClose !== void 0 || input.mutation.actor !== "human")) {
        completionEventId = emit({
          ticket: stored,
          projectId: stored.projectId,
          type: "dispatch_completion_stamped",
          resourceType: "ticket",
          resourceId: stored.id,
          details: { phase: nextPhase }
        });
        emittedEvent = true;
      }
      if (!emittedEvent && changedFields.length > 0) {
        emit({
          ticket: stored,
          projectId: stored.projectId,
          type: "updated",
          resourceType: "ticket",
          resourceId: stored.id,
          details: { fields: changedFields.sort() }
        });
      }
      if (["built", "verified", "rejected", "done"].includes(nextPhase) && (input.exceptionalClose !== void 0 || input.mutation.actor !== "human")) {
        this.#store.run(this.#store.queries.updateTable("message_envelopes").set({
          completed_at: input.mutation.now,
          completed_event_id: completionEventId ?? null
        }).where("ticket_id", "=", current.id).where("recipient_session_id", "=", input.mutation.actor).where("delivery_attempted_at", "is not", null).where("completed_at", "is", null));
      }
      return this.getWorkItem(current.id) ?? stored;
    });
  }
  /**
   * The canonical companion of a durable ticket envelope. It deliberately
   * updates only historical dispatch output (and, for trusted legacy bridge
   * calls, an otherwise absent current assignee) under the ticket CAS.
   */
  recordWorkItemDispatch(input) {
    return this.#store.transaction(() => {
      const current = this.getWorkItem(input.id);
      if (!current || current.revision !== input.expectedRevision)
        return void 0;
      const changed = this.#store.run(this.#store.queries.updateTable("tickets").set({
        ...input.assignee === void 0 ? {} : { assignee: input.assignee },
        dispatched_to: input.dispatchedTo,
        dispatched_at: input.mutation.now,
        updated_at: input.mutation.now
      }).where("tickets.id", "=", current.id));
      if (changed.changes !== 1)
        return void 0;
      const stored = this.getWorkItem(current.id);
      if (!stored)
        throw new Error("dispatched ticket cannot be read");
      this.#emit({
        mutation: input.mutation,
        ticket: stored,
        projectId: stored.projectId,
        type: "dispatch_queued",
        resourceType: "ticket",
        resourceId: stored.id,
        details: {}
      });
      return this.getWorkItem(current.id) ?? stored;
    });
  }
  transitionWorkItem(input) {
    return this.#store.transaction(() => {
      const current = this.getWorkItem(input.id);
      if (!current)
        return void 0;
      if (current.revision !== input.expectedRevision)
        return void 0;
      const changed = this.#store.run(this.#store.queries.updateTable("tickets").set({
        phase: input.phase,
        state: input.state,
        updated_at: input.mutation.now,
        state_changed_at: input.mutation.now
      }).where("tickets.id", "=", current.id));
      if (changed.changes !== 1)
        return void 0;
      const stored = this.getWorkItem(current.id);
      if (!stored)
        throw new Error("transitioned ticket cannot be read");
      this.#emit({
        mutation: input.mutation,
        ticket: stored,
        projectId: stored.projectId,
        type: "phase_change",
        resourceType: "ticket",
        resourceId: stored.id,
        details: {
          from_phase: current.phase,
          to_phase: input.phase,
          artifacts: input.artifacts
        }
      });
      return this.getWorkItem(current.id) ?? stored;
    });
  }
  createComment(input) {
    return this.#store.transaction(() => {
      const value2 = input.comment;
      const anchor = value2.anchor ?? {};
      this.#store.run(this.#store.queries.insertInto("comments").values({
        id: value2.id,
        ticket_id: value2.ticketId,
        author: value2.author,
        body: value2.body,
        quote: typeof anchor.quote === "string" ? anchor.quote : null,
        prefix: typeof anchor.prefix === "string" ? anchor.prefix : null,
        suffix: typeof anchor.suffix === "string" ? anchor.suffix : null,
        section: typeof anchor.section === "string" ? anchor.section : null,
        section_id: typeof anchor.sectionId === "string" ? anchor.sectionId : null,
        tag: value2.tag,
        status: value2.status,
        dispatch_state: value2.dispatchState,
        parent_id: value2.parentId ?? null,
        created_at: value2.createdAt,
        updated_at: value2.updatedAt
      }));
      const ticket = this.getWorkItem(value2.ticketId);
      if (!ticket)
        throw new Error("comment ticket cannot be read");
      this.#emit({
        mutation: input.mutation,
        ...ticket ? { ticket } : {},
        projectId: ticket.projectId,
        type: value2.parentId ? "comment_replied" : "comment_created",
        resourceType: "comment",
        resourceId: value2.id,
        details: { comment_id: value2.id, parent_id: value2.parentId ?? null }
      });
      return value2;
    });
  }
  getComment(id) {
    const row = this.#store.get(this.#store.queries.selectFrom("comments").selectAll().where("id", "=", id));
    return row ? rowComment(row) : void 0;
  }
  updateComment(input) {
    return this.#store.transaction(() => {
      const changed = this.#store.run(this.#store.queries.updateTable("comments").set({
        ...input.patch.body === void 0 ? {} : { body: input.patch.body },
        ...input.patch.tag === void 0 ? {} : { tag: input.patch.tag },
        ...input.patch.status === void 0 ? {} : { status: input.patch.status },
        ...input.patch.dispatchState === void 0 ? {} : { dispatch_state: input.patch.dispatchState },
        updated_at: input.mutation.now
      }).where("id", "=", input.commentId).where("ticket_id", "=", input.ticketId));
      if (changed.changes !== 1)
        return void 0;
      const comment = this.getComment(input.commentId);
      const ticket = this.getWorkItem(input.ticketId);
      if (comment && ticket)
        this.#emit({
          mutation: input.mutation,
          ticket,
          projectId: ticket.projectId,
          type: "comment_updated",
          resourceType: "comment",
          resourceId: comment.id,
          details: { comment_id: comment.id }
        });
      return comment;
    });
  }
  listComments(ticketId) {
    return Object.freeze(this.#store.all(this.#store.queries.selectFrom("comments").selectAll().where("ticket_id", "=", ticketId).orderBy("created_at", "asc").orderBy("id", "asc")).map(rowComment));
  }
  createLink(input) {
    return this.#store.transaction(() => {
      const value2 = input.link;
      this.#store.run(this.#store.queries.insertInto("links").values({
        from_ticket: value2.ticketId,
        to_ticket: value2.targetTicketId,
        type: value2.relation
      }));
      const ticket = this.getWorkItem(value2.ticketId);
      if (!ticket)
        throw new Error("link ticket cannot be read");
      this.#emit({
        mutation: input.mutation,
        ticket,
        projectId: ticket.projectId,
        type: "link_created",
        resourceType: "link",
        resourceId: value2.id,
        details: {
          from_ticket: value2.ticketId,
          to_ticket: value2.targetTicketId,
          type: value2.relation
        }
      });
      return value2;
    });
  }
  deleteLink(input) {
    return this.#store.transaction(() => {
      const deleted = this.#store.run(this.#store.queries.deleteFrom("links").where("from_ticket", "=", input.ticketId).where("to_ticket", "=", input.targetTicketId).where("type", "=", input.relation));
      if (deleted.changes !== 1)
        return false;
      const ticket = this.getWorkItem(input.ticketId);
      if (ticket)
        this.#emit({
          mutation: input.mutation,
          ticket,
          projectId: ticket.projectId,
          type: "link_deleted",
          resourceType: "link",
          resourceId: `${input.ticketId}:${input.targetTicketId}:${input.relation}`,
          details: {
            from_ticket: input.ticketId,
            to_ticket: input.targetTicketId,
            type: input.relation
          }
        });
      return true;
    });
  }
  listLinks(ticketId) {
    const rows = this.#store.all(this.#store.queries.selectFrom("links").select(["from_ticket", "to_ticket", "type"]).where((eb) => eb.or([
      eb("from_ticket", "=", ticketId),
      eb("to_ticket", "=", ticketId)
    ])).orderBy("type", "asc"));
    return Object.freeze(rows.map((row) => Object.freeze({
      id: `${row.from_ticket}:${row.to_ticket}:${row.type}`,
      ticketId: row.from_ticket,
      targetTicketId: row.to_ticket,
      relation: row.type,
      actor: "legacy",
      createdAt: ""
    })));
  }
  upsertStream(input) {
    return this.#store.transaction(() => {
      const existing = this.#store.get(this.#store.queries.selectFrom("streams").select("id").where("id", "=", input.stream.id));
      const currentRevision = Number(this.#store.get(this.#store.queries.selectFrom("events").select((_eb) => sql`coalesce(max(id), 1)`.as("revision")).where(sql`json_extract(data, '$.stream_id') = ${input.stream.id}`))?.revision ?? 1);
      if (existing && input.expectedRevision !== void 0 && input.expectedRevision !== currentRevision || !existing && input.expectedRevision !== void 0)
        return void 0;
      if (existing) {
        this.#store.run(this.#store.queries.updateTable("streams").set({
          name: input.stream.name,
          mode: input.stream.mode,
          description: input.stream.description,
          updated_at: input.mutation.now
        }).where("id", "=", input.stream.id));
      } else {
        this.#store.run(this.#store.queries.insertInto("streams").values({
          id: input.stream.id,
          project_id: input.stream.projectId,
          name: input.stream.name,
          mode: input.stream.mode,
          description: input.stream.description,
          created_at: input.stream.createdAt,
          updated_at: input.mutation.now
        }));
      }
      const row = this.#store.get(this.#store.queries.selectFrom("streams").select([
        "streams.id",
        "streams.project_id",
        "streams.name",
        "streams.mode",
        "streams.description",
        "streams.created_at",
        "streams.updated_at",
        sql`coalesce((select max(id) from events where json_extract(events.data, '$.stream_id') = streams.id), 1)`.as("revision")
      ]).where("id", "=", input.stream.id));
      if (!row)
        return void 0;
      const stream = Object.freeze({
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        mode: row.mode,
        description: row.description,
        revision: existing ? currentRevision + 1 : 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
      this.#emit({
        mutation: input.mutation,
        projectId: stream.projectId,
        revision: stream.revision,
        type: existing ? "stream_updated" : "stream_created",
        resourceType: "stream",
        resourceId: stream.id,
        details: { stream_id: stream.id }
      });
      return this.listStreams(stream.projectId).find((item) => item.id === stream.id) ?? stream;
    });
  }
  listStreams(projectId3) {
    let query = this.#store.queries.selectFrom("streams").select([
      "streams.id",
      "streams.project_id",
      "streams.name",
      "streams.mode",
      "streams.description",
      "streams.created_at",
      "streams.updated_at",
      sql`coalesce((select max(id) from events where json_extract(events.data, '$.stream_id') = streams.id), 1)`.as("revision")
    ]);
    if (projectId3 !== void 0)
      query = query.where("streams.project_id", "=", projectId3);
    const rows = this.#store.all(query.orderBy("created_at", "asc").orderBy("id", "asc"));
    return Object.freeze(rows.map((row) => Object.freeze({
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      mode: row.mode,
      description: row.description,
      revision: Number(row.revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })));
  }
  auditCore() {
    const rows = this.#store.all(this.#store.queries.selectFrom("events").select([
      "id",
      "event_uuid",
      "ticket_id",
      "project_id",
      "actor",
      "actor_kind",
      "actor_label",
      "type",
      "data",
      "created_at"
    ]).where("class", "=", "tracker").where("event_uuid", "is not", null).orderBy("id", "asc"));
    return Object.freeze(rows.map((row) => {
      let details = {};
      try {
        details = JSON.parse(row.data);
      } catch {
      }
      return Object.freeze({
        id: String(details.audit_id ?? row.event_uuid ?? row.id),
        actor: row.actor ?? "system",
        action: row.type,
        resourceType: details.resource_type ?? "ticket",
        resourceId: String(details.resource_id ?? row.ticket_id ?? ""),
        revision: Number(details.revision ?? 0),
        details,
        createdAt: row.created_at
      });
    }));
  }
};

// packages/persistence/dist/tracker-repository.js
import crypto6 from "node:crypto";
function parseObject(value2) {
  try {
    const parsed = JSON.parse(value2);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function parseClasses(value2) {
  try {
    const parsed = JSON.parse(value2);
    if (!Array.isArray(parsed))
      return ["tracker", "lifecycle", "custom"];
    const classes = parsed.filter((item) => item === "tracker" || item === "lifecycle" || item === "custom");
    return classes.length > 0 ? Object.freeze(classes) : ["tracker", "lifecycle", "custom"];
  } catch {
    return ["tracker", "lifecycle", "custom"];
  }
}
function endpoint2(value2) {
  const candidate = parseObject(value2);
  const capabilities = Array.isArray(candidate.capabilities) ? candidate.capabilities.filter((item) => Boolean(item) && typeof item === "object" && typeof item.capability === "string" && typeof item.qualification === "string" && typeof item.observedAt === "string") : [];
  return Object.freeze({
    recipientId: String(candidate.recipientId ?? ""),
    generationId: String(candidate.generationId ?? ""),
    endpointId: String(candidate.endpointId ?? ""),
    ownerFence: Number(candidate.ownerFence ?? 0),
    readiness: candidate.readiness ?? "uninitialized",
    mode: candidate.mode ?? "pull",
    capabilities: Object.freeze(capabilities.map((item) => ({ ...item })))
  });
}
function hydrateEnvelope(row) {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    rootId: row.root_id,
    ...row.parent_id ? { parentId: row.parent_id } : {},
    idempotencyKey: row.idempotency_key,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    ...row.reply_to_recipient_id ? { replyToRecipientId: row.reply_to_recipient_id } : {},
    kind: row.kind,
    payload: parseObject(row.payload_json),
    endpoint: endpoint2(row.endpoint_json),
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    ...row.deadline_at ? { deadlineAt: row.deadline_at } : {},
    ...row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {},
    createdAt: row.created_at
  });
}
function hydrateClaim(row) {
  if (!row.claim_owner || !row.claim_token || !row.claim_until)
    throw new Error("claimed tracker envelope is missing its lease facts");
  return Object.freeze({
    ...hydrateEnvelope(row),
    status: "claimed",
    claimOwner: row.claim_owner,
    claimToken: row.claim_token,
    claimUntil: row.claim_until
  });
}
function hydrateEvent(row) {
  return Object.freeze({
    sequence: Number(row.sequence),
    projectId: row.project_id,
    id: row.id,
    deduplicationKey: row.deduplication_key,
    topic: row.topic,
    class: row.class,
    payload: parseObject(row.payload_json),
    createdAt: row.created_at
  });
}
function hydrateSubscription(row) {
  return Object.freeze({
    id: row.id,
    name: row.name,
    recipientId: row.recipient_id,
    topic: row.topic,
    classes: parseClasses(row.classes_json),
    cursor: Number(row.cursor_sequence),
    manual: row.manual === 1,
    status: row.status,
    createdAt: row.created_at
  });
}
function passiveEntry(row) {
  return Object.freeze({
    recipientId: row.recipient_id,
    ticketId: row.ticket_id,
    category: row.category,
    baseline: parseObject(row.baseline_json),
    value: parseObject(row.value_json),
    eventId: row.event_id
  });
}
function json7(value2) {
  return JSON.stringify(value2);
}
function redactDiagnostic(value2) {
  return value2.replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, "Bearer [REDACTED]").replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY))=\S+/gu, "$1=[REDACTED]").replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@").slice(0, 1024);
}
var TrackerRepository = class {
  #database;
  constructor(database) {
    this.#database = database;
  }
  listDispatchOperations(projectId3) {
    return Object.freeze(this.#database.prepare(`SELECT
						receipt.command_id,
						receipt.project_id,
						receipt.resource_id AS ticket_id,
						receipt.result_json,
						envelope.status AS envelope_status,
						receipt.committed_at
					FROM command_receipts AS receipt
					INNER JOIN tickets AS ticket
						ON ticket.id = receipt.resource_id
						AND ticket.project_id = receipt.project_id
					LEFT JOIN tracker_envelopes AS envelope
						ON envelope.project_id = receipt.project_id
						AND envelope.idempotency_key = receipt.idempotency_key
						AND envelope.kind = 'ticket_dispatch'
					WHERE receipt.project_id = ?
						AND receipt.command_kind = 'dispatch'
						AND receipt.resource_type = 'ticket'
						AND receipt.outcome_status = 'completed'
					ORDER BY receipt.committed_at DESC, receipt.command_id DESC`).all(projectId3).map((row) => Object.freeze({
      commandId: row.command_id,
      projectId: row.project_id,
      ticketId: row.ticket_id,
      result: parseObject(row.result_json),
      ...row.envelope_status ? { envelopeStatus: row.envelope_status } : {},
      committedAt: row.committed_at
    })));
  }
  #audit(kind, subjectId, details, now3) {
    this.#database.prepare("INSERT INTO tracker_delivery_audit(id, kind, subject_id, details_json, created_at) VALUES (?, ?, ?, ?, ?)").run(crypto6.randomUUID(), kind, subjectId, json7(details), now3);
  }
  #create(envelope, fingerprint) {
    const existingId = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE id = ?").get(envelope.id);
    if (existingId)
      return existingId.fingerprint === fingerprint ? { kind: "duplicate", envelope: hydrateEnvelope(existingId) } : { kind: "conflict", reason: "id" };
    const existingKey = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE idempotency_key = ?").get(envelope.idempotencyKey);
    if (existingKey)
      return existingKey.fingerprint === fingerprint ? { kind: "duplicate", envelope: hydrateEnvelope(existingKey) } : { kind: "conflict", reason: "idempotency_key" };
    this.#database.prepare("INSERT INTO tracker_envelopes(id, project_id, root_id, parent_id, idempotency_key, fingerprint, sender_id, recipient_id, reply_to_recipient_id, kind, payload_json, endpoint_json, status, attempts, max_attempts, deadline_at, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(envelope.id, envelope.projectId, envelope.rootId, envelope.parentId ?? null, envelope.idempotencyKey, fingerprint, envelope.senderId, envelope.recipientId, envelope.replyToRecipientId ?? null, envelope.kind, json7(envelope.payload), json7(envelope.endpoint), envelope.status, envelope.attempts, envelope.maxAttempts, envelope.deadlineAt ?? null, envelope.nextAttemptAt ?? null, envelope.createdAt);
    return { kind: "created", envelope };
  }
  createEnvelope(input) {
    return this.#database.transaction(() => {
      const result2 = this.#create(input.envelope, input.fingerprint);
      if (result2.kind === "created")
        this.#audit("envelope.created", input.envelope.id, { recipient_id: input.envelope.recipientId }, input.envelope.createdAt);
      return result2;
    })();
  }
  #recover(now3) {
    const expired = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE status IN ('pending', 'claimed', 'retrying') AND deadline_at IS NOT NULL AND deadline_at <= ? ORDER BY created_at, id").all(now3);
    const leased = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE status = 'claimed' AND claim_until <= ? ORDER BY claim_until, id").all(now3);
    const settled = [];
    for (const row of expired) {
      this.#database.prepare("UPDATE tracker_envelopes SET status = 'expired', claim_owner = NULL, claim_token = NULL, claim_until = NULL, next_attempt_at = NULL, last_error = 'delivery deadline elapsed' WHERE id = ? AND status IN ('pending', 'claimed', 'retrying')").run(row.id);
      const updated = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE id = ?").get(row.id);
      if (updated) {
        settled.push(hydrateEnvelope(updated));
        this.#audit("envelope.expired", row.id, {}, now3);
      }
    }
    for (const row of leased) {
      if (row.deadline_at && row.deadline_at <= now3)
        continue;
      const exhausted = Number(row.attempts) >= Number(row.max_attempts);
      const changed = this.#database.prepare("UPDATE tracker_envelopes SET status = ?, claim_owner = NULL, claim_token = NULL, claim_until = NULL, next_attempt_at = ?, last_error = ? WHERE id = ? AND status = 'claimed' AND claim_token = ?").run(exhausted ? "dead_letter" : "retrying", exhausted ? null : now3, exhausted ? "claim lease expired after final attempt" : "claim lease expired", row.id, row.claim_token).changes;
      if (changed !== 1)
        continue;
      const updated = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE id = ?").get(row.id);
      if (updated) {
        settled.push(hydrateEnvelope(updated));
        this.#audit(exhausted ? "envelope.dead_letter" : "envelope.lease_replayed", row.id, {}, now3);
      }
    }
    return Object.freeze(settled);
  }
  claimEnvelopes(input) {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#recover(input.now);
      const candidates = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE status IN ('pending', 'retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND (deadline_at IS NULL OR deadline_at > ?) AND attempts < max_attempts ORDER BY created_at, id LIMIT ?").all(input.now, input.now, input.limit);
      const claims = [];
      for (const candidate of candidates) {
        const token = crypto6.randomUUID();
        const changed = this.#database.prepare("UPDATE tracker_envelopes SET status = 'claimed', attempts = attempts + 1, claim_owner = ?, claim_token = ?, claim_until = ?, next_attempt_at = NULL WHERE id = ? AND status IN ('pending', 'retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)").run(input.workerId, token, input.claimUntil, candidate.id, input.now).changes;
        if (changed !== 1)
          continue;
        const row = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE id = ?").get(candidate.id);
        if (!row)
          throw new Error("claimed tracker envelope disappeared");
        claims.push(hydrateClaim(row));
        this.#audit("envelope.claimed", candidate.id, { worker_id: input.workerId }, input.now);
      }
      this.#database.exec("COMMIT");
      return Object.freeze(claims);
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }
  settleEnvelope(input) {
    return this.#database.transaction(() => {
      const changed = this.#database.prepare("UPDATE tracker_envelopes SET status = ?, claim_owner = CASE WHEN ? = 'delivered' THEN claim_owner ELSE NULL END, claim_token = CASE WHEN ? = 'delivered' THEN claim_token ELSE NULL END, claim_until = CASE WHEN ? = 'delivered' THEN claim_until ELSE NULL END, next_attempt_at = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END, last_error = ? WHERE id = ? AND status = 'claimed' AND claim_token = ?").run(input.status, input.status, input.status, input.status, input.nextAttemptAt ?? null, input.status, input.now, input.error ? redactDiagnostic(input.error) : null, input.id, input.claimToken).changes;
      if (changed !== 1)
        return void 0;
      const row = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE id = ?").get(input.id);
      if (!row)
        return void 0;
      this.#audit(`envelope.${input.status}`, input.id, { error: input.error ? redactDiagnostic(input.error) : null }, input.now);
      return hydrateEnvelope(row);
    })();
  }
  acknowledgeEnvelope(input) {
    return this.#database.transaction(() => {
      const row = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE id = ?").get(input.id);
      if (!row || row.recipient_id !== input.recipientId)
        return false;
      const existing = this.#database.prepare("SELECT payload_json FROM tracker_envelope_acknowledgements WHERE envelope_id = ? AND acknowledgement_id = ?").get(input.id, input.acknowledgementId);
      if (row.status === "acknowledged")
        return Boolean(existing && existing.payload_json === json7(input.payload));
      if (!["claimed", "delivered"].includes(row.status) || row.claim_token !== input.claimToken)
        return false;
      const inserted = this.#database.prepare("INSERT OR IGNORE INTO tracker_envelope_acknowledgements(envelope_id, acknowledgement_id, recipient_id, payload_json, acknowledged_at) VALUES (?, ?, ?, ?, ?)").run(input.id, input.acknowledgementId, input.recipientId, json7(input.payload), input.now).changes;
      if (inserted === 0)
        return existing?.payload_json === json7(input.payload);
      const settled = this.#database.prepare("UPDATE tracker_envelopes SET status = 'acknowledged', acknowledged_at = COALESCE(acknowledged_at, ?), claim_owner = NULL, claim_token = NULL, claim_until = NULL WHERE id = ? AND recipient_id = ? AND status IN ('claimed', 'delivered') AND claim_token = ?").run(input.now, input.id, input.recipientId, input.claimToken).changes;
      if (settled !== 1)
        return false;
      this.#audit("envelope.acknowledged", input.id, { recipient_id: input.recipientId }, input.now);
      return true;
    })();
  }
  createReplyEnvelope(input) {
    return this.#database.transaction(() => {
      const parent = this.#database.prepare("SELECT * FROM tracker_envelopes WHERE id = ?").get(input.parentId);
      if (!parent)
        return { kind: "conflict", reason: "id" };
      if (parent.reply_to_recipient_id !== input.envelope.recipientId || parent.recipient_id !== input.envelope.senderId || !["claimed", "delivered"].includes(parent.status) || parent.claim_token !== input.claimToken)
        throw new Error("reply envelope does not match its durable reply route");
      const result2 = this.#create(input.envelope, input.fingerprint);
      if (result2.kind === "created")
        this.#audit("envelope.reply_created", input.envelope.id, { parent_id: input.parentId }, input.envelope.createdAt);
      return result2;
    })();
  }
  recoverEnvelopes(now3) {
    return this.#database.transaction(() => this.#recover(now3))();
  }
  appendBusEvent(input) {
    return this.#database.transaction(() => {
      const byId = this.#database.prepare("SELECT * FROM tracker_bus_events WHERE id = ?").get(input.event.id);
      if (byId)
        return byId.fingerprint === input.fingerprint ? { kind: "duplicate", event: hydrateEvent(byId) } : { kind: "conflict", reason: "id" };
      const byKey = this.#database.prepare("SELECT * FROM tracker_bus_events WHERE deduplication_key = ?").get(input.event.deduplicationKey);
      if (byKey)
        return byKey.fingerprint === input.fingerprint ? { kind: "duplicate", event: hydrateEvent(byKey) } : { kind: "conflict", reason: "deduplication_key" };
      this.#database.prepare("INSERT INTO tracker_bus_events(id, project_id, deduplication_key, fingerprint, topic, class, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(input.event.id, input.event.projectId, input.event.deduplicationKey, input.fingerprint, input.event.topic, input.event.class, json7(input.event.payload), input.event.createdAt);
      const row = this.#database.prepare("SELECT * FROM tracker_bus_events WHERE id = ?").get(input.event.id);
      if (!row)
        throw new Error("created bus event disappeared");
      this.#audit("bus.appended", row.id, { topic: row.topic }, row.created_at);
      return { kind: "created", event: hydrateEvent(row) };
    })();
  }
  upsertSubscription(input) {
    return this.#database.transaction(() => {
      this.#database.prepare("INSERT INTO tracker_subscriptions(id, name, recipient_id, topic, classes_json, cursor_sequence, manual, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(recipient_id, name) DO UPDATE SET topic = excluded.topic, classes_json = excluded.classes_json, cursor_sequence = MAX(tracker_subscriptions.cursor_sequence, excluded.cursor_sequence), manual = excluded.manual, status = excluded.status").run(input.id, input.name, input.recipientId, input.topic, json7(input.classes), input.cursor, input.manual ? 1 : 0, input.status, input.createdAt);
      const row = this.#database.prepare("SELECT * FROM tracker_subscriptions WHERE recipient_id = ? AND name = ?").get(input.recipientId, input.name);
      if (!row)
        throw new Error("subscription upsert disappeared");
      this.#audit("subscription.upserted", row.id, { recipient_id: row.recipient_id }, input.createdAt);
      return hydrateSubscription(row);
    })();
  }
  pendingSubscriptionEvents(input) {
    const subscriptionRow = this.#database.prepare("SELECT * FROM tracker_subscriptions WHERE id = ?").get(input.id);
    if (subscriptionRow?.status !== "active")
      return void 0;
    const subscription = hydrateSubscription(subscriptionRow);
    const placeholders = subscription.classes.map(() => "?").join(", ");
    const rows = this.#database.prepare(`SELECT * FROM tracker_bus_events WHERE topic = ? AND sequence > ? AND class IN (${placeholders}) ORDER BY sequence ASC LIMIT ?`).all(subscription.topic, subscription.cursor, ...subscription.classes, input.limit);
    const events = rows.map(hydrateEvent);
    return Object.freeze({
      subscription,
      events: Object.freeze(events),
      fromSequence: subscription.cursor,
      toSequence: events.at(-1)?.sequence ?? subscription.cursor
    });
  }
  advanceSubscriptionCursor(input) {
    if (input.toSequence < input.fromSequence)
      return false;
    return this.#database.prepare("UPDATE tracker_subscriptions SET cursor_sequence = ? WHERE id = ? AND cursor_sequence = ? AND status = 'active'").run(input.toSequence, input.id, input.fromSequence).changes === 1;
  }
  upsertPassiveDelta(input) {
    this.#database.transaction(() => {
      this.#database.prepare("INSERT INTO tracker_passive_slots(recipient_id, ticket_id, category, baseline_json, value_json, event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(recipient_id, ticket_id, category) DO UPDATE SET sequence = (SELECT COALESCE(MAX(sequence), 0) + 1 FROM tracker_passive_slots), value_json = excluded.value_json, event_id = excluded.event_id, updated_at = excluded.updated_at").run(input.recipientId, input.ticketId, input.category, json7(input.baseline), json7(input.value), input.eventId, input.now, input.now);
      this.#audit("passive.coalesced", input.eventId, { recipient_id: input.recipientId }, input.now);
    })();
  }
  claimPassiveBatch(input) {
    return this.#database.transaction(() => {
      let cursor = this.#database.prepare("SELECT * FROM tracker_passive_cursors WHERE recipient_id = ?").get(input.recipientId);
      if (cursor?.lease_id && cursor.lease_until && cursor.lease_until > input.now)
        return void 0;
      if (!cursor) {
        this.#database.prepare("INSERT INTO tracker_passive_cursors(recipient_id, cursor_sequence, updated_at) VALUES (?, 0, ?)").run(input.recipientId, input.now);
        cursor = this.#database.prepare("SELECT * FROM tracker_passive_cursors WHERE recipient_id = ?").get(input.recipientId);
      }
      if (!cursor)
        throw new Error("passive cursor creation disappeared");
      let entries;
      let toSequence;
      if (cursor.pending_json && cursor.pending_to_sequence !== null) {
        const parsed = JSON.parse(cursor.pending_json);
        entries = Array.isArray(parsed) ? Object.freeze(parsed) : [];
        toSequence = cursor.pending_to_sequence;
      } else {
        const rows = this.#database.prepare("SELECT * FROM tracker_passive_slots WHERE recipient_id = ? AND sequence > ? ORDER BY sequence ASC").all(input.recipientId, cursor.cursor_sequence);
        if (rows.length === 0)
          return void 0;
        entries = Object.freeze(rows.map(passiveEntry));
        toSequence = Number(rows.at(-1)?.sequence);
        this.#database.prepare("UPDATE tracker_passive_cursors SET pending_json = ?, pending_to_sequence = ?, updated_at = ? WHERE recipient_id = ?").run(json7(entries), toSequence, input.now, input.recipientId);
      }
      const claimed = this.#database.prepare("UPDATE tracker_passive_cursors SET lease_id = ?, lease_until = ?, updated_at = ? WHERE recipient_id = ? AND (lease_id IS NULL OR lease_until <= ?)").run(input.leaseId, input.leaseUntil, input.now, input.recipientId, input.now).changes;
      if (claimed !== 1)
        return void 0;
      this.#audit("passive.claimed", input.leaseId, { recipient_id: input.recipientId }, input.now);
      return Object.freeze({
        recipientId: input.recipientId,
        leaseId: input.leaseId,
        leaseUntil: input.leaseUntil,
        cursor: cursor.cursor_sequence,
        body: entries.map((entry2) => `- ${entry2.ticketId}: ${entry2.category}`).join("\n"),
        entries
      });
    })();
  }
  commitPassiveBatch(input) {
    return this.#database.transaction(() => {
      const cursor = this.#database.prepare("SELECT * FROM tracker_passive_cursors WHERE recipient_id = ? AND lease_id = ?").get(input.recipientId, input.leaseId);
      if (!cursor || cursor.pending_to_sequence === null)
        return false;
      this.#database.prepare("DELETE FROM tracker_passive_slots WHERE recipient_id = ? AND sequence <= ?").run(input.recipientId, cursor.pending_to_sequence);
      const changed = this.#database.prepare("UPDATE tracker_passive_cursors SET cursor_sequence = ?, pending_json = NULL, pending_to_sequence = NULL, lease_id = NULL, lease_until = NULL, updated_at = ? WHERE recipient_id = ? AND lease_id = ?").run(cursor.pending_to_sequence, input.now, input.recipientId, input.leaseId).changes;
      if (changed === 1)
        this.#audit("passive.committed", input.leaseId, { recipient_id: input.recipientId }, input.now);
      return changed === 1;
    })();
  }
  releasePassiveBatch(input) {
    const changed = this.#database.prepare("UPDATE tracker_passive_cursors SET lease_id = NULL, lease_until = NULL, updated_at = ? WHERE recipient_id = ? AND lease_id = ? AND pending_json IS NOT NULL").run(input.now, input.recipientId, input.leaseId).changes;
    if (changed === 1)
      this.#audit("passive.released", input.leaseId, { recipient_id: input.recipientId }, input.now);
    return changed === 1;
  }
  prune(input) {
    return this.#database.transaction(() => {
      const events = this.#database.prepare("DELETE FROM tracker_bus_events WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM tracker_subscriptions s WHERE s.topic = tracker_bus_events.topic AND s.status IN ('active', 'offline') AND s.cursor_sequence < tracker_bus_events.sequence)").run(input.before).changes;
      const envelopes = this.#database.prepare("DELETE FROM tracker_envelopes WHERE created_at < ? AND status IN ('acknowledged', 'expired', 'cancelled') AND NOT EXISTS (SELECT 1 FROM tracker_envelopes child WHERE child.parent_id = tracker_envelopes.id)").run(input.before).changes;
      const auditId = crypto6.randomUUID();
      this.#database.prepare("INSERT INTO tracker_delivery_audit(id, kind, subject_id, details_json, created_at) VALUES (?, 'tracker.pruned', 'tracker', ?, ?)").run(auditId, json7({ events, envelopes }), input.now);
      return Object.freeze({ events, envelopes, auditId });
    })();
  }
  audit() {
    return this.#database.prepare("SELECT id, kind, subject_id, details_json, created_at FROM tracker_delivery_audit ORDER BY created_at, id").all().map((row) => Object.freeze({
      id: row.id,
      kind: row.kind,
      subjectId: row.subject_id,
      details: parseObject(row.details_json),
      createdAt: row.created_at
    }));
  }
};

// packages/persistence/dist/owner.js
var fileSystem3 = fs4;
var pathBoundary2 = path3;
function ensureParent(target) {
  fileSystem3.mkdirSync(pathBoundary2.dirname(target), {
    recursive: true,
    mode: 448
  });
}
function safeClose(database) {
  try {
    database?.close();
  } catch {
  }
}
var PersistenceOwner = class {
  #runtime;
  #tracker;
  #runtimeSql;
  #trackerSql;
  #runtimeRepository;
  #runtimeProjectionRepository;
  #trackerRepository;
  #trackerCoreRepository;
  #managementRepository;
  #commandReceiptRepository;
  #committedPublicationRepository;
  #browserPrincipalRepository;
  #paths;
  #ownerId;
  #clock;
  #lockPath;
  #ownerLock;
  #closed = false;
  #trackerBaseline;
  constructor(paths, options) {
    this.#paths = Object.freeze({ ...paths });
    this.#clock = options.clock ?? systemPersistenceClock;
    this.#ownerId = options.ownerId ?? sha256(`${paths.runtimePath}:${process.pid}:${this.#clock.now()}`).slice(0, 24);
    this.#lockPath = paths.lockPath ?? `${paths.runtimePath}.owner.lock`;
    this.#ownerLock = acquireOwnerLock(this.#lockPath, this.#ownerId, this.#clock);
    let runtime;
    let tracker;
    try {
      ensureParent(paths.runtimePath);
      ensureParent(paths.trackerPath);
      runtime = new Database3(paths.runtimePath);
      tracker = new Database3(paths.trackerPath);
      this.#runtime = runtime;
      this.#tracker = tracker;
      this.#runtimeSql = new Kysely({
        dialect: new SqliteDialect({
          database: runtime
        })
      });
      this.#trackerSql = new Kysely({
        dialect: new SqliteDialect({
          database: tracker
        })
      });
      const runtimePlan = planFor(runtime, "runtime", "apply");
      const trackerIsLegacy = hasTrackerTables(tracker) && !hasManagedTrackerSchema(tracker);
      const trackerPlan = trackerIsLegacy ? void 0 : planFor(tracker, "tracker", "apply");
      this.#trackerBaseline = trackerIsLegacy ? "unmanaged" : "managed";
      configure(runtime);
      applyPlan(runtime, paths.runtimePath, runtimePlan, this.#clock);
      if (this.#trackerBaseline === "managed" && trackerPlan) {
        tracker.pragma("busy_timeout = 1000");
        configure(tracker);
        applyPlan(tracker, paths.trackerPath, trackerPlan, this.#clock);
      }
      this.#runtimeRepository = new RuntimeRepository(runtime, this.#clock);
      this.#trackerRepository = new TrackerRepository(tracker);
      this.#runtimeProjectionRepository = new RuntimeProjectionRepository(runtime, this.#runtimeRepository.runtimeProjectStorage(), this.#runtimeRepository.runtimeSessionStorage(), this.#runtimeRepository.runtimeEndpointStorage());
      this.#trackerCoreRepository = new TrackerCoreRepository(this.#trackerSql, tracker);
      this.#managementRepository = new TrackerManagementRepository(this.#trackerSql, tracker);
      this.#commandReceiptRepository = new CommandReceiptRepository(this.#trackerSql, tracker);
      this.#committedPublicationRepository = new CommittedPublicationRepository(tracker);
      this.#browserPrincipalRepository = new BrowserPrincipalRepository(tracker, this.#clock);
    } catch (error) {
      safeClose(runtime);
      safeClose(tracker);
      releaseOwnerLock(this.#ownerLock);
      throw error;
    }
  }
  plan(scope, mode = "dry-run") {
    const database = scope === "runtime" ? this.#runtime : this.#tracker;
    const databasePath = scope === "runtime" ? this.#paths.runtimePath : this.#paths.trackerPath;
    return mode === "dry-run" ? dryRunPlan(database, databasePath, scope, this.#clock) : planFor(database, scope, "apply");
  }
  apply(scope, expectedPlanHash) {
    const database = scope === "runtime" ? this.#runtime : this.#tracker;
    const databasePath = scope === "runtime" ? this.#paths.runtimePath : this.#paths.trackerPath;
    const approvedPlan = planFor(database, scope, "apply");
    if (typeof expectedPlanHash !== "string" || !expectedPlanHash.trim() || expectedPlanHash !== approvedPlan.planHash)
      throw new PersistenceMigrationError("plan_mismatch", `${scope} migration plan no longer matches the approved dry-run`);
    if (scope === "tracker" && this.#trackerBaseline === "unmanaged")
      configure(this.#tracker);
    const plan = planFor(database, scope, "apply");
    if (expectedPlanHash !== plan.planHash)
      throw new PersistenceMigrationError("plan_mismatch", `${scope} migration plan changed while preparing the source database`);
    const result2 = applyPlan(database, databasePath, plan, this.#clock);
    if (scope === "tracker") {
      this.#trackerBaseline = "managed";
    }
    return result2;
  }
  checkpointAndBackup(scope) {
    return backupDatabase(scope === "runtime" ? this.#runtime : this.#tracker, scope === "runtime" ? this.#paths.runtimePath : this.#paths.trackerPath, this.#clock);
  }
  recordRuntimeTransaction(input) {
    return this.#runtimeRepository.record(input);
  }
  materializeRuntimeEvent(input) {
    return this.#runtimeRepository.materialize(input);
  }
  claimRuntimeOutbox(workerId, limit, leaseMs) {
    return this.#runtimeRepository.claim(workerId, limit, leaseMs);
  }
  replayRuntimeOutbox() {
    return this.#runtimeRepository.replay();
  }
  ackRuntimeOutbox(id, claimToken) {
    return this.#runtimeRepository.ack(id, claimToken);
  }
  failRuntimeOutbox(id, claimToken, error) {
    return this.#runtimeRepository.fail(id, claimToken, error);
  }
  runtimeOutboxHealth() {
    return this.#runtimeRepository.health();
  }
  runtimeProjectStorage() {
    return this.#runtimeRepository.runtimeProjectStorage();
  }
  runtimeSessionStorage() {
    return this.#runtimeRepository.runtimeSessionStorage();
  }
  runtimeEndpointStorage() {
    return this.#runtimeRepository.runtimeEndpointStorage();
  }
  runtimeProjectionStorage() {
    return this.#runtimeProjectionRepository;
  }
  trackerStorage() {
    return this.#trackerRepository;
  }
  trackerCoreStorage() {
    return this.#trackerCoreRepository;
  }
  managementStorage() {
    return this.#managementRepository;
  }
  commandGatewayStorage() {
    const receipts = this.#commandReceiptRepository;
    const storage = this.#commandReceiptRepository;
    return Object.freeze({
      receipts,
      transaction: (fn) => storage.transaction(fn)
    });
  }
  committedPublicationStorage() {
    return this.#committedPublicationRepository;
  }
  browserPrincipalStorage() {
    return this.#browserPrincipalRepository;
  }
  status() {
    return Object.freeze({
      owner: {
        lockPath: this.#lockPath,
        ownerId: this.#ownerId,
        nonce: this.#ownerLock.nonce,
        pid: process.pid
      },
      runtime: health(this.#runtime),
      tracker: {
        ...health(this.#tracker),
        baseline: this.#trackerBaseline
      }
    });
  }
  async close() {
    if (this.#closed)
      return;
    this.#closed = true;
    try {
      this.#runtime.pragma("wal_checkpoint(PASSIVE)");
      if (this.#trackerBaseline === "managed")
        this.#tracker.pragma("wal_checkpoint(PASSIVE)");
      await Promise.all([
        this.#runtimeSql.destroy(),
        this.#trackerSql.destroy()
      ]);
    } finally {
      safeClose(this.#runtime);
      safeClose(this.#tracker);
      releaseOwnerLock(this.#ownerLock);
    }
  }
};
function openPersistenceForControlPlane(paths, options = {}) {
  return new PersistenceOwner(paths, options);
}

// packages/persistence/dist/migration-compat.js
function openLegacyMigrationPersistence(paths, options = {}) {
  const owner = openPersistenceForControlPlane(paths, options);
  return Object.freeze({
    projects: owner.runtimeProjectStorage(),
    sessions: owner.runtimeSessionStorage(),
    projections: owner.runtimeProjectionStorage(),
    close: () => owner.close()
  });
}

// packages/runtime/dist/inbox.js
import crypto7 from "node:crypto";
import fs5 from "node:fs";
import path4 from "node:path";

// packages/runtime/dist/projects/evidence.js
import { execFileSync } from "node:child_process";
import crypto8 from "node:crypto";
import fs6 from "node:fs";
import os from "node:os";
import path5 from "node:path";

// packages/runtime/dist/projects/service.js
import fs7 from "node:fs";
import path6 from "node:path";

// packages/runtime/dist/sessions/index.js
var SessionService = class {
  #options;
  constructor(options) {
    this.#options = options;
  }
  apply(signal2, alias) {
    const payload = signal2.payload;
    if (!("generation" in payload))
      return {
        disposition: "rejected",
        code: "runtime.session.invalid_payload"
      };
    if (!this.#options.projects.get(payload.generation.project_id))
      return {
        disposition: "rejected",
        code: "runtime.session.project_unresolved"
      };
    return this.#options.sessions.apply({
      signal: signal2,
      ...alias ? { alias } : {}
    });
  }
  observe(input) {
    return this.#options.sessions.observe(input);
  }
  get(projectId3, sessionId) {
    return this.#options.sessions.get(projectId3, sessionId);
  }
  list(projectId3) {
    return this.#options.sessions.list(projectId3);
  }
  attachAlias(input) {
    return this.#options.sessions.attachAlias(input);
  }
  rename(input) {
    return this.#options.sessions.rename(input);
  }
  patchMetadata(input) {
    return this.#options.sessions.patchMetadata(input);
  }
  end(input) {
    return this.#options.sessions.end(input);
  }
};
function createSessionService(options) {
  return new SessionService(options);
}

// packages/compat/dist/plan/plan.js
import { createHash as createHash2 } from "node:crypto";

// packages/compat/dist/redact/redact.js
import { createHash } from "node:crypto";
var secretKey = /(?:secret|token|password|credential|api[_-]?key|authorization)/iu;
var secretPathSegment = /(?:Bearer\s+|(?:sk|ghp|xoxb)-)[-_A-Za-z0-9.]{6,}|(?:secret|token|password|credential|api[_-]?key|authorization)/iu;
var secretDiagnosticValue = /(?:Bearer\s+|(?:sk|ghp|xoxb)-)[-_A-Za-z0-9.]{6,}/giu;
var secretDiagnosticComponent = /(?:secret|token|password|credential|api[_-]?key|authorization)[-_A-Za-z0-9.]*/giu;
function digest2(value2) {
  return createHash("sha256").update(value2).digest("hex").slice(0, 16);
}
function isSecretLikeKey(key) {
  return secretKey.test(key);
}
function redactedRelativePath(relativePath) {
  return relativePath.replaceAll("\\", "/").split("/").filter((segment) => segment && segment !== ".").map((segment) => secretPathSegment.test(segment) ? `$REDACTED_${digest2(segment)}` : segment).join("/");
}
function redactedHomePath(relativePath) {
  const safeRelative = redactedRelativePath(relativePath);
  return safeRelative ? `$GOLEM_HOME/${safeRelative}` : "$GOLEM_HOME";
}
function redactedDisplayPath(value2) {
  const normalized = value2.replaceAll("\\", "/");
  const root = normalized.startsWith("/") ? "/" : "";
  return `${root}${redactedRelativePath(normalized)}`;
}
function redactDiagnosticText(value2) {
  return value2.replace(secretDiagnosticValue, (match) => `$REDACTED_${digest2(match)}`).replace(secretDiagnosticComponent, (match) => `$REDACTED_${digest2(match)}`);
}

// packages/compat/dist/plan/types.js
var auditPlannerVersion = "golem.compat.audit/v1";

// packages/compat/dist/plan/plan.js
function stable(value2) {
  if (Array.isArray(value2))
    return value2.map(stable);
  if (value2 && typeof value2 === "object") {
    return Object.fromEntries(Object.entries(value2).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stable(child)]));
  }
  return value2;
}
function stableJson(value2) {
  return `${JSON.stringify(stable(value2), null, 2)}
`;
}
function hash(value2) {
  return createHash2("sha256").update(stableJson(value2)).digest("hex");
}
function short(value2) {
  return hash(value2).slice(0, 16);
}
function stringField(record, field) {
  const value2 = record[field];
  return typeof value2 === "string" && value2.trim() ? value2.trim() : void 0;
}
function records(document, key) {
  const value2 = document?.[key];
  if (!Array.isArray(value2))
    return void 0;
  return value2.filter((entry2) => entry2 !== null && typeof entry2 === "object" && !Array.isArray(entry2));
}
function pathIsSafe(value2) {
  const normalized = value2.replaceAll("\\", "/").replace(/\/+$/u, "") || "/";
  return normalized !== "/" && !/(?:^|\/)(?:\.golem|\.config\/golem|renders)(?:\/|$)/u.test(normalized);
}
function worktreeRoot(record, location2) {
  const explicit = stringField(record, "main_path") ?? stringField(record, "worktree_of");
  if (explicit)
    return explicit;
  const marker = location2.replaceAll("\\", "/").match(/^(.*)\/\.worktrees\/[^/]+(?:\/.*)?$/u);
  return marker?.[1] ?? location2;
}
function proposal(kind, value2) {
  return `${kind}:${short(value2)}`;
}
function action(kind, reason, sourceIds, affectedIds, alternatives = [], facts = {}) {
  return {
    id: `act_${short([kind, reason, ...sourceIds, ...affectedIds, ...alternatives].join("\0"))}`,
    kind,
    reason,
    source_ids: [...sourceIds].sort(),
    affected_ids: [...affectedIds].sort(),
    alternatives: [...alternatives].sort(),
    facts: stable(facts)
  };
}
function sourceActions(sources, findings) {
  const result2 = [];
  for (const source2 of sources) {
    switch (source2.status) {
      case "missing":
        result2.push(action("ignore", "audit.source.missing", [source2.id], [], [], {
          category: source2.category
        }));
        break;
      case "unsafe":
      case "unreadable":
      case "malformed":
      case "changed":
        result2.push(action("quarantine", source2.status === "changed" ? "audit.source.changed_during_audit" : `audit.source.${source2.status}`, [source2.id], [], [], { category: source2.category }));
        break;
      default:
        break;
    }
  }
  for (const finding2 of findings) {
    if (finding2.code === "audit.source.entry_limit")
      result2.push(action("quarantine", finding2.code, [finding2.source_id], [], [], {
        bounded: true
      }));
  }
  return result2;
}
function projectActions(document) {
  const rows = records(document, "projects");
  if (!rows)
    return document ? [
      action("quarantine", "audit.projects.invalid_schema", ["projects"], [])
    ] : [];
  const candidates = rows.map((row, index) => ({
    id: stringField(row, "id"),
    location: stringField(row, "path"),
    root: stringField(row, "path") ? worktreeRoot(row, stringField(row, "path") ?? "") : void 0,
    index,
    row
  }));
  const pathOwners = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    if (!candidate.id || !candidate.location || !candidate.root || !pathIsSafe(candidate.location))
      continue;
    const owner = pathOwners.get(candidate.root) ?? /* @__PURE__ */ new Set();
    owner.add(candidate.id);
    pathOwners.set(candidate.root, owner);
  }
  const byId = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    const key = candidate.id ?? `missing-${candidate.index}`;
    const group = byId.get(key) ?? [];
    group.push(candidate);
    byId.set(key, group);
  }
  const result2 = [];
  for (const [id, group] of [...byId.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const candidatePaths = group.map((entry2) => entry2.location).filter((value2) => Boolean(value2));
    const roots = group.map((entry2) => entry2.root).filter((value2) => Boolean(value2));
    const malformed = group.some((entry2) => !entry2.id || !entry2.location || !entry2.root || !pathIsSafe(entry2.location));
    const conflictingOwner = roots.some((root) => (pathOwners.get(root)?.size ?? 0) > 1);
    const uniqueRoots = [...new Set(roots)].sort();
    const strongCanonicalId = /^prj_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id);
    if (malformed || conflictingOwner || uniqueRoots.length > 1 && !strongCanonicalId) {
      result2.push(action("review", malformed ? "compat.project.weak_or_unsafe" : "compat.project.ambiguous_location", ["projects"], [], candidatePaths.map((value2) => proposal("location", value2)), { evidence_count: group.length }));
      continue;
    }
    const canonical2 = proposal("project", id);
    result2.push(action("attach", "compat.project.strong_registration", ["projects"], [
      canonical2,
      ...candidatePaths.map((value2) => proposal("location", value2))
    ], [], {
      location_aliases: candidatePaths.length,
      worktree_aliases: candidatePaths.filter((value2) => worktreeRoot(group[0]?.row ?? {}, value2) !== value2).length
    }));
  }
  return result2;
}
function sessionCandidates(document, source2) {
  const rows = records(document, source2 === "sessions" ? "sessions" : "facts");
  if (!rows)
    return [];
  return rows.map((row) => {
    const id = stringField(row, source2 === "sessions" ? "session_id" : "canonical_id");
    const project2 = stringField(row, "project_id");
    const harness = stringField(row, "harness");
    return {
      ...id ? { id } : {},
      ...project2 ? { project: project2 } : {},
      ...harness ? { harness } : {},
      terminal: Boolean(stringField(row, "ended_at")) || ["ended", "errored", "superseded"].includes(stringField(row, "status") ?? ""),
      source: source2
    };
  });
}
function sessionActions(sessionsDocument, factsDocument) {
  const candidates = [
    ...sessionCandidates(sessionsDocument, "sessions"),
    ...sessionCandidates(factsDocument, "facts")
  ];
  const result2 = [];
  const byIdentity = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    const key = candidate.id && candidate.project && candidate.harness ? `${candidate.id}\0${candidate.project}\0${candidate.harness}` : `weak-${byIdentity.size}`;
    const group = byIdentity.get(key) ?? [];
    group.push(candidate);
    byIdentity.set(key, group);
  }
  const idsByRawId = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    if (!candidate.id || !candidate.project || !candidate.harness)
      continue;
    const scopes = idsByRawId.get(candidate.id) ?? /* @__PURE__ */ new Set();
    scopes.add(`${candidate.project}\0${candidate.harness}`);
    idsByRawId.set(candidate.id, scopes);
  }
  for (const group of byIdentity.values()) {
    const first = group[0];
    if (!first)
      continue;
    const sourceIds = [
      ...new Set(group.map((candidate) => candidate.source))
    ].sort();
    if (!first.id || !first.project || !first.harness) {
      result2.push(action("review", "compat.session.weak_evidence", sourceIds, [], [], {
        evidence_count: group.length
      }));
      continue;
    }
    const crossScope = (idsByRawId.get(first.id)?.size ?? 0) > 1;
    const canonical2 = proposal("session", `${first.project}\0${first.harness}\0${first.id}`);
    if (crossScope) {
      result2.push(action("review", "compat.session.ambiguous_scope", sourceIds, [], [canonical2], { evidence_count: group.length }));
      continue;
    }
    result2.push(action(group.some((candidate) => candidate.terminal) ? "retire" : "attach", group.some((candidate) => candidate.terminal) ? "compat.session.terminal_history" : "compat.session.strong_alias", sourceIds, [canonical2, proposal("project", first.project)], [], {
      evidence_count: group.length,
      terminal: group.some((candidate) => candidate.terminal)
    }));
  }
  if (sessionsDocument && !records(sessionsDocument, "sessions"))
    result2.push(action("quarantine", "audit.sessions.invalid_schema", ["sessions"], []));
  if (factsDocument && !records(factsDocument, "facts"))
    result2.push(action("quarantine", "audit.facts.invalid_schema", ["facts"], []));
  return result2;
}
function configActions(document) {
  if (!document)
    return [];
  const managed = /* @__PURE__ */ new Set(["schema_version", "launch"]);
  const unknown = Object.keys(document).filter((key) => !managed.has(key));
  return [
    action("review", "compat.config.typed_importer_required", ["config"], [], [], {
      unknown_key_count: unknown.length,
      secret_like_key_count: unknown.filter(isSecretLikeKey).length,
      managed_region_rewrite: false,
      typed_importer_available: false
    })
  ];
}
function trackerAuthorityActions(sources) {
  const tracker = sources.find((source2) => source2.id === "tracker" && source2.status === "present");
  const sidecars = sources.filter((source2) => (source2.id === "tracker-wal" || source2.id === "tracker-shm") && source2.status === "present");
  if (!tracker)
    return sidecars.length === 0 ? [] : [
      action("review", "compat.tracker.orphaned_sidecar", sidecars.map((source2) => source2.id), [], [], { retained_authority_present: false })
    ];
  return [
    action("attach", "compat.tracker.retained_authority", [tracker.id, ...sidecars.map((source2) => source2.id)], ["authority:tracker.db"], [], {
      category: "database",
      retained_authority: true,
      sidecar_count: sidecars.length
    })
  ];
}
function unsupportedStoreActions(sources) {
  const unsupportedSources = /* @__PURE__ */ new Set([
    "channels",
    "leases",
    "opencode-bridges",
    "codex-supervisors",
    "dashboard",
    "journals",
    "spool",
    "gates",
    "ideas",
    "roles",
    "renders",
    "substrate-lock"
  ]);
  return sources.filter((source2) => source2.status === "present" && unsupportedSources.has(source2.id)).map((source2) => action("review", `compat.${source2.id}.typed_importer_required`, [source2.id], [], [], {
    category: source2.category,
    typed_importer_available: false
  }));
}
function planLegacyMigration(read, options = {}) {
  const sources = [...read.sources].sort((left, right) => left.id.localeCompare(right.id));
  const findings = [...read.findings].sort((left, right) => `${left.source_id}\0${left.code}`.localeCompare(`${right.source_id}\0${right.code}`));
  const actions = [
    ...sourceActions(sources, findings),
    ...projectActions(read.documents.projects),
    ...sessionActions(read.documents.sessions, read.documents.facts),
    ...configActions(read.documents.config),
    ...trackerAuthorityActions(sources),
    ...unsupportedStoreActions(sources)
  ].sort((left, right) => left.id.localeCompare(right.id));
  const sourceManifestHash = hash(sources);
  const counts = actions.reduce((result2, current) => {
    result2[current.reason] = (result2[current.reason] ?? 0) + 1;
    return result2;
  }, {});
  const estimatedSourceBytes = sources.reduce((total, source2) => total + (source2.size_bytes ?? 0), 0);
  const plannerVersion = options.planner_version ?? auditPlannerVersion;
  const unsigned = {
    schema_version: "golem.compat-migration-plan/v1",
    planner_version: plannerVersion,
    mode: "dry_run",
    source_manifest_hash: sourceManifestHash,
    sources,
    findings,
    actions,
    counts_by_reason: counts,
    requirements: {
      backup: {
        required: true,
        artifacts: [
          "legacy-file-manifest",
          "tracker-db-backup",
          "runtime-db-backup"
        ],
        estimated_source_bytes: estimatedSourceBytes
      },
      disk: { minimum_free_bytes: estimatedSourceBytes * 2 },
      compatibility_window: "C0-C4",
      rollback_artifact: `rollback:${sourceManifestHash.slice(0, 24)}`
    }
  };
  const planHash2 = hash(unsigned);
  return {
    ...unsigned,
    plan_id: `migration-plan:${planHash2.slice(0, 24)}`,
    plan_hash: planHash2
  };
}
function stableAuditPlanJson(plan) {
  return stableJson(plan);
}

// packages/compat/dist/readers/safe-reader.js
import { createHash as createHash3 } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path7 from "node:path";
var knownSources = [
  {
    id: "projects",
    relative: "projects.json",
    category: "registry",
    parse_json: true
  },
  {
    id: "sessions",
    relative: "sessions.json",
    category: "registry",
    parse_json: true
  },
  {
    id: "facts",
    relative: "session-facts.json",
    category: "state",
    parse_json: true
  },
  {
    id: "leases",
    relative: "endpoint-leases.json",
    category: "state",
    parse_json: true
  },
  {
    id: "channels",
    relative: "channels.json",
    category: "state",
    parse_json: true
  },
  {
    id: "opencode-bridges",
    relative: "opencode-bridges.json",
    category: "state",
    parse_json: true
  },
  {
    id: "codex-supervisors",
    relative: "codex-supervisors.json",
    category: "state",
    parse_json: true
  },
  {
    id: "dashboard",
    relative: "dashboard.json",
    category: "state",
    parse_json: true
  },
  {
    id: "config",
    relative: "config.json",
    category: "config",
    parse_json: true
  },
  {
    id: "substrate-lock",
    relative: "substrate.lock",
    category: "render",
    parse_json: true
  },
  {
    id: "tracker",
    relative: "tracker.db",
    category: "database",
    sqlite_metadata: true
  },
  { id: "tracker-wal", relative: "tracker.db-wal", category: "database" },
  { id: "tracker-shm", relative: "tracker.db-shm", category: "database" },
  {
    id: "journals",
    relative: "journals",
    category: "history",
    recursive: true
  },
  { id: "spool", relative: "spool", category: "history", recursive: true },
  { id: "gates", relative: "gates", category: "history", recursive: true },
  { id: "ideas", relative: "ideas", category: "history", recursive: true },
  { id: "roles", relative: "roles", category: "history", recursive: true },
  { id: "renders", relative: "renders", category: "render", recursive: true }
];
var legacySourceRelativePaths = Object.freeze(knownSources.map(({ id, relative }) => Object.freeze({ id, relative })));
var maxJsonBytes = 1048576;
var maxInventoryEntries = 5e3;
function sha2562(value2) {
  return createHash3("sha256").update(value2).digest("hex");
}
function modeOf(mode) {
  return `0${(mode & 511).toString(8)}`;
}
function source(id, relative, category, status, properties = {}) {
  return {
    id,
    path: redactedHomePath(relative),
    category,
    status,
    ...properties
  };
}
function finding(code, severity, sourceId, relative) {
  return {
    code,
    severity,
    source_id: sourceId,
    path: redactedHomePath(relative)
  };
}
function relativeId(relative) {
  return redactedRelativePath(relative) || ".";
}
var AuditReaderError = class extends Error {
  code;
  constructor(code) {
    super(code);
    this.code = code;
  }
};
function sameObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.mode === right.mode;
}
function contained(root, candidate) {
  const relative = path7.relative(root, candidate);
  return relative === "" || !relative.startsWith(`..${path7.sep}`) && relative !== ".." && !path7.isAbsolute(relative);
}
async function assertContainedPath(home2, target) {
  if (!contained(home2, target))
    throw new AuditReaderError("AUDIT_PATH_ESCAPE");
  const relative = path7.relative(home2, target);
  let current = home2;
  for (const segment of relative.split(path7.sep).filter(Boolean)) {
    current = path7.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink())
      throw new AuditReaderError("AUDIT_PATH_SYMLINK");
  }
  const resolved = await realpath(target);
  if (!contained(home2, resolved))
    throw new AuditReaderError("AUDIT_PATH_ESCAPE");
}
function sqliteDetails(header, headerBytes) {
  const signature = new TextDecoder().decode(header.slice(0, 16));
  if (headerBytes < 100 || signature !== "SQLite format 3\0")
    return { format: "unrecognized" };
  const pageSize = (header[16] ?? 0) * 256 + (header[17] ?? 0);
  const schemaFormat = (header[44] ?? 0) << 24 | (header[45] ?? 0) << 16 | (header[46] ?? 0) << 8 | (header[47] ?? 0);
  const userVersion = (header[60] ?? 0) << 24 | (header[61] ?? 0) << 16 | (header[62] ?? 0) << 8 | (header[63] ?? 0);
  return {
    format: "sqlite",
    page_size: pageSize === 1 ? 65536 : pageSize,
    schema_format: schemaFormat >>> 0,
    user_version: userVersion >>> 0
  };
}
async function snapshotRegularFile(input) {
  await assertContainedPath(input.home, input.target);
  const handle = await open(input.target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile())
      throw new Error("audit.reader.not_regular");
    const digest5 = createHash3("sha256");
    const chunks = [];
    const header = new Uint8Array(100);
    let headerBytes = 0;
    let size = 0;
    const buffer = new Uint8Array(65536);
    for (; ; ) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0)
        break;
      const chunk = buffer.slice(0, bytesRead);
      digest5.update(chunk);
      if (input.readSqliteHeader && headerBytes < header.length) {
        const count = Math.min(header.length - headerBytes, chunk.length);
        header.set(chunk.subarray(0, count), headerBytes);
        headerBytes += count;
      }
      size += chunk.length;
      if (input.captureBytes && size <= maxJsonBytes)
        chunks.push(chunk);
      else
        chunks.length = 0;
    }
    const after = await handle.stat();
    let pathMatches = false;
    try {
      await assertContainedPath(input.home, input.target);
      pathMatches = sameObject(before, await lstat(input.target));
    } catch (error) {
      if (error instanceof AuditReaderError)
        throw error;
      pathMatches = false;
    }
    const changed = !sameObject(input.expected, before) || !sameObject(before, after) || !pathMatches;
    const fingerprint = digest5.digest("hex");
    if (changed)
      return Object.freeze({ stat: before, fingerprint, changed: true });
    let bytes;
    if (input.captureBytes && size <= maxJsonBytes) {
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
    }
    return Object.freeze({
      stat: before,
      fingerprint,
      ...bytes ? { bytes } : {},
      ...input.readSqliteHeader ? { sqlite_details: sqliteDetails(header, headerBytes) } : {},
      changed: false
    });
  } finally {
    await handle.close();
  }
}
function errnoCode(error) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : void 0;
}
function asRecord(value2) {
  return value2 !== null && typeof value2 === "object" && !Array.isArray(value2) ? value2 : void 0;
}
function sourceStatusFor(error) {
  const code = errnoCode(error);
  return code === "ELOOP" || code === "AUDIT_PATH_ESCAPE" || code === "AUDIT_PATH_SYMLINK" ? "unsafe" : code === "EACCES" || code === "EPERM" ? "unreadable" : "malformed";
}
function sourceFindingFor(error, content) {
  const code = errnoCode(error);
  if (code === "AUDIT_PATH_ESCAPE")
    return "audit.source.path_escape";
  if (code === "ELOOP" || code === "AUDIT_PATH_SYMLINK")
    return "audit.source.symlink";
  if (code === "EACCES" || code === "EPERM")
    return "audit.source.unreadable";
  return content && !content.bytes ? "audit.source.too_large" : "audit.source.malformed";
}
async function inspectFile(home2, definition, sources, documents, findings) {
  const target = path7.join(home2, definition.relative);
  let initial;
  try {
    initial = await lstat(target);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      sources.push(source(definition.id, definition.relative, definition.category, "missing"));
      return;
    }
    sources.push(source(definition.id, definition.relative, definition.category, "unreadable"));
    findings.push(finding("audit.source.unreadable", "error", definition.id, definition.relative));
    return;
  }
  if (initial.isSymbolicLink()) {
    sources.push(source(definition.id, definition.relative, definition.category, "unsafe", { fingerprint: sha2562("symlink") }));
    findings.push(finding("audit.source.symlink", "error", definition.id, definition.relative));
    return;
  }
  if (!initial.isFile()) {
    sources.push(source(definition.id, definition.relative, definition.category, "unsafe"));
    findings.push(finding("audit.source.not_regular", "error", definition.id, definition.relative));
    return;
  }
  let snapshot;
  try {
    snapshot = await snapshotRegularFile({
      home: home2,
      target,
      expected: initial,
      captureBytes: definition.parse_json === true,
      readSqliteHeader: definition.sqlite_metadata === true
    });
  } catch (error) {
    const status = sourceStatusFor(error);
    sources.push(source(definition.id, definition.relative, definition.category, status));
    findings.push(finding(sourceFindingFor(error), "error", definition.id, definition.relative));
    return;
  }
  if (snapshot.changed) {
    sources.push(source(definition.id, definition.relative, definition.category, "changed"));
    findings.push(finding("audit.source.changed_during_audit", "error", definition.id, definition.relative));
    return;
  }
  const metadata = {
    fingerprint: snapshot.fingerprint,
    size_bytes: snapshot.stat.size,
    mode: modeOf(snapshot.stat.mode),
    ...snapshot.sqlite_details ? { details: snapshot.sqlite_details } : {}
  };
  if (!definition.parse_json) {
    sources.push(source(definition.id, definition.relative, definition.category, "present", metadata));
    return;
  }
  try {
    if (!snapshot.bytes)
      throw new Error("audit.reader.too_large");
    const parsed = asRecord(JSON.parse(new TextDecoder().decode(snapshot.bytes)));
    if (!parsed)
      throw new Error("audit.reader.json_object_required");
    sources.push(source(definition.id, definition.relative, definition.category, "present", metadata));
    documents[definition.id] = parsed;
  } catch (error) {
    sources.push(source(definition.id, definition.relative, definition.category, "malformed", metadata));
    findings.push(finding(sourceFindingFor(error, snapshot), "error", definition.id, definition.relative));
  }
}
function recordInventoryLimit(budget, definition, findings) {
  budget.halted = true;
  if (budget.limitReported)
    return;
  budget.limitReported = true;
  findings.push(finding("audit.source.entry_limit", "error", definition.id, definition.relative));
}
async function inspectDirectory(home2, definition, sources, findings, budget) {
  if (budget.halted)
    return;
  const target = path7.join(home2, definition.relative);
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      sources.push(source(definition.id, definition.relative, definition.category, "missing"));
      return;
    }
    sources.push(source(definition.id, definition.relative, definition.category, "unreadable"));
    findings.push(finding("audit.source.unreadable", "error", definition.id, definition.relative));
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    sources.push(source(definition.id, definition.relative, definition.category, "unsafe"));
    findings.push(finding(stat.isSymbolicLink() ? "audit.source.symlink" : "audit.source.not_directory", "error", definition.id, definition.relative));
    return;
  }
  try {
    await assertContainedPath(home2, target);
  } catch (error) {
    sources.push(source(definition.id, definition.relative, definition.category, sourceStatusFor(error)));
    findings.push(finding(sourceFindingFor(error), "error", definition.id, definition.relative));
    return;
  }
  const rootSourceIndex = sources.length;
  sources.push(source(definition.id, definition.relative, definition.category, "present", {
    mode: modeOf(stat.mode)
  }));
  const scan = async (absolute, relative) => {
    if (budget.halted)
      return true;
    try {
      await assertContainedPath(home2, absolute);
      const entries = await readdir(absolute, { withFileTypes: true });
      await assertContainedPath(home2, absolute);
      for (const entry2 of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (budget.halted)
          return true;
        if (budget.entries >= maxInventoryEntries) {
          recordInventoryLimit(budget, definition, findings);
          return true;
        }
        budget.entries += 1;
        const nestedRelative = path7.join(relative, entry2.name);
        const childRelative = path7.join(definition.relative, nestedRelative);
        const childId = `${definition.id}/${relativeId(nestedRelative)}`;
        const childAbsolute = path7.join(absolute, entry2.name);
        if (entry2.isSymbolicLink()) {
          sources.push(source(childId, childRelative, definition.category, "unsafe", {
            fingerprint: sha2562("symlink")
          }));
          findings.push(finding("audit.source.symlink", "error", childId, childRelative));
          continue;
        }
        if (entry2.isDirectory()) {
          if (!await scan(childAbsolute, nestedRelative))
            return false;
          continue;
        }
        let initial;
        try {
          initial = await lstat(childAbsolute);
        } catch (error) {
          sources.push(source(childId, childRelative, definition.category, sourceStatusFor(error)));
          findings.push(finding(sourceFindingFor(error), "error", childId, childRelative));
          continue;
        }
        if (initial.isSymbolicLink()) {
          sources.push(source(childId, childRelative, definition.category, "unsafe", {
            fingerprint: sha2562("symlink")
          }));
          findings.push(finding("audit.source.symlink", "error", childId, childRelative));
          continue;
        }
        if (!initial.isFile()) {
          sources.push(source(childId, childRelative, definition.category, "unsafe"));
          findings.push(finding("audit.source.not_regular", "error", childId, childRelative));
          continue;
        }
        try {
          const snapshot = await snapshotRegularFile({
            home: home2,
            target: childAbsolute,
            expected: initial,
            captureBytes: false,
            readSqliteHeader: false
          });
          if (snapshot.changed) {
            sources.push(source(childId, childRelative, definition.category, "changed"));
            findings.push(finding("audit.source.changed_during_audit", "error", childId, childRelative));
            continue;
          }
          sources.push(source(childId, childRelative, definition.category, "present", {
            fingerprint: snapshot.fingerprint,
            size_bytes: snapshot.stat.size,
            mode: modeOf(snapshot.stat.mode)
          }));
        } catch (error) {
          sources.push(source(childId, childRelative, definition.category, sourceStatusFor(error)));
          findings.push(finding(sourceFindingFor(error), "error", childId, childRelative));
          if (error instanceof AuditReaderError)
            return false;
        }
      }
      return true;
    } catch (error) {
      findings.push(finding(sourceFindingFor(error), "error", definition.id, path7.join(definition.relative, relative)));
      return false;
    }
  };
  if (!await scan(target, "")) {
    sources[rootSourceIndex] = source(definition.id, definition.relative, definition.category, "unsafe", { mode: modeOf(stat.mode) });
  }
}
async function readLegacyHome(homeInput) {
  let home2 = path7.resolve(homeInput);
  const sources = [];
  const documents = {};
  const findings = [];
  try {
    const root = await lstat(home2);
    if (root.isSymbolicLink() || !root.isDirectory()) {
      sources.push(source("home", ".", "state", "unsafe"));
      findings.push(finding(root.isSymbolicLink() ? "audit.home.symlink" : "audit.home.not_directory", "error", "home", "."));
      return { sources, documents, findings };
    }
    home2 = await realpath(home2);
  } catch (error) {
    sources.push(source("home", ".", "state", errnoCode(error) === "ENOENT" ? "missing" : "unreadable"));
    findings.push(finding("audit.home.unavailable", "error", "home", "."));
    return { sources, documents, findings };
  }
  const budget = {
    entries: 0,
    halted: false,
    limitReported: false
  };
  for (const definition of knownSources) {
    if (definition.recursive)
      await inspectDirectory(home2, definition, sources, findings, budget);
    else
      await inspectFile(home2, definition, sources, documents, findings);
  }
  return { sources, documents, findings };
}

// packages/compat/dist/audit/audit.js
async function auditLegacyHome(home2, options = {}) {
  return planLegacyMigration(await readLegacyHome(home2), options);
}
function formatAuditPlanText(plan) {
  const counts = Object.entries(plan.counts_by_reason).sort(([left], [right]) => left.localeCompare(right)).map(([reason, count]) => `  ${reason}: ${count}`).join("\n");
  return `${[
    "golem migration audit (dry-run)",
    `plan: ${plan.plan_id}`,
    `hash: ${plan.plan_hash}`,
    `source manifest: ${plan.source_manifest_hash}`,
    `actions: ${plan.actions.length}; findings: ${plan.findings.length}`,
    `backup: ${plan.requirements.backup.estimated_source_bytes} source bytes; minimum free: ${plan.requirements.disk.minimum_free_bytes}`,
    counts ? `reasons:
${counts}` : "reasons: none",
    "No source files, databases, render targets, or configuration were modified.",
    "To apply: golem migrate apply --home <GOLEM_HOME> --plan-hash <hash>. Apply re-audits this exact hash and never makes legacy sources writers."
  ].join("\n")}
`;
}

// packages/compat/dist/apply/types.js
var MigrationApplyError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "MigrationApplyError";
    this.code = code;
  }
};

// packages/compat/dist/apply/service.js
var statusFilename = "migration-status.json";
var canonicalDirectoryName = "canonical";
var compatibilityDirectoryName = "compatibility";
var migrationLockFilename = ".migration-apply.lock";
function now(options) {
  return options.now?.() ?? (/* @__PURE__ */ new Date()).toISOString();
}
function digest3(value2) {
  return createHash4("sha256").update(value2).digest("hex");
}
function stableOpaqueId(prefix, seed) {
  const hex = digest3(seed);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return `${prefix}_${uuid}`;
}
function value(record, key) {
  const candidate = record[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : void 0;
}
function records2(document, key) {
  const candidate = document?.[key];
  return Array.isArray(candidate) ? candidate.filter((entry2) => Boolean(entry2) && typeof entry2 === "object" && !Array.isArray(entry2)) : [];
}
function isHarness(value2) {
  return value2 === "claude" || value2 === "codex" || value2 === "opencode" || value2 === "pi";
}
function pathIsSafe2(candidate) {
  return path8.isAbsolute(candidate) && !candidate.includes("\0") && !candidate.split(path8.sep).includes("..");
}
function worktreeRoot2(candidate) {
  const normalized = candidate.replaceAll("\\", "/");
  const match = normalized.match(/^(.*)\/\.worktrees\/[^/]+(?:\/.*)?$/u);
  return match?.[1] ?? normalized;
}
function projectId2(rawId, planHash2) {
  return /^prj_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(rawId) ? rawId : stableOpaqueId("prj", `${planHash2}\0project\0${rawId}`);
}
function atomicJson(target, body) {
  fs8.mkdirSync(path8.dirname(target), { recursive: true, mode: 448 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs8.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}
`, {
    encoding: "utf8",
    mode: 384
  });
  fs8.renameSync(temporary, target);
}
function statusPath(home2) {
  return path8.join(home2, statusFilename);
}
function backupDirectoryFor(home2, planHash2) {
  return path8.join(home2, "migration-backups", planHash2.slice(0, 24));
}
function publicBackupDirectory(planHash2) {
  return redactedHomePath(`migration-backups/${planHash2.slice(0, 24)}`);
}
function publicProjectionPath() {
  return redactedHomePath(`${compatibilityDirectoryName}/legacy-projection.json`);
}
function publicRollbackCommand() {
  return "golem migrate rollback --home $GOLEM_HOME";
}
function publicStatus(status) {
  return Object.freeze({
    ...status,
    backup_directory: publicBackupDirectory(status.plan_hash),
    rollback_command: publicRollbackCommand(),
    compatibility_projection: publicProjectionPath()
  });
}
function readStatus(home2) {
  try {
    const candidate = JSON.parse(fs8.readFileSync(statusPath(home2), "utf8"));
    if (!candidate || typeof candidate !== "object")
      return void 0;
    const record = candidate;
    return record.schema_version === "golem.compat-migration-status/v1" && typeof record.plan_hash === "string" && typeof record.plan_id === "string" && (record.status === "applied" || record.status === "rolled_back" || record.status === "failed") ? publicStatus(candidate) : void 0;
  } catch {
    return void 0;
  }
}
function acquireLock(home2) {
  const lockPath = path8.join(home2, migrationLockFilename);
  try {
    fs8.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, acquired_at: (/* @__PURE__ */ new Date()).toISOString() })}
`, {
      encoding: "utf8",
      flag: "wx",
      mode: 384
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")
      throw new MigrationApplyError("migration.locked", "another migration apply owns this home");
    throw error;
  }
  return () => {
    try {
      fs8.rmSync(lockPath, { force: true });
    } catch {
    }
  };
}
function ensureFreeSpace(home2, required) {
  try {
    const stat = fs8.statfsSync(home2);
    const available = Number(stat.bavail) * Number(stat.bsize);
    if (!Number.isSafeInteger(available) || available < required)
      throw new MigrationApplyError("migration.disk_insufficient", "migration requires more free space before creating backups");
  } catch (error) {
    if (error instanceof MigrationApplyError)
      throw error;
    throw new MigrationApplyError("migration.disk_insufficient", "migration could not verify free space before creating backups");
  }
}
function copyIfPresent(source2, target) {
  if (!fs8.existsSync(source2))
    return;
  fs8.mkdirSync(path8.dirname(target), { recursive: true, mode: 448 });
  fs8.cpSync(source2, target, {
    dereference: false,
    preserveTimestamps: true,
    recursive: true
  });
}
function backupSources(home2, planHash2) {
  const directory = backupDirectoryFor(home2, planHash2);
  try {
    if (fs8.existsSync(directory))
      throw new Error("backup directory already exists for this plan");
    fs8.mkdirSync(directory, { recursive: true, mode: 448 });
    for (const source2 of legacySourceRelativePaths)
      copyIfPresent(path8.join(home2, source2.relative), path8.join(directory, "legacy", source2.relative));
    const canonical2 = path8.join(home2, canonicalDirectoryName);
    if (fs8.existsSync(canonical2))
      copyIfPresent(canonical2, path8.join(directory, "canonical-before"));
    atomicJson(path8.join(directory, "manifest.json"), {
      schema_version: "golem.compat-migration-backup/v1",
      plan_hash: planHash2,
      canonical_before_present: fs8.existsSync(canonical2),
      sources: legacySourceRelativePaths.map((source2) => source2.id)
    });
    return directory;
  } catch (error) {
    throw new MigrationApplyError("migration.backup_failed", error instanceof Error ? `backup failed: ${redactDiagnosticText(error.message)}` : "backup failed");
  }
}
function restoreCanonical(home2, backupDirectory) {
  const canonical2 = path8.join(home2, canonicalDirectoryName);
  fs8.rmSync(canonical2, { recursive: true, force: true });
  const previous = path8.join(backupDirectory, "canonical-before");
  if (fs8.existsSync(previous))
    fs8.cpSync(previous, canonical2, { dereference: false, recursive: true });
  fs8.rmSync(path8.join(home2, compatibilityDirectoryName), {
    recursive: true,
    force: true
  });
}
function importableProjects(read, planHash2) {
  const groups = /* @__PURE__ */ new Map();
  for (const row of records2(read.documents.projects, "projects")) {
    const id = value(row, "id");
    const location2 = value(row, "path");
    if (!id || !location2 || !pathIsSafe2(location2))
      continue;
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }
  return [...groups.entries()].flatMap(([rawId, group]) => {
    const paths = [
      ...new Set(group.map((row) => value(row, "path")).filter((entry2) => Boolean(entry2)))
    ].sort();
    const roots = new Set(paths.map(worktreeRoot2));
    const strongId = /^prj_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(rawId);
    if (paths.length === 0 || roots.size > 1 && !strongId)
      return [];
    return [
      {
        rawId,
        canonicalId: projectId2(rawId, planHash2),
        name: value(group[0] ?? {}, "name") ?? rawId,
        paths
      }
    ];
  });
}
function importableSessions(read, projects) {
  const candidates = [];
  for (const row of records2(read.documents.sessions, "sessions")) {
    const rawId = value(row, "session_id");
    const legacyProject = value(row, "project_id");
    const harness = value(row, "harness");
    const projectIdValue = legacyProject ? projects.get(legacyProject) : void 0;
    if (rawId && projectIdValue && isHarness(harness))
      candidates.push({
        rawId,
        projectId: projectIdValue,
        harness,
        terminal: false,
        observedAt: "2000-01-01T00:00:00.000Z"
      });
  }
  for (const row of records2(read.documents.facts, "facts")) {
    const rawId = value(row, "canonical_id");
    const legacyProject = value(row, "project_id");
    const harness = value(row, "harness");
    const projectIdValue = legacyProject ? projects.get(legacyProject) : void 0;
    if (rawId && projectIdValue && isHarness(harness)) {
      const endedAt = value(row, "ended_at");
      candidates.push({
        rawId,
        projectId: projectIdValue,
        harness,
        terminal: value(row, "status") === "ended" || Boolean(endedAt),
        observedAt: endedAt && !Number.isNaN(Date.parse(endedAt)) ? endedAt : "2000-01-01T00:00:00.000Z"
      });
    }
  }
  const scopes = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    const entries = scopes.get(candidate.rawId) ?? /* @__PURE__ */ new Set();
    entries.add(`${candidate.projectId}\0${candidate.harness}`);
    scopes.set(candidate.rawId, entries);
  }
  const byScope = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    if ((scopes.get(candidate.rawId)?.size ?? 0) !== 1)
      continue;
    const key = `${candidate.rawId}\0${candidate.projectId}\0${candidate.harness}`;
    const previous = byScope.get(key);
    if (!previous || candidate.terminal || candidate.observedAt > previous.observedAt)
      byScope.set(key, candidate);
  }
  return [...byScope.values()].sort((left, right) => `${left.projectId}\0${left.rawId}`.localeCompare(`${right.projectId}\0${right.rawId}`));
}
function signal(input) {
  const producer2 = stableOpaqueId("prod", `${input.planHash}\0producer`);
  return RuntimeSignalV1Schema.parse({
    schema_version: "golem.runtime-signal/v1",
    event_id: stableOpaqueId("evt", `${input.planHash}\0${input.event}`),
    event_kind: input.eventKind,
    producer: "legacy-migration",
    producer_instance_id: producer2,
    harness: input.harness,
    correlation_id: `migration:${input.planHash.slice(0, 24)}`,
    deduplication_key: `migration:${input.planHash.slice(0, 40)}:${input.event}`,
    clocks: {
      source_observed_at: input.observedAt,
      received_at: input.observedAt
    },
    provenance: {
      source: "legacy_import",
      confidence: "legacy",
      evidence_id: input.planHash.slice(0, 64)
    },
    clear_fields: [],
    payload: input.payload
  });
}
function writeCompatibilityProjection(input) {
  const target = path8.join(input.home, compatibilityDirectoryName, "legacy-projection.json");
  const projects = input.projections.projects().map((project2) => ({
    id: project2.projectId,
    name: project2.name,
    path: project2.locations[0] ? redactedDisplayPath(project2.locations[0].canonicalPath) : null
  }));
  const sessions = input.projections.sessions().map((session2) => ({
    session_id: session2.sessionId,
    project_id: session2.projectId,
    generation_count: session2.generations.length
  }));
  atomicJson(target, {
    schema_version: "golem.compatibility-projection/v1",
    generated: true,
    canonical_revision: input.projections.revision(),
    plan_hash: input.planHash,
    projects,
    sessions
  });
  return publicProjectionPath();
}
function assertApplyable(plan, expected) {
  if (!expected.trim())
    throw new MigrationApplyError("migration.plan_hash_required", "an explicit dry-run plan hash is required");
  if (plan.plan_hash !== expected)
    throw new MigrationApplyError("migration.plan_hash_mismatch", "the supplied plan hash does not match this dry-run plan");
  if (plan.actions.some((action2) => action2.kind === "review" || action2.kind === "quarantine"))
    throw new MigrationApplyError("migration.review_required", "unresolved review or quarantine actions must be decided before apply");
}
async function migrationStatus(home2) {
  return readStatus(home2);
}
async function applyLegacyMigration(options) {
  const approvedPlan = await auditLegacyHome(options.home);
  assertApplyable(approvedPlan, options.expected_plan_hash);
  const release = acquireLock(options.home);
  let backupDirectory;
  try {
    const plan = await auditLegacyHome(options.home);
    if (plan.plan_hash !== approvedPlan.plan_hash)
      throw new MigrationApplyError("migration.source_changed", "legacy source changed before migration acquired its apply lock");
    const rechecked = await auditLegacyHome(options.home);
    if (rechecked.plan_hash !== plan.plan_hash)
      throw new MigrationApplyError("migration.source_changed", "legacy source changed while migration was reading its import snapshot");
    ensureFreeSpace(options.home, plan.requirements.disk.minimum_free_bytes);
    backupDirectory = backupSources(options.home, plan.plan_hash);
    const snapshotHome = path8.join(backupDirectory, "legacy");
    const snapshotPlan = await auditLegacyHome(snapshotHome);
    if (snapshotPlan.source_manifest_hash !== plan.source_manifest_hash)
      throw new MigrationApplyError("migration.source_changed", "backup snapshot no longer matches the approved source fingerprint");
    const snapshot = await readLegacyHome(snapshotHome);
    const canonical2 = path8.join(options.home, canonicalDirectoryName);
    const target = openLegacyMigrationPersistence({
      runtimePath: path8.join(canonical2, "runtime.db"),
      trackerPath: path8.join(canonical2, "tracker.db"),
      lockPath: path8.join(canonical2, "migration.owner.lock")
    });
    try {
      const projectRows = importableProjects(snapshot, plan.plan_hash);
      const projectMappings = new Map(projectRows.map((entry2) => [entry2.rawId, entry2.canonicalId]));
      for (const project2 of projectRows) {
        for (const legacyPath of project2.paths) {
          const locationId = stableOpaqueId("loc", `${plan.plan_hash}\0${project2.rawId}\0${legacyPath}`);
          const result2 = target.projects.observe({
            projectId: project2.canonicalId,
            name: project2.name,
            location: {
              locationId,
              canonicalPath: legacyPath,
              relation: legacyPath.includes("/.worktrees/") ? "worktree" : "legacy",
              source: "legacy_import",
              evidence: {
                source_manifest_hash: plan.source_manifest_hash,
                legacy_project_id: project2.rawId
              },
              observedAt: now(options)
            },
            identityKey: `legacy:migration:${project2.rawId}`,
            metadata: { migration_plan_hash: plan.plan_hash },
            source: "legacy_import",
            eventId: stableOpaqueId("evt", `${plan.plan_hash}\0project\0${project2.rawId}\0${legacyPath}`),
            deduplicationKey: `migration:${plan.plan_hash}:project:${digest3(`${project2.rawId}\0${legacyPath}`).slice(0, 24)}`,
            payload: {
              kind: "project.observed",
              legacy_project_id: project2.rawId
            },
            provenance: {
              source: "legacy_import",
              confidence: "legacy",
              source_manifest_hash: plan.source_manifest_hash
            },
            occurredAt: now(options)
          });
          if (result2.disposition !== "accepted" && result2.disposition !== "duplicate")
            throw new MigrationApplyError("migration.import_rejected", "canonical project import rejected");
        }
      }
      const sessions = createSessionService({
        projects: target.projects,
        sessions: target.sessions
      });
      const sessionRows = importableSessions(snapshot, projectMappings);
      for (const row of sessionRows) {
        const canonicalSessionId = stableOpaqueId("ses", `${plan.plan_hash}\0${row.projectId}\0${row.harness}\0${row.rawId}`);
        const generationId = stableOpaqueId("gen", `${plan.plan_hash}\0${row.projectId}\0${row.harness}\0${row.rawId}\0first`);
        const started = sessions.apply(signal({
          planHash: plan.plan_hash,
          event: `session-start:${row.projectId}:${row.harness}:${row.rawId}`,
          eventKind: "session.started",
          harness: row.harness,
          observedAt: row.observedAt,
          payload: {
            kind: "session.started",
            generation: {
              project_id: row.projectId,
              session_id: canonicalSessionId,
              generation_id: generationId
            },
            metadata: { migration_plan_hash: plan.plan_hash }
          }
        }), {
          projectId: row.projectId,
          harness: row.harness,
          aliasKind: "migration_relation",
          alias: row.rawId,
          sessionId: canonicalSessionId,
          generationId,
          source: "legacy_import",
          provenance: {
            source_manifest_hash: plan.source_manifest_hash,
            plan_hash: plan.plan_hash
          }
        });
        if (started.disposition !== "accepted" && started.disposition !== "duplicate")
          throw new MigrationApplyError("migration.import_rejected", `canonical session import rejected: ${started.code}`);
        if (row.terminal) {
          const ended = sessions.apply(signal({
            planHash: plan.plan_hash,
            event: `session-end:${row.projectId}:${row.harness}:${row.rawId}`,
            eventKind: "session.ended",
            harness: row.harness,
            observedAt: row.observedAt,
            payload: {
              kind: "session.ended",
              generation: {
                project_id: row.projectId,
                session_id: canonicalSessionId,
                generation_id: generationId
              },
              disposition: "ended"
            }
          }));
          if (ended.disposition !== "accepted" && ended.disposition !== "duplicate")
            throw new MigrationApplyError("migration.import_rejected", `canonical terminal import rejected: ${ended.code}`);
        }
      }
      if (options.failpoint === "before_commit")
        throw new Error("migration failpoint before_commit");
      const finalPlan = await auditLegacyHome(options.home);
      if (finalPlan.source_manifest_hash !== plan.source_manifest_hash)
        throw new MigrationApplyError("migration.source_changed", "legacy source changed while migration was importing its snapshot");
      const projection = writeCompatibilityProjection({
        home: options.home,
        planHash: plan.plan_hash,
        projections: target.projections
      });
      if (options.failpoint === "after_projection")
        throw new Error("migration failpoint after_projection");
      const status = Object.freeze({
        schema_version: "golem.compat-migration-status/v1",
        status: "applied",
        plan_id: plan.plan_id,
        plan_hash: plan.plan_hash,
        source_manifest_hash: plan.source_manifest_hash,
        applied_at: now(options),
        backup_directory: publicBackupDirectory(plan.plan_hash),
        rollback_command: publicRollbackCommand(),
        compatibility_projection: projection,
        compatibility_mode: "read_only_generated",
        imported: {
          projects: projectRows.length,
          sessions: sessionRows.length,
          generations: sessionRows.length,
          aliases: sessionRows.length
        },
        source_bytes: plan.requirements.backup.estimated_source_bytes
      });
      atomicJson(statusPath(options.home), status);
      return { plan, status };
    } finally {
      await target.close();
    }
  } catch (error) {
    if (backupDirectory) {
      try {
        restoreCanonical(options.home, backupDirectory);
      } catch {
      }
    }
    if (error instanceof MigrationApplyError)
      throw error;
    throw new MigrationApplyError("migration.import_rejected", error instanceof Error ? redactDiagnosticText(error.message) : "migration apply failed");
  } finally {
    release();
  }
}
async function rollbackLegacyMigration(home2) {
  const current = readStatus(home2);
  if (current?.status !== "applied")
    throw new MigrationApplyError("migration.not_applied", "no applied migration is available to roll back");
  const release = acquireLock(home2);
  try {
    restoreCanonical(home2, backupDirectoryFor(home2, current.plan_hash));
    const rolledBack = Object.freeze({
      ...current,
      status: "rolled_back",
      applied_at: (/* @__PURE__ */ new Date()).toISOString()
    });
    atomicJson(statusPath(home2), rolledBack);
    return rolledBack;
  } finally {
    release();
  }
}

// packages/compat/dist/cutover/service.js
import crypto10 from "node:crypto";
import fs10 from "node:fs";
import path10 from "node:path";
import { fileURLToPath } from "node:url";

// packages/persistence/dist/authority.js
import crypto9 from "node:crypto";
import fs9 from "node:fs";
import path9 from "node:path";
var controlPlaneAuthoritySchemaVersion = "golem.control-plane-authority/v1";
function validTimestamp2(value2) {
  return typeof value2 === "string" && Number.isFinite(Date.parse(value2));
}
function validHash(value2) {
  return typeof value2 === "string" && /^[a-f0-9]{64}$/u.test(value2);
}
function validAuthority(value2) {
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2))
    return false;
  const candidate = value2;
  if (candidate.schema_version !== controlPlaneAuthoritySchemaVersion || candidate.stage !== "C3" && candidate.stage !== "C4" || candidate.write_policy !== "legacy_open" && candidate.write_policy !== "quiesced" && candidate.write_policy !== "canonical_only" || !Number.isInteger(candidate.revision) || Number(candidate.revision) < 0 || !validTimestamp2(candidate.updated_at))
    return false;
  if (candidate.stage === "C3" && candidate.write_policy === "canonical_only" || candidate.stage === "C4" && candidate.write_policy !== "canonical_only")
    return false;
  if (candidate.plan_hash !== void 0 && !validHash(candidate.plan_hash))
    return false;
  if (candidate.canonical_revision !== void 0 && (!Number.isInteger(candidate.canonical_revision) || Number(candidate.canonical_revision) < 0))
    return false;
  if (candidate.rollback_audit !== void 0 && (typeof candidate.rollback_audit !== "string" || candidate.rollback_audit.length === 0 || path9.isAbsolute(candidate.rollback_audit) || candidate.rollback_audit.split(path9.sep).includes("..")))
    return false;
  return true;
}
function controlPlaneAuthorityPath(home2) {
  return path9.join(path9.resolve(home2), "control-plane", "authority.json");
}
function defaultControlPlaneAuthority() {
  return Object.freeze({
    schema_version: controlPlaneAuthoritySchemaVersion,
    stage: "C3",
    write_policy: "legacy_open",
    revision: 0,
    updated_at: "1970-01-01T00:00:00.000Z"
  });
}
function readControlPlaneAuthority(home2) {
  const target = controlPlaneAuthorityPath(home2);
  try {
    const parsed = JSON.parse(fs9.readFileSync(target, "utf8"));
    if (!validAuthority(parsed))
      throw new Error("control-plane authority pointer is invalid");
    return Object.freeze({ ...parsed });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return defaultControlPlaneAuthority();
    throw error;
  }
}
function writeControlPlaneAuthority(home2, update) {
  const current = readControlPlaneAuthority(home2);
  const next = Object.freeze({
    schema_version: controlPlaneAuthoritySchemaVersion,
    stage: update.stage,
    write_policy: update.write_policy,
    revision: current.revision + 1,
    updated_at: update.updated_at ?? (/* @__PURE__ */ new Date()).toISOString(),
    ...update.plan_hash ? { plan_hash: update.plan_hash } : {},
    ...update.canonical_revision === void 0 ? {} : { canonical_revision: update.canonical_revision },
    ...update.rollback_audit ? { rollback_audit: update.rollback_audit } : {}
  });
  if (!validAuthority(next))
    throw new Error("control-plane authority update is invalid");
  const target = controlPlaneAuthorityPath(home2);
  fs9.mkdirSync(path9.dirname(target), { recursive: true, mode: 448 });
  const temporary = path9.join(path9.dirname(target), `.authority.${process.pid}.${crypto9.randomUUID()}.tmp`);
  try {
    fs9.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}
`, {
      encoding: "utf8",
      mode: 384,
      flag: "wx"
    });
    fs9.renameSync(temporary, target);
  } finally {
    fs9.rmSync(temporary, { force: true });
  }
  return next;
}

// packages/persistence/dist/tracker-core-capability.js
import Database4 from "better-sqlite3";
import { Kysely as Kysely2, SqliteDialect as SqliteDialect2 } from "kysely";

// packages/persistence/dist/index.js
var persistenceMigrations = Object.freeze({
  runtime: runtimeMigrations.map(({ id, checksum }) => ({ id, checksum })),
  tracker: trackerMigrations.map(({ id, checksum }) => ({ id, checksum }))
});

// packages/compat/dist/cutover/types.js
var CanonicalCutoverError = class extends Error {
  code;
  gates;
  constructor(code, message, gates) {
    super(message);
    this.name = "CanonicalCutoverError";
    this.code = code;
    this.gates = gates;
  }
};

// packages/compat/dist/cutover/service.js
var stateFilename = "cutover-state.json";
var lockFilename = ".cutover.lock";
function now2(options) {
  return options.now?.() ?? (/* @__PURE__ */ new Date()).toISOString();
}
function canonical(value2) {
  if (Array.isArray(value2))
    return value2.map(canonical);
  if (value2 && typeof value2 === "object")
    return Object.fromEntries(Object.entries(value2).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
  return value2;
}
function digest4(value2) {
  const bytes = typeof value2 === "string" || value2 instanceof Uint8Array ? value2 : JSON.stringify(canonical(value2));
  return crypto10.createHash("sha256").update(bytes).digest("hex");
}
function fileDigest(target) {
  const hash2 = crypto10.createHash("sha256");
  const descriptor = fs10.openSync(target, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (; ; ) {
      const count = fs10.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0)
        break;
      hash2.update(buffer.subarray(0, count));
    }
    return hash2.digest("hex");
  } finally {
    fs10.closeSync(descriptor);
  }
}
function defaultServiceBinaryPath() {
  const candidate = path10.resolve(path10.dirname(fileURLToPath(import.meta.url)), "../../../../apps/control-plane/dist/main.js");
  return fs10.existsSync(candidate) ? candidate : process.execPath;
}
function atomicJson2(target, body, mode = 384) {
  fs10.mkdirSync(path10.dirname(target), { recursive: true, mode: 448 });
  const temporary = path10.join(path10.dirname(target), `.${path10.basename(target)}.${process.pid}.${crypto10.randomUUID()}.tmp`);
  try {
    fs10.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}
`, {
      encoding: "utf8",
      mode,
      flag: "wx"
    });
    fs10.renameSync(temporary, target);
  } finally {
    fs10.rmSync(temporary, { force: true });
  }
}
function statePath(home2) {
  return path10.join(home2, "control-plane", stateFilename);
}
function readJson(target) {
  try {
    return JSON.parse(fs10.readFileSync(target, "utf8"));
  } catch {
    return void 0;
  }
}
function readProjection(home2) {
  const value2 = readJson(path10.join(home2, "compatibility", "legacy-projection.json"));
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2))
    return void 0;
  const candidate = value2;
  return candidate.schema_version === "golem.compatibility-projection/v1" && Number.isInteger(candidate.canonical_revision) && Array.isArray(candidate.projects) && Array.isArray(candidate.sessions) ? value2 : void 0;
}
function validState(value2) {
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2))
    return false;
  const candidate = value2;
  return candidate.schema_version === "golem.canonical-cutover-state/v1" && typeof candidate.plan_hash === "string" && /^[a-f0-9]{64}$/u.test(candidate.plan_hash) && [
    "quiesced",
    "checkpointed",
    "soaking",
    "stable",
    "rollback_required",
    "rolled_back"
  ].includes(candidate.phase ?? "") && Number.isInteger(candidate.canonical_revision) && Number.isInteger(candidate.authority_revision) && typeof candidate.updated_at === "string" && Array.isArray(candidate.transitions);
}
function canonicalCutoverStatus(home2) {
  const value2 = readJson(statePath(home2));
  if (value2 === void 0)
    return void 0;
  if (!validState(value2))
    throw new CanonicalCutoverError("cutover.state_invalid", "canonical cutover state is invalid; restore the authority pointer from its checkpoint");
  return Object.freeze(value2);
}
function transition(home2, input) {
  const current = canonicalCutoverStatus(home2);
  const transitions = [
    ...current?.transitions ?? [],
    {
      phase: input.phase,
      at: input.at,
      ...input.reason ? { reason: input.reason } : {}
    }
  ];
  const state = Object.freeze({
    schema_version: "golem.canonical-cutover-state/v1",
    plan_hash: input.planHash,
    phase: input.phase,
    canonical_revision: input.canonicalRevision,
    authority_revision: input.authorityRevision,
    ...input.checkpointManifest ? { checkpoint_manifest: input.checkpointManifest } : current?.checkpoint_manifest ? { checkpoint_manifest: current.checkpoint_manifest } : {},
    ...input.rollbackAudit ? { rollback_audit: input.rollbackAudit } : {},
    updated_at: input.at,
    transitions: Object.freeze(transitions)
  });
  atomicJson2(statePath(home2), state);
  return state;
}
function acquireLock2(home2) {
  const target = path10.join(home2, "control-plane", lockFilename);
  fs10.mkdirSync(path10.dirname(target), { recursive: true, mode: 448 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs10.writeFileSync(target, `${JSON.stringify({ pid: process.pid, acquired_at: (/* @__PURE__ */ new Date()).toISOString() })}
`, { encoding: "utf8", flag: "wx", mode: 384 });
      return () => fs10.rmSync(target, { force: true });
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST")
        throw error;
      const existing = readJson(target);
      const pid = existing && typeof existing === "object" ? existing.pid : void 0;
      let alive = !Number.isInteger(pid) || Number(pid) <= 0;
      if (!alive) {
        try {
          process.kill(Number(pid), 0);
          alive = true;
        } catch (probeError) {
          alive = typeof probeError === "object" && probeError !== null && "code" in probeError && probeError.code === "EPERM";
        }
      }
      if (alive || attempt > 0)
        throw new CanonicalCutoverError("cutover.locked", "another canonical cutover operation owns this home");
      fs10.rmSync(target, { force: true });
    }
  }
  throw new CanonicalCutoverError("cutover.locked", "another canonical cutover operation owns this home");
}
function gate(code, passed, actual, remedy) {
  return Object.freeze({ code, passed, actual, remedy });
}
function backupManifestPath(home2, migration2) {
  return path10.join(home2, "migration-backups", migration2.plan_hash.slice(0, 24), "manifest.json");
}
function availableBytes(home2) {
  try {
    const stat = fs10.statfsSync(home2);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return 0;
  }
}
function activeServiceOwners(home2) {
  const owners = /* @__PURE__ */ new Set();
  for (const target of [
    path10.join(home2, "dashboard.json"),
    path10.join(home2, "control-plane", "control-plane.lock")
  ]) {
    const value2 = readJson(target);
    if (!value2 || typeof value2 !== "object")
      continue;
    const pid = value2.pid;
    if (!Number.isInteger(pid) || Number(pid) <= 0)
      continue;
    try {
      process.kill(Number(pid), 0);
      owners.add(Number(pid));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EPERM")
        owners.add(Number(pid));
    }
  }
  return owners.size;
}
function planHashBody(plan) {
  return digest4(plan);
}
var retiredRuntimeSourceIds = /* @__PURE__ */ new Set([
  "projects",
  "sessions",
  "facts",
  "leases",
  "channels",
  "opencode-bridges",
  "codex-supervisors"
]);
function runtimeSourceHash(plan) {
  return digest4(plan.sources.filter((source2) => retiredRuntimeSourceIds.has(source2.id)));
}
async function planCanonicalCutover(options) {
  const home2 = path10.resolve(options.home);
  const evidence = options.evidence ?? {};
  const migration2 = await migrationStatus(home2);
  const currentLegacyPlan = await auditLegacyHome(home2);
  const projection = readProjection(home2);
  const binaryPath = path10.resolve(options.binary_path ?? defaultServiceBinaryPath());
  const binaryHash = fs10.existsSync(binaryPath) ? fileDigest(binaryPath) : "";
  const schemaHash = digest4(persistenceMigrations);
  const migrationHash = migration2 ? digest4({
    plan_hash: migration2.plan_hash,
    source_manifest_hash: migration2.source_manifest_hash,
    imported: migration2.imported
  }) : "";
  const backupPath = migration2 ? backupManifestPath(home2, migration2) : "";
  const backup = backupPath ? readJson(backupPath) : void 0;
  const backupSnapshotHome = backupPath ? path10.join(path10.dirname(backupPath), "legacy") : "";
  const importedLegacyPlan = backupSnapshotHome && fs10.existsSync(backupSnapshotHome) ? await auditLegacyHome(backupSnapshotHome) : void 0;
  const importedRuntimeSourceHash = importedLegacyPlan ? runtimeSourceHash(importedLegacyPlan) : "";
  const currentRuntimeSourceHash = runtimeSourceHash(currentLegacyPlan);
  const backupVerified = Boolean(backup) && typeof backup === "object" && backup.plan_hash === migration2?.plan_hash;
  const parityGaps = evidence.parity_gaps ?? [];
  const unsafeBacklog2 = evidence.unsafe_backlog ?? 0;
  const serviceOwners = evidence.service_owners ?? activeServiceOwners(home2);
  const unqualifiedPresets = (evidence.presets ?? []).filter((preset) => preset.enabled && !preset.qualified);
  const apiSmoke = evidence.api_smoke ?? true;
  const uiSmoke = evidence.ui_smoke ?? true;
  const strongConflicts = evidence.strong_identity_conflicts ?? 0;
  const minimumFreeBytes = evidence.minimum_free_bytes ?? Math.max(1048576, (migration2?.source_bytes ?? 0) * 2);
  const freeBytes = availableBytes(home2);
  const canonicalInvariant = Boolean(projection) && Boolean(migration2) && projection?.projects.length === migration2?.imported.projects && projection?.sessions.length === migration2?.imported.sessions && fs10.existsSync(path10.join(home2, "canonical", "runtime.db")) && fs10.existsSync(path10.join(home2, "tracker.db"));
  const gates = Object.freeze([
    gate("cutover.migration_applied", migration2?.status === "applied", migration2?.status ?? "missing", "run the exact-hash legacy migration apply before cutover"),
    gate("cutover.backup_verified", backupVerified, backupVerified, "re-run migration apply so its exact backup manifest can be verified"),
    gate("cutover.binary_hash", binaryHash.length === 64 && (!evidence.expected_binary_hash || evidence.expected_binary_hash === binaryHash), binaryHash || "missing", "stage the expected service binary and regenerate the cutover plan"),
    gate("cutover.schema_hash", !evidence.expected_schema_hash || evidence.expected_schema_hash === schemaHash, schemaHash, "build the expected persistence schema before retrying cutover"),
    gate("cutover.migration_hash", Boolean(migrationHash) && (!evidence.expected_migration_hash || evidence.expected_migration_hash === migrationHash), migrationHash || "missing", "repeat migration dry-run/apply and approve its exact artifact hash"),
    gate("cutover.final_import_current", Boolean(migration2) && Boolean(importedRuntimeSourceHash) && currentRuntimeSourceHash === importedRuntimeSourceHash, Boolean(migration2) && Boolean(importedRuntimeSourceHash) && currentRuntimeSourceHash === importedRuntimeSourceHash, "legacy sources changed after import; roll back the staged migration, re-import the final exact snapshot, then regenerate the cutover plan"),
    gate("cutover.parity_complete", parityGaps.length === 0, parityGaps.length, "close every required parity gap before C4"),
    gate("cutover.backlog_safe", unsafeBacklog2 === 0, unsafeBacklog2, "drain or explicitly quarantine every unsafe inbox/outbox item"),
    gate("cutover.single_owner", serviceOwners <= 1, serviceOwners <= 1, "fence duplicate services until at most one owner remains; apply quiesces that final owner"),
    gate("cutover.presets_qualified", unqualifiedPresets.length === 0, unqualifiedPresets.length, "disable or qualify each enabled launcher preset"),
    gate("cutover.api_smoke", apiSmoke, apiSmoke, "pass the authenticated typed API smoke before C4"),
    gate("cutover.ui_smoke", uiSmoke, uiSmoke, "pass the typed dashboard smoke before C4"),
    gate("cutover.disk_space", Number.isSafeInteger(freeBytes) && freeBytes >= minimumFreeBytes, Number.isSafeInteger(freeBytes) && freeBytes >= minimumFreeBytes, `free at least ${minimumFreeBytes} bytes for checkpoints`),
    gate("cutover.identity_conflicts", strongConflicts === 0, strongConflicts, "resolve every strong-identity conflict or leave it explicitly quarantined"),
    gate("cutover.canonical_invariants", canonicalInvariant, canonicalInvariant, "re-run migration and verify canonical counts/revision plus tracker authority")
  ]);
  const body = Object.freeze({
    schema_version: "golem.canonical-cutover-plan/v1",
    migration_plan_hash: migration2?.plan_hash ?? "0".repeat(64),
    source_manifest_hash: migration2?.source_manifest_hash ?? "0".repeat(64),
    imported_runtime_source_hash: importedRuntimeSourceHash || "0".repeat(64),
    current_runtime_source_hash: currentRuntimeSourceHash,
    binary_hash: binaryHash || "0".repeat(64),
    schema_hash: schemaHash,
    migration_hash: migrationHash || "0".repeat(64),
    canonical_revision: projection?.canonical_revision ?? 0,
    canonical_counts: Object.freeze({
      projects: projection?.projects.length ?? 0,
      sessions: projection?.sessions.length ?? 0
    }),
    gates,
    eligible: gates.every((entry2) => entry2.passed)
  });
  return Object.freeze({
    ...body,
    plan_hash: planHashBody(body),
    generated_at: now2(options)
  });
}
function copyIfPresent2(source2, target) {
  if (!fs10.existsSync(source2))
    return;
  fs10.mkdirSync(path10.dirname(target), { recursive: true, mode: 448 });
  fs10.cpSync(source2, target, {
    dereference: false,
    preserveTimestamps: true,
    recursive: true
  });
}
function createCheckpoint(home2, plan) {
  const directory = path10.join(home2, "cutover-backups", plan.plan_hash.slice(0, 24));
  const manifestPath = path10.join(directory, "manifest.json");
  if (fs10.existsSync(manifestPath)) {
    const existing = readJson(manifestPath);
    if (existing && typeof existing === "object" && existing.plan_hash === plan.plan_hash)
      return path10.relative(home2, manifestPath);
    throw new CanonicalCutoverError("cutover.state_invalid", "cutover checkpoint exists but does not match the approved plan");
  }
  fs10.mkdirSync(directory, { recursive: true, mode: 448 });
  for (const relative of [
    "runtime.db",
    "runtime.db-wal",
    "runtime.db-shm",
    "tracker.db",
    "tracker.db-wal",
    "tracker.db-shm",
    "config.json",
    "config.jsonc",
    "dashboard.json",
    "substrate.lock",
    "renders",
    "control-plane/service-definition.json"
  ])
    copyIfPresent2(path10.join(home2, relative), path10.join(directory, "legacy", relative));
  copyIfPresent2(path10.join(home2, "canonical"), path10.join(directory, "canonical"));
  const manifest = {
    schema_version: "golem.canonical-cutover-checkpoint/v1",
    plan_hash: plan.plan_hash,
    binary_hash: plan.binary_hash,
    schema_hash: plan.schema_hash,
    migration_hash: plan.migration_hash,
    runtime_authority: "canonical/runtime.db",
    tracker_authority: "tracker.db"
  };
  atomicJson2(manifestPath, manifest);
  return path10.relative(home2, manifestPath);
}
function publishCompatibilityProjection(home2, plan) {
  const target = path10.join(home2, "compatibility", "legacy-projection.json");
  const projection = readProjection(home2);
  if (!projection)
    throw new CanonicalCutoverError("cutover.state_invalid", "generated compatibility projection is unavailable");
  atomicJson2(target, {
    ...projection,
    generated: true,
    authoritative: false,
    read_only: true,
    authority: "canonical",
    canonical_revision: plan.canonical_revision,
    cutover_plan_hash: plan.plan_hash,
    banner: "generated/non-authoritative compatibility export; writes are rejected"
  }, 292);
  fs10.chmodSync(target, 292);
}
function assertApproved(plan, expected) {
  if (!expected.trim())
    throw new CanonicalCutoverError("cutover.plan_hash_required", "an explicit canonical cutover plan hash is required");
  if (plan.plan_hash !== expected)
    throw new CanonicalCutoverError("cutover.plan_hash_mismatch", "the supplied hash does not match the current canonical cutover plan");
  const failed = plan.gates.filter((entry2) => !entry2.passed);
  if (failed.length)
    throw new CanonicalCutoverError("cutover.preflight_failed", failed.map((entry2) => `${entry2.code}: ${entry2.remedy}`).join("; "), failed);
}
async function applyCanonicalCutover(options) {
  const plan = await planCanonicalCutover(options);
  assertApproved(plan, options.expected_plan_hash);
  const release = acquireLock2(options.home);
  try {
    const before = canonicalCutoverStatus(options.home);
    let authority = readControlPlaneAuthority(options.home);
    if (authority.stage === "C4" && authority.plan_hash === plan.plan_hash && before && (before.phase === "soaking" || before.phase === "stable"))
      return Object.freeze({
        plan,
        state: before,
        authority,
        resumed: false,
        idempotent: true
      });
    const resumed = authority.write_policy === "quiesced" || before?.phase === "quiesced" || before?.phase === "checkpointed";
    if (authority.stage === "C3" && authority.write_policy === "legacy_open") {
      authority = writeControlPlaneAuthority(options.home, {
        stage: "C3",
        write_policy: "quiesced",
        plan_hash: plan.plan_hash,
        canonical_revision: plan.canonical_revision,
        updated_at: now2(options)
      });
      transition(options.home, {
        planHash: plan.plan_hash,
        phase: "quiesced",
        canonicalRevision: plan.canonical_revision,
        authorityRevision: authority.revision,
        at: now2(options)
      });
    } else if (authority.stage !== "C3" || authority.write_policy !== "quiesced" || authority.plan_hash !== plan.plan_hash) {
      throw new CanonicalCutoverError("cutover.state_invalid", "authority pointer is not a resumable C3 quiesce for this plan");
    }
    if (options.failpoint === "after_quiesce")
      throw new Error("canonical cutover failpoint after_quiesce");
    const finalLegacyPlan = await auditLegacyHome(options.home);
    if (runtimeSourceHash(finalLegacyPlan) !== plan.current_runtime_source_hash || runtimeSourceHash(finalLegacyPlan) !== plan.imported_runtime_source_hash)
      throw new CanonicalCutoverError("cutover.source_changed", "legacy sources changed after the exact cutover plan was approved; writers remain quiesced until rollback or a fresh final import");
    const checkpointManifest = createCheckpoint(options.home, plan);
    const checkpointed = transition(options.home, {
      planHash: plan.plan_hash,
      phase: "checkpointed",
      canonicalRevision: plan.canonical_revision,
      authorityRevision: authority.revision,
      checkpointManifest,
      at: now2(options)
    });
    if (options.failpoint === "after_checkpoint")
      throw new Error("canonical cutover failpoint after_checkpoint");
    publishCompatibilityProjection(options.home, plan);
    authority = writeControlPlaneAuthority(options.home, {
      stage: "C4",
      write_policy: "canonical_only",
      plan_hash: plan.plan_hash,
      canonical_revision: plan.canonical_revision,
      updated_at: now2(options)
    });
    const state = transition(options.home, {
      planHash: plan.plan_hash,
      phase: "soaking",
      canonicalRevision: plan.canonical_revision,
      authorityRevision: authority.revision,
      ...checkpointed.checkpoint_manifest ? { checkpointManifest: checkpointed.checkpoint_manifest } : {},
      at: now2(options)
    });
    if (options.failpoint === "after_switch")
      throw new Error("canonical cutover failpoint after_switch");
    return Object.freeze({
      plan,
      state,
      authority,
      resumed,
      idempotent: false
    });
  } finally {
    release();
  }
}
function auditDirectory(home2, at) {
  const safe = at.replaceAll(/[^0-9A-Za-z_-]/gu, "-");
  return path10.join(home2, "cutover-audit", safe);
}
function rollbackAudit(home2, state, at, reason) {
  const directory = auditDirectory(home2, at);
  fs10.mkdirSync(directory, { recursive: true, mode: 448 });
  copyIfPresent2(path10.join(home2, "canonical"), path10.join(directory, "canonical"));
  copyIfPresent2(path10.join(home2, "compatibility"), path10.join(directory, "compatibility"));
  const files = [
    "canonical/runtime.db",
    "canonical/runtime.db-wal",
    "canonical/runtime.db-shm",
    "tracker.db",
    "tracker.db-wal",
    "compatibility/legacy-projection.json"
  ].filter((relative) => fs10.existsSync(path10.join(home2, relative))).map((relative) => ({
    path: relative,
    bytes: fs10.statSync(path10.join(home2, relative)).size,
    sha256: fileDigest(path10.join(home2, relative))
  }));
  const manifestPath = path10.join(directory, "rollback-audit.json");
  atomicJson2(manifestPath, {
    schema_version: "golem.canonical-rollback-audit/v1",
    plan_hash: state.plan_hash,
    canonical_revision: state.canonical_revision,
    reason,
    recorded_at: at,
    canonical_data_preserved: true,
    files
  });
  return path10.relative(home2, manifestPath);
}
function restoreCompatibilityDiscovery(home2, state) {
  const checkpoint = state.checkpoint_manifest ? path10.resolve(home2, state.checkpoint_manifest) : void 0;
  const prior = checkpoint ? path10.join(path10.dirname(checkpoint), "legacy", "dashboard.json") : void 0;
  const target = path10.join(home2, "dashboard.json");
  if (prior && fs10.existsSync(prior)) {
    copyIfPresent2(prior, target);
    return;
  }
  const current = readJson(target);
  if (current && typeof current === "object" && current.schema_version === "golem.dashboard-discovery/v1" && current.generated === true && current.authoritative === false)
    fs10.rmSync(target, { force: true });
}
async function rollbackCanonicalCutover(home2, options = {}) {
  const release = acquireLock2(home2);
  try {
    const state = canonicalCutoverStatus(home2);
    const authority = readControlPlaneAuthority(home2);
    if (state && state.phase !== "rolled_back" && authority.stage === "C3" && authority.write_policy === "legacy_open" && authority.plan_hash === state.plan_hash && authority.rollback_audit) {
      const at2 = now2(options);
      const resumed = transition(home2, {
        planHash: state.plan_hash,
        phase: "rolled_back",
        canonicalRevision: state.canonical_revision,
        authorityRevision: authority.revision,
        rollbackAudit: authority.rollback_audit,
        reason: options.reason ?? "resumed completed authority rollback",
        at: at2
      });
      return Object.freeze({
        state: resumed,
        authority,
        rollback_triggered: true,
        triggers: Object.freeze([
          options.reason ?? "resumed completed authority rollback"
        ])
      });
    }
    if (!state || authority.stage !== "C4" && authority.write_policy !== "quiesced")
      throw new CanonicalCutoverError("cutover.not_active", "no canonical cutover is active or quiesced");
    const at = now2(options);
    const reason = options.reason ?? "operator rollback";
    const audit = rollbackAudit(home2, state, at, reason);
    restoreCompatibilityDiscovery(home2, state);
    const restored = writeControlPlaneAuthority(home2, {
      stage: "C3",
      write_policy: "legacy_open",
      plan_hash: state.plan_hash,
      canonical_revision: state.canonical_revision,
      rollback_audit: audit,
      updated_at: at
    });
    if (options.failpoint === "after_authority")
      throw new Error("canonical rollback failpoint after_authority");
    const rolledBack = transition(home2, {
      planHash: state.plan_hash,
      phase: "rolled_back",
      canonicalRevision: state.canonical_revision,
      authorityRevision: restored.revision,
      rollbackAudit: audit,
      reason,
      at
    });
    return Object.freeze({
      state: rolledBack,
      authority: restored,
      rollback_triggered: true,
      triggers: Object.freeze([reason])
    });
  } finally {
    release();
  }
}
async function evaluateCanonicalCutoverSoak(home2, evidence = {}, options = {}) {
  const state = canonicalCutoverStatus(home2);
  const authority = readControlPlaneAuthority(home2);
  if (!state || state.phase !== "soaking" && state.phase !== "rollback_required" || authority.stage !== "C4")
    throw new CanonicalCutoverError("cutover.not_active", "canonical cutover is not in its soak window");
  const triggers = [
    ...evidence.parity_ok === false ? ["parity regression"] : [],
    ...evidence.health_ok === false ? ["health regression"] : [],
    ...(evidence.unsafe_backlog ?? 0) > 0 ? [`unsafe backlog ${evidence.unsafe_backlog}`] : [],
    ...evidence.single_owner === false ? ["owner uniqueness regression"] : []
  ];
  if (triggers.length && options.auto_rollback !== false)
    return rollbackCanonicalCutover(home2, {
      reason: `soak policy: ${triggers.join(", ")}`,
      ...options.now ? { now: options.now } : {}
    });
  const phase = triggers.length ? "rollback_required" : "stable";
  const next = transition(home2, {
    planHash: state.plan_hash,
    phase,
    canonicalRevision: state.canonical_revision,
    authorityRevision: authority.revision,
    reason: triggers.length ? triggers.join(", ") : "soak gates passed",
    at: now2(options)
  });
  return Object.freeze({
    state: next,
    authority,
    rollback_triggered: false,
    triggers: Object.freeze(triggers)
  });
}

// packages/compat/bin/migration-plan.mjs
var rawArgs = process.argv.slice(2);
var commands = [
  "plan",
  "apply",
  "status",
  "rollback",
  "cutover-plan",
  "cutover-apply",
  "cutover-status",
  "cutover-soak",
  "cutover-rollback"
];
var command = commands.includes(rawArgs[0]) ? rawArgs[0] : "plan";
var args = command === rawArgs[0] ? rawArgs.slice(1) : rawArgs;
var homeIndex = args.indexOf("--home");
var home = homeIndex === -1 ? void 0 : args[homeIndex + 1];
var hashIndex = args.indexOf("--plan-hash");
var planHash = hashIndex === -1 ? void 0 : args[hashIndex + 1];
var backlogIndex = args.indexOf("--unsafe-backlog");
var unsafeBacklog = backlogIndex === -1 ? void 0 : Number(args[backlogIndex + 1]);
var json8 = args.includes("--json");
var known = /* @__PURE__ */ new Set([
  "--home",
  home,
  "--plan-hash",
  planHash,
  "--json",
  "--dry-run",
  "--health-failed",
  "--parity-failed",
  "--owner-conflict",
  "--no-auto-rollback",
  "--unsafe-backlog",
  backlogIndex === -1 ? void 0 : args[backlogIndex + 1]
]);
if (!home || args.some((argument) => !known.has(argument)) || (command === "apply" || command === "cutover-apply") && !planHash || unsafeBacklog !== void 0 && (!Number.isInteger(unsafeBacklog) || unsafeBacklog < 0)) {
  process.stderr.write(
    "Usage: golem migrate <plan|apply|status|rollback|cutover-plan|cutover-apply|cutover-status|cutover-soak|cutover-rollback> --home <GOLEM_HOME> [--plan-hash <sha256>] [--json]\nApply commands require the exact plan hash printed by their dry-run; legacy sources remain read-only.\n"
  );
  process.exitCode = 2;
} else {
  try {
    if (command === "cutover-plan") {
      const plan = await planCanonicalCutover({ home });
      process.stdout.write(
        json8 ? `${JSON.stringify(plan, null, 2)}
` : `${plan.eligible ? "eligible" : "blocked"}: ${plan.plan_hash}
${plan.gates.map(
          (gate2) => `${gate2.passed ? "PASS" : "FAIL"} ${gate2.code}: ${gate2.actual}${gate2.passed ? "" : ` \u2014 ${gate2.remedy}`}`
        ).join("\n")}
`
      );
    } else if (command === "cutover-status") {
      const status = canonicalCutoverStatus(home);
      process.stdout.write(
        json8 ? `${JSON.stringify(status ?? null, null, 2)}
` : status ? `${status.phase}: ${status.plan_hash}
` : "no canonical cutover has started\n"
      );
    } else if (command === "cutover-rollback") {
      const result2 = await rollbackCanonicalCutover(home);
      process.stdout.write(
        json8 ? `${JSON.stringify(result2, null, 2)}
` : `rolled_back: ${result2.state.plan_hash}
audit: ${result2.state.rollback_audit}
`
      );
    } else if (command === "cutover-soak") {
      const result2 = await evaluateCanonicalCutoverSoak(
        home,
        {
          ...args.includes("--health-failed") ? { health_ok: false } : {},
          ...args.includes("--parity-failed") ? { parity_ok: false } : {},
          ...args.includes("--owner-conflict") ? { single_owner: false } : {},
          ...unsafeBacklog === void 0 ? {} : { unsafe_backlog: unsafeBacklog }
        },
        { auto_rollback: !args.includes("--no-auto-rollback") }
      );
      process.stdout.write(
        json8 ? `${JSON.stringify(result2, null, 2)}
` : `${result2.state.phase}: ${result2.state.plan_hash}${result2.triggers.length ? `
triggers: ${result2.triggers.join(", ")}` : ""}
`
      );
    } else if (command === "cutover-apply") {
      const result2 = await applyCanonicalCutover({
        home,
        expected_plan_hash: planHash
      });
      process.stdout.write(
        json8 ? `${JSON.stringify(result2, null, 2)}
` : `${result2.state.phase}: ${result2.plan.plan_hash}
authority: ${result2.authority.stage}/${result2.authority.write_policy}
`
      );
    } else if (command === "plan") {
      const plan = await auditLegacyHome(home);
      process.stdout.write(
        json8 ? stableAuditPlanJson(plan) : formatAuditPlanText(plan)
      );
    } else if (command === "status") {
      const status = await migrationStatus(home);
      process.stdout.write(
        json8 ? `${JSON.stringify(status ?? null, null, 2)}
` : status ? `${status.status}: ${status.plan_hash}
rollback: ${status.rollback_command}
` : "no migration has been applied\n"
      );
    } else if (command === "rollback") {
      const status = await rollbackLegacyMigration(home);
      process.stdout.write(
        json8 ? `${JSON.stringify(status, null, 2)}
` : `rolled_back: ${status.plan_hash}
`
      );
    } else {
      const result2 = await applyLegacyMigration({
        home,
        expected_plan_hash: planHash
      });
      process.stdout.write(
        json8 ? `${JSON.stringify(result2.status, null, 2)}
` : `applied: ${result2.status.plan_hash}
compatibility: ${result2.status.compatibility_projection}
rollback: ${result2.status.rollback_command}
`
      );
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "migration.failed";
    const message = redactDiagnosticText(
      error instanceof Error ? error.message : "migration command failed"
    );
    process.stderr.write(`${code}: ${message}
`);
    process.exitCode = 3;
  }
}
