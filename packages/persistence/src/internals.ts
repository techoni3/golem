export interface SqliteStatement<Row = Record<string, unknown>> {
	run(...parameters: readonly unknown[]): {
		readonly changes: number;
		readonly lastInsertRowid: number | bigint;
	};
	get(...parameters: readonly unknown[]): Row | undefined;
	all(...parameters: readonly unknown[]): readonly Row[];
}

export interface SqliteConnection {
	pragma(source: string, options?: { readonly simple?: boolean }): unknown;
	exec(source: string): unknown;
	prepare<Row = Record<string, unknown>>(source: string): SqliteStatement<Row>;
	transaction<Args extends readonly unknown[], Result>(
		fn: (...arguments_: Args) => Result,
	): (...arguments_: Args) => Result;
	close(): void;
}

export interface RuntimeTables {
	readonly runtime_events: {
		readonly event_id: string;
		readonly deduplication_key: string;
		readonly event_kind: string;
		readonly payload_json: string;
		readonly provenance_json: string;
		readonly occurred_at: string;
		readonly received_at: string;
		readonly metadata_version: string;
		readonly disposition: string;
	};
	readonly runtime_outbox: {
		readonly id: string;
		readonly destination: string;
		readonly payload_json: string;
		readonly status: string;
		readonly created_at: string;
		readonly published_at: string | null;
		readonly attempts: number;
		readonly claim_owner: string | null;
		readonly claim_token: string | null;
		readonly claim_until: string | null;
		readonly last_error: string | null;
	};
	readonly projects: {
		readonly project_id: string;
		readonly name: string;
		readonly created_at: string;
	};
	readonly project_locations: {
		readonly location_id: number;
		readonly project_id: string;
		readonly location: string;
		readonly observed_at: string;
	};
	readonly logical_sessions: {
		readonly session_id: string;
		readonly project_id: string;
		readonly created_at: string;
	};
	readonly session_generations: {
		readonly generation_id: string;
		readonly session_id: string;
		readonly project_id: string;
		readonly harness: string;
		readonly lifecycle_state: string;
		readonly provenance_json: string;
		readonly created_at: string;
	};
	readonly session_aliases: {
		readonly alias: string;
		readonly session_id: string;
		readonly generation_id: string | null;
		readonly source: string;
		readonly created_at: string;
	};
	readonly endpoint_claims: {
		readonly endpoint_id: string;
		readonly generation_id: string;
		readonly owner_fence: string;
		readonly owner_instance_id: string;
		readonly readiness: string;
		readonly claimed_at: string;
		readonly expires_at: string | null;
	};
	readonly endpoint_capabilities: {
		readonly endpoint_id: string;
		readonly capability: string;
		readonly qualified: number;
		readonly observed_at: string;
	};
	readonly commands: {
		readonly command_id: string;
		readonly idempotency_key: string;
		readonly payload_json: string;
		readonly status: string;
		readonly created_at: string;
	};
	readonly delivery_envelopes: {
		readonly delivery_id: string;
		readonly command_id: string;
		readonly endpoint_id: string;
		readonly payload_json: string;
		readonly status: string;
		readonly created_at: string;
	};
	readonly delivery_acknowledgements: {
		readonly delivery_id: string;
		readonly acknowledgement_id: string;
		readonly payload_json: string;
		readonly acknowledged_at: string;
	};
	readonly projection_cursors: {
		readonly projection: string;
		readonly sequence: number;
		readonly updated_at: string;
	};
	readonly diagnostics: {
		readonly id: string;
		readonly code: string;
		readonly details_json: string;
		readonly created_at: string;
	};
	readonly migration_audit: {
		readonly id: string;
		readonly scope: string;
		readonly plan_hash: string;
		readonly backup_path: string | null;
		readonly applied_at: string;
	};
	readonly producer_watermarks: {
		readonly producer_id: string;
		readonly watermark: string;
		readonly metadata_version: string;
		readonly updated_at: string;
	};
	readonly metadata_versions: {
		readonly metadata_key: string;
		readonly version: string;
		readonly disposition: string;
		readonly recorded_at: string;
	};
	readonly endpoint_fences: {
		readonly generation_id: string;
		readonly route_kind: string;
		readonly fence: number;
		readonly allocated_at: string;
	};
	readonly capability_observations: {
		readonly id: string;
		readonly endpoint_id: string;
		readonly capability: string;
		readonly qualified: number;
		readonly details_json: string;
		readonly observed_at: string;
	};
	readonly migration_runs: {
		readonly id: string;
		readonly scope: string;
		readonly plan_hash: string;
		readonly status: string;
		readonly backup_path: string | null;
		readonly started_at: string;
		readonly completed_at: string | null;
	};
	readonly migration_findings: {
		readonly id: string;
		readonly migration_run_id: string;
		readonly code: string;
		readonly details_json: string;
		readonly created_at: string;
	};
	readonly migration_decisions: {
		readonly id: string;
		readonly migration_run_id: string;
		readonly finding_id: string | null;
		readonly decision: string;
		readonly decided_at: string;
	};
	readonly legacy_snapshots: {
		readonly id: string;
		readonly source_kind: string;
		readonly source_checksum: string;
		readonly payload_json: string;
		readonly captured_at: string;
	};
	readonly golem_migrations: {
		readonly id: string;
		readonly checksum: string;
		readonly applied_at: string;
	};
	readonly live_sessions: {
		readonly generation_id: string;
		readonly session_id: string;
		readonly project_id: string;
		readonly harness: string;
		readonly lifecycle_state: string;
	};
	readonly session_history: {
		readonly generation_id: string;
		readonly session_id: string;
		readonly project_id: string;
		readonly harness: string;
		readonly lifecycle_state: string;
		readonly created_at: string;
	};
	readonly runtime_diagnostics: {
		readonly id: string;
		readonly code: string;
		readonly details_json: string;
		readonly created_at: string;
	};
}

export interface TrackerTables {
	readonly golem_migrations: {
		readonly id: string;
		readonly checksum: string;
		readonly applied_at: string;
	};
	readonly migration_audit: {
		readonly id: string;
		readonly scope: string;
		readonly plan_hash: string;
		readonly backup_path: string | null;
		readonly applied_at: string;
	};
}
