const ids = {
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
	session: "ses_dddddddd-dddd-4ddd-8ddd-dddddddddddd",
} as const;

const timestamp = {
	event: "2026-07-20T09:59:00.000Z",
	observed: "2026-07-20T10:00:00.000Z",
	received: "2026-07-20T10:01:00.000Z",
	materialized: "2026-07-20T10:02:00.000Z",
} as const;

const project = { project_id: ids.project };
const location = {
	project_id: ids.project,
	location_id: ids.location,
	relation: "main",
	canonical_path: "/workspace/golem",
};
const session = { project_id: ids.project, session_id: ids.session };
const generation = { ...session, generation_id: ids.generation };
const actor = { actor_id: ids.actor, kind: "human", display_name: "Operator" };
const producer = {
	producer: "claude-adapter",
	producer_instance_id: ids.producer,
	harness: "claude",
};
const clocks = {
	source_event_at: timestamp.event,
	source_observed_at: timestamp.observed,
	received_at: timestamp.received,
	materialized_at: timestamp.materialized,
};
const provenance = { source: "adapter", confidence: "verified" };
const endpoint = {
	endpoint_id: ids.endpoint,
	generation,
	state: "healthy",
	owner_fence: "fence-1",
	delivery_mode: "native_channel",
	readiness: "ready",
	revision: 1,
	last_heartbeat_at: timestamp.observed,
};
const capability = {
	capability_id: "claude.channel",
	harness: "claude",
	adapter_version: "1.0.0",
	integration_layers: ["hooks", "mcp", "channel"],
	qualification: "supported",
	delivery_mode: "native_channel",
	readiness: "ready",
	evidence_version: "journey-v1",
};
const controlCommand = {
	schema_version: "golem.control-command/v1",
	command_id: ids.command,
	command_kind: "project.register",
	actor,
	correlation_id: "correlation-1",
	idempotency_key: "command:project.register:1",
	target: { kind: "project", project },
	audit: { request_source: "cli", redacted_metadata: { intent: "register" } },
	payload: { kind: "project.register", project, location },
};

function negativeVersion(value: Record<string, unknown>) {
	return { ...value, schema_version: "golem.unsupported/v2" };
}

export const ContractFixtureIds = ids;

/** One positive and one negative JSON fixture for every public registry entry. */
export const ContractFixtures = {
	"project-reference": {
		positive: { schema_version: "golem.project-reference/v1", ...project },
		negative: {
			schema_version: "golem.project-reference/v1",
			project_id: "project-name",
		},
	},
	"project-location-reference": {
		positive: {
			schema_version: "golem.project-location-reference/v1",
			...location,
		},
		negative: negativeVersion({
			schema_version: "golem.project-location-reference/v1",
			...location,
		}),
	},
	"session-reference": {
		positive: { schema_version: "golem.session-reference/v1", ...session },
		negative: negativeVersion({
			schema_version: "golem.session-reference/v1",
			...session,
		}),
	},
	"generation-reference": {
		positive: {
			schema_version: "golem.generation-reference/v1",
			...generation,
		},
		negative: negativeVersion({
			schema_version: "golem.generation-reference/v1",
			...generation,
		}),
	},
	"alias-reference": {
		positive: {
			schema_version: "golem.alias-reference/v1",
			project_id: ids.project,
			harness: "claude",
			alias_kind: "native_conversation",
			alias: "native-thread-1",
			session,
		},
		negative: {
			schema_version: "golem.alias-reference/v1",
			project_id: ids.project,
			harness: "claude",
			alias_kind: "native_conversation",
			alias: "native-thread-1",
			session: {
				project_id: "prj_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
				session_id: ids.session,
			},
		},
	},
	"actor-reference": {
		positive: { schema_version: "golem.actor-reference/v1", ...actor },
		negative: negativeVersion({
			schema_version: "golem.actor-reference/v1",
			...actor,
		}),
	},
	"producer-reference": {
		positive: { schema_version: "golem.producer-reference/v1", ...producer },
		negative: negativeVersion({
			schema_version: "golem.producer-reference/v1",
			...producer,
		}),
	},
	"clock-facts": {
		positive: { schema_version: "golem.clock-facts/v1", ...clocks },
		negative: {
			schema_version: "golem.clock-facts/v1",
			...clocks,
			received_at: "2026-07-20T09:00:00.000Z",
		},
	},
	provenance: {
		positive: { schema_version: "golem.provenance/v1", ...provenance },
		negative: negativeVersion({
			schema_version: "golem.provenance/v1",
			...provenance,
		}),
	},
	"lifecycle-facts": {
		positive: {
			schema_version: "golem.lifecycle-facts/v1",
			generation,
			state: "ended",
			started_at: timestamp.event,
			ended_at: timestamp.materialized,
		},
		negative: {
			schema_version: "golem.lifecycle-facts/v1",
			generation,
			state: "ended",
			started_at: timestamp.materialized,
			ended_at: timestamp.event,
		},
	},
	"endpoint-record": {
		positive: { schema_version: "golem.endpoint-record/v1", ...endpoint },
		negative: negativeVersion({
			schema_version: "golem.endpoint-record/v1",
			...endpoint,
		}),
	},
	"capability-record": {
		positive: { schema_version: "golem.capability-record/v1", ...capability },
		negative: negativeVersion({
			schema_version: "golem.capability-record/v1",
			...capability,
		}),
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
				metadata: { model: "gpt" },
			},
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
			payload: { kind: "session.idle", generation },
		},
	},
	"control-command": {
		positive: controlCommand,
		negative: { ...controlCommand, command_id: "cmd_not-a-uuid" },
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
			payload: { type: "brief", body: "hello" },
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
			payload: { type: "brief" },
		}),
	},
	"delivery-acknowledgement": {
		positive: {
			schema_version: "golem.delivery-acknowledgement/v1",
			delivery_id: ids.delivery,
			status: "accepted",
			acknowledged_at: timestamp.materialized,
		},
		negative: negativeVersion({
			schema_version: "golem.delivery-acknowledgement/v1",
			delivery_id: ids.delivery,
			status: "accepted",
			acknowledged_at: timestamp.materialized,
		}),
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
			env_key_refs: ["ANTHROPIC_API_KEY"],
		},
		negative: {
			schema_version: "golem.launcher-preset/v1",
			name: "review",
			harness: "claude",
			backend: "anthropic",
			model_selector: "claude-sonnet",
			delivery_mode: "pull",
			native_args: ["--api-key=plain-secret"],
			env_key_refs: ["ANTHROPIC_API_KEY"],
		},
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
						env_key_refs: ["ANTHROPIC_API_KEY"],
					},
				],
			},
		},
		negative: {
			schema_version: "golem.launcher-config/v1",
			launch: { harness_defaults: {}, presets: [] },
			api_key: "plain-secret",
		},
	},
	"compatibility-ingress": {
		positive: {
			schema_version: "golem.compatibility-ingress/v1",
			legacy_schema_version: "legacy/v7",
			payload: { legacy: true },
			unknown_additive_field: { retained: true },
		},
		negative: negativeVersion({
			schema_version: "golem.compatibility-ingress/v1",
			legacy_schema_version: "legacy/v7",
			payload: { legacy: true },
		}),
	},
	"api-error": {
		positive: {
			schema_version: "golem.api-error/v1",
			code: "not_found",
			message: "resource not found",
			correlation_id: "correlation-1",
		},
		negative: negativeVersion({
			schema_version: "golem.api-error/v1",
			code: "not_found",
			message: "resource not found",
			correlation_id: "correlation-1",
		}),
	},
	"api-command-outcome": {
		positive: {
			schema_version: "golem.api-command-outcome/v1",
			command_id: ids.command,
			status: "accepted",
		},
		negative: negativeVersion({
			schema_version: "golem.api-command-outcome/v1",
			command_id: ids.command,
			status: "accepted",
		}),
	},
	"api-page": {
		positive: {
			schema_version: "golem.api-page/v1",
			items: [{ id: ids.project }],
			next_cursor: null,
			total: 1,
		},
		negative: negativeVersion({
			schema_version: "golem.api-page/v1",
			items: [],
			next_cursor: null,
		}),
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
				payload: { sessions: [] },
			},
		},
		negative: negativeVersion({
			schema_version: "golem.websocket-frame/v1",
			instance_id: ids.controlPlane,
			stream: "runtime.live",
			sequence: 1,
			resource_revision: 2,
			correlation_id: "correlation-1",
			payload: { kind: "snapshot", cursor: "cursor-1", payload: {} },
		}),
	},
	"migration-plan": {
		positive: {
			schema_version: "golem.migration-plan/v1",
			plan_id: ids.migration,
			mode: "dry_run",
			snapshot_id: "snapshot-1",
			plan_hash:
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			created_at: timestamp.received,
			counts_by_reason: { imported: 1 },
			steps: [
				{ id: "import-projects", kind: "import", input: { source: "legacy" } },
			],
			rollback_prerequisites: ["backup-present"],
		},
		negative: negativeVersion({
			schema_version: "golem.migration-plan/v1",
			plan_id: ids.migration,
			mode: "dry_run",
			snapshot_id: "snapshot-1",
			plan_hash:
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			created_at: timestamp.received,
			counts_by_reason: { imported: 1 },
			steps: [
				{ id: "import-projects", kind: "import", input: { source: "legacy" } },
			],
			rollback_prerequisites: ["backup-present"],
		}),
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
			remediation: ["Choose an explicit alias relation"],
		},
		negative: negativeVersion({
			schema_version: "golem.diagnostics-explanation/v1",
			code: "alias_ambiguous",
			severity: "warning",
			message: "Alias requires review",
			event_ids: [],
			facts: {},
			remediation: [],
		}),
	},
} as const;

export type ContractFixtureName = keyof typeof ContractFixtures;
