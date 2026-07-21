import type { SqliteConnection } from "./internals.js";
import type {
	RuntimeDiagnosticRecord,
	RuntimeEndpointStorage,
	RuntimeEndpointView,
	RuntimeEventRecord,
	RuntimeProjectionStorage,
	RuntimeProjectStorage,
	RuntimeProjectView,
	RuntimeSessionStorage,
	RuntimeSessionView,
	RuntimeWatermarkRecord,
} from "./types.js";

type JsonObject = Record<string, unknown>;

function objectJson(value: string | null | undefined): JsonObject {
	if (!value) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as JsonObject)
			: {};
	} catch {
		return {};
	}
}

function safeRows<T>(rows: readonly T[], limit = 2_000): readonly T[] {
	return rows.length <= limit ? rows : rows.slice(0, limit);
}

/**
 * The projection read side is deliberately separate from the mutation
 * repositories. It composes their typed views and only reads the remaining
 * event/diagnostic facts needed to explain a projection.
 */
export class RuntimeProjectionRepository implements RuntimeProjectionStorage {
	readonly #database: SqliteConnection;
	readonly #projects: RuntimeProjectStorage;
	readonly #sessions: RuntimeSessionStorage;
	readonly #endpoints: RuntimeEndpointStorage;

	constructor(
		database: SqliteConnection,
		projects: RuntimeProjectStorage,
		sessions: RuntimeSessionStorage,
		endpoints: RuntimeEndpointStorage,
	) {
		this.#database = database;
		this.#projects = projects;
		this.#sessions = sessions;
		this.#endpoints = endpoints;
	}

	projects(): readonly RuntimeProjectView[] {
		const rows = this.#database
			.prepare<{ readonly project_id: string }>(
				"SELECT project_id FROM projects ORDER BY project_id LIMIT 2000",
			)
			.all();
		return rows.flatMap((row) => {
			const project = this.#projects.get(row.project_id);
			return project ? [project] : [];
		});
	}

	sessions(projectId?: string): readonly RuntimeSessionView[] {
		if (projectId) return this.#sessions.list(projectId);
		return this.projects().flatMap((project) =>
			this.#sessions.list(project.projectId),
		);
	}

	endpoints(generationId?: string): readonly RuntimeEndpointView[] {
		if (generationId) return this.#endpoints.list(generationId);
		return this.sessions().flatMap((session) =>
			session.generations.flatMap((generation) =>
				this.#endpoints.list(generation.generationId),
			),
		);
	}

	events(): readonly RuntimeEventRecord[] {
		const rows = this.#database
			.prepare<{
				readonly event_id: string;
				readonly event_kind: string;
				readonly payload_json: string;
				readonly provenance_json: string;
				readonly source_observed_at: string;
				readonly received_at: string;
				readonly materialized_at: string;
				readonly disposition: RuntimeEventRecord["disposition"];
			}>(
				"SELECT event_id, event_kind, payload_json, provenance_json, source_observed_at, received_at, materialized_at, disposition FROM runtime_events ORDER BY received_at, event_id LIMIT 2000",
			)
			.all();
		return safeRows(
			rows.map((row) =>
				Object.freeze({
					eventId: row.event_id,
					eventKind: row.event_kind,
					payload: objectJson(row.payload_json),
					provenance: objectJson(row.provenance_json),
					sourceObservedAt: row.source_observed_at,
					receivedAt: row.received_at,
					materializedAt: row.materialized_at,
					disposition: row.disposition,
				}),
			),
		);
	}

	diagnostics(): readonly RuntimeDiagnosticRecord[] {
		const rows = this.#database
			.prepare<{
				readonly id: string;
				readonly code: string;
				readonly details_json: string;
				readonly created_at: string;
			}>(
				"SELECT id, code, details_json, created_at FROM diagnostics ORDER BY created_at, id LIMIT 2000",
			)
			.all();
		return safeRows(
			rows.map((row) =>
				Object.freeze({
					id: row.id,
					code: row.code,
					details: objectJson(row.details_json),
					createdAt: row.created_at,
				}),
			),
		);
	}

	watermarks(): readonly RuntimeWatermarkRecord[] {
		const rows = this.#database
			.prepare<{
				readonly producer_id: string;
				readonly watermark: string;
				readonly source_observed_at: string;
				readonly received_at: string;
				readonly materialized_at: string;
			}>(
				"SELECT producer_id, watermark, source_observed_at, received_at, materialized_at FROM producer_watermarks ORDER BY producer_id LIMIT 2000",
			)
			.all();
		return rows.map((row) =>
			Object.freeze({
				producerId: row.producer_id,
				watermark: row.watermark,
				sourceObservedAt: row.source_observed_at,
				receivedAt: row.received_at,
				materializedAt: row.materialized_at,
			}),
		);
	}

	revision(): number {
		const row = this.#database
			.prepare<{
				readonly events: number;
				readonly diagnostics: number;
				readonly sessions: number;
				readonly generations: number;
				readonly endpoints: number;
			}>(
				"SELECT (SELECT COUNT(*) FROM runtime_events) AS events, (SELECT COUNT(*) FROM diagnostics) AS diagnostics, COALESCE((SELECT MAX(revision) FROM session_projection), 0) AS sessions, COALESCE((SELECT MAX(revision) FROM generation_projection), 0) AS generations, COALESCE((SELECT MAX(revision) FROM endpoint_claims), 0) AS endpoints",
			)
			.get();
		return row
			? Math.max(
					row.events,
					row.diagnostics,
					row.sessions,
					row.generations,
					row.endpoints,
				)
			: 0;
	}
}
