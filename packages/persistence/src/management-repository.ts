import type { Kysely } from "kysely";
import type { SqliteConnection, TrackerTables } from "./internals.js";
import { SyncKyselyTrackerStore } from "./kysely-sync.js";
import type {
	ManagementGateKind,
	ManagementGateStatus,
	ManagementIdeaStatus,
	ManagementOperationStatus,
	ManagementRoleScope,
	TrackerJsonObject,
	TrackerManagementAsset,
	TrackerManagementAssignment,
	TrackerManagementAuditRecord,
	TrackerManagementGate,
	TrackerManagementIdea,
	TrackerManagementOperation,
	TrackerManagementRole,
	TrackerManagementStorageCapability,
} from "./types.js";

type RoleRow = TrackerTables["management_roles"];
type AssignmentRow = TrackerTables["management_role_assignments"];
type GateRow = TrackerTables["management_gates"];
type IdeaRow = TrackerTables["management_ideas"];
type AssetRow = TrackerTables["management_assets"];
type OperationRow = TrackerTables["management_operations"];
type AuditRow = TrackerTables["management_audit"];

function parseJson(value: string | null | undefined): TrackerJsonObject {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as TrackerJsonObject)
			: {};
	} catch {
		return {};
	}
}

function json(value: TrackerJsonObject): string {
	return JSON.stringify(value);
}

function rowRole(row: RoleRow): TrackerManagementRole {
	return Object.freeze({
		id: row.id,
		projectId: row.project_id,
		name: row.name,
		scope: row.scope as ManagementRoleScope,
		definition: parseJson(row.definition_json),
		revision: row.revision,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	});
}

function rowAssignment(row: AssignmentRow): TrackerManagementAssignment {
	return Object.freeze({
		id: row.id,
		projectId: row.project_id,
		...(row.session_id ? { sessionId: row.session_id } : {}),
		...(row.generation_id ? { generationId: row.generation_id } : {}),
		roleId: row.role_id,
		actor: row.actor,
		idempotencyKey: row.idempotency_key,
		createdAt: row.created_at,
	});
}

function rowGate(row: GateRow): TrackerManagementGate {
	return Object.freeze({
		id: row.id,
		projectId: row.project_id,
		kind: row.kind as ManagementGateKind,
		status: row.status as ManagementGateStatus,
		question: row.question,
		assignee: row.assignee,
		...(row.verdict_json ? { verdict: parseJson(row.verdict_json) } : {}),
		idempotencyKey: row.idempotency_key,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	});
}

function rowIdea(row: IdeaRow): TrackerManagementIdea {
	return Object.freeze({
		id: row.id,
		projectId: row.project_id,
		body: row.body,
		status: row.status as ManagementIdeaStatus,
		...(row.promoted_ticket_id
			? { promotedTicketId: row.promoted_ticket_id }
			: {}),
		idempotencyKey: row.idempotency_key,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	});
}

function rowAsset(row: AssetRow): TrackerManagementAsset {
	return Object.freeze({
		id: row.id,
		projectId: row.project_id,
		ticketId: row.ticket_id,
		relativePath: row.relative_path,
		mimeType: row.mime_type,
		byteSize: row.byte_size,
		sha256: row.sha256,
		storagePath: row.storage_path,
		createdAt: row.created_at,
	});
}

function rowOperation(row: OperationRow): TrackerManagementOperation {
	return Object.freeze({
		id: row.id,
		projectId: row.project_id,
		...(row.session_id ? { sessionId: row.session_id } : {}),
		...(row.generation_id ? { generationId: row.generation_id } : {}),
		kind: row.kind as TrackerManagementOperation["kind"],
		command: row.command,
		payload: parseJson(row.payload_json),
		status: row.status as ManagementOperationStatus,
		actor: row.actor,
		idempotencyKey: row.idempotency_key,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	});
}

function rowAudit(row: AuditRow): TrackerManagementAuditRecord {
	return Object.freeze({
		id: row.id,
		projectId: row.project_id,
		kind: row.kind,
		subjectId: row.subject_id,
		actor: row.actor,
		details: parseJson(row.details_json),
		createdAt: row.created_at,
	});
}

/** Kysely-only synchronous management adapter over the owner-held tracker DB. */
export class TrackerManagementRepository
	implements TrackerManagementStorageCapability
{
	readonly #store: SyncKyselyTrackerStore;

	constructor(queries: Kysely<TrackerTables>, database: SqliteConnection) {
		this.#store = new SyncKyselyTrackerStore(queries, database);
	}

	#record(
		projectId: string,
		kind: string,
		subjectId: string,
		idempotencyKey: string,
		actor: string,
		details: TrackerJsonObject,
		now: string,
	): void {
		this.#store.run(
			this.#store.queries.insertInto("management_audit").values({
				id: `maud_${globalThis.crypto.randomUUID()}`,
				project_id: projectId,
				kind,
				subject_id: subjectId,
				actor,
				details_json: json(details),
				created_at: now,
			}),
		);
		this.#store.run(
			this.#store.queries
				.insertInto("management_outbox")
				.values({
					id: `mout_${globalThis.crypto.randomUUID()}`,
					project_id: projectId,
					kind,
					payload_json: json({
						kind,
						subject_id: subjectId,
						...details,
					}),
					idempotency_key: idempotencyKey,
					status: "pending",
					created_at: now,
				})
				.onConflict((oc) =>
					oc.columns(["project_id", "idempotency_key"]).doNothing(),
				),
		);
	}

	createRole(
		input: Parameters<TrackerManagementStorageCapability["createRole"]>[0],
	): TrackerManagementRole {
		return this.#store.transaction(() => {
			const existing = this.#store.get<RoleRow>(
				this.#store.queries
					.selectFrom("management_roles")
					.selectAll()
					.where("id", "=", input.id),
			);
			if (existing) {
				if (
					existing.scope === input.scope &&
					existing.definition_json === json(input.definition)
				)
					return rowRole(existing);
				this.#store.run(
					this.#store.queries
						.updateTable("management_roles")
						.set({
							definition_json: json(input.definition),
							scope: input.scope,
							revision: existing.revision + 1,
							updated_at: input.now,
						})
						.where("id", "=", input.id),
				);
				this.#record(
					input.projectId,
					"role.updated",
					input.id,
					`role:${input.id}:${existing.revision + 1}`,
					input.actor,
					{ name: input.name },
					input.now,
				);
				return rowRole(
					this.#store.get<RoleRow>(
						this.#store.queries
							.selectFrom("management_roles")
							.selectAll()
							.where("id", "=", input.id),
					)!,
				);
			}
			this.#store.run(
				this.#store.queries.insertInto("management_roles").values({
					id: input.id,
					project_id: input.projectId,
					name: input.name,
					scope: input.scope,
					definition_json: json(input.definition),
					revision: 1,
					created_at: input.now,
					updated_at: input.now,
				}),
			);
			this.#record(
				input.projectId,
				"role.created",
				input.id,
				`role:${input.id}:1`,
				input.actor,
				{ name: input.name },
				input.now,
			);
			return rowRole(
				this.#store.get<RoleRow>(
					this.#store.queries
						.selectFrom("management_roles")
						.selectAll()
						.where("id", "=", input.id),
				)!,
			);
		});
	}

	listRoles(projectId: string): readonly TrackerManagementRole[] {
		return Object.freeze(
			this.#store
				.all<RoleRow>(
					this.#store.queries
						.selectFrom("management_roles")
						.selectAll()
						.where("project_id", "=", projectId)
						.orderBy("name", "asc"),
				)
				.map(rowRole),
		);
	}

	assignRole(
		input: Parameters<TrackerManagementStorageCapability["assignRole"]>[0],
	): TrackerManagementAssignment {
		return this.#store.transaction(() => {
			const existing = this.#store.get<AssignmentRow>(
				this.#store.queries
					.selectFrom("management_role_assignments")
					.selectAll()
					.where("project_id", "=", input.projectId)
					.where("idempotency_key", "=", input.idempotencyKey),
			);
			if (existing) return rowAssignment(existing);
			this.#store.run(
				this.#store.queries.insertInto("management_role_assignments").values({
					id: input.id,
					project_id: input.projectId,
					session_id: input.sessionId ?? null,
					generation_id: input.generationId ?? null,
					role_id: input.roleId,
					actor: input.actor,
					idempotency_key: input.idempotencyKey,
					created_at: input.now,
				}),
			);
			this.#record(
				input.projectId,
				"role.assigned",
				input.id,
				`assignment:${input.idempotencyKey}`,
				input.actor,
				{
					role_id: input.roleId,
					session_id: input.sessionId ?? null,
					generation_id: input.generationId ?? null,
				},
				input.now,
			);
			return rowAssignment(
				this.#store.get<AssignmentRow>(
					this.#store.queries
						.selectFrom("management_role_assignments")
						.selectAll()
						.where("id", "=", input.id),
				)!,
			);
		});
	}

	createGate(
		input: Parameters<TrackerManagementStorageCapability["createGate"]>[0],
	): TrackerManagementGate {
		return this.#store.transaction(() => {
			const existing = this.#store.get<GateRow>(
				this.#store.queries
					.selectFrom("management_gates")
					.selectAll()
					.where("project_id", "=", input.projectId)
					.where("idempotency_key", "=", input.idempotencyKey),
			);
			if (existing) return rowGate(existing);
			this.#store.run(
				this.#store.queries.insertInto("management_gates").values({
					id: input.id,
					project_id: input.projectId,
					kind: input.kind,
					status: "awaiting",
					question: input.question,
					assignee: input.assignee,
					verdict_json: null,
					idempotency_key: input.idempotencyKey,
					created_at: input.now,
					updated_at: input.now,
				}),
			);
			this.#record(
				input.projectId,
				"gate.created",
				input.id,
				`gate:${input.idempotencyKey}`,
				input.actor,
				{ kind: input.kind, assignee: input.assignee },
				input.now,
			);
			return rowGate(
				this.#store.get<GateRow>(
					this.#store.queries
						.selectFrom("management_gates")
						.selectAll()
						.where("id", "=", input.id),
				)!,
			);
		});
	}

	answerGate(
		input: Parameters<TrackerManagementStorageCapability["answerGate"]>[0],
	): TrackerManagementGate | undefined {
		return this.#store.transaction(() => {
			const existing = this.#store.get<GateRow>(
				this.#store.queries
					.selectFrom("management_gates")
					.selectAll()
					.where("id", "=", input.id)
					.where("project_id", "=", input.projectId),
			);
			if (!existing) return undefined;
			if (existing.status !== "awaiting") return rowGate(existing);
			this.#store.run(
				this.#store.queries
					.updateTable("management_gates")
					.set({
						status: input.status,
						verdict_json: json(input.verdict),
						updated_at: input.now,
					})
					.where("id", "=", input.id)
					.where("status", "=", "awaiting"),
			);
			this.#record(
				input.projectId,
				`gate.${input.status}`,
				input.id,
				`gate:${input.id}:${input.status}`,
				input.actor,
				{ verdict: input.verdict },
				input.now,
			);
			return rowGate(
				this.#store.get<GateRow>(
					this.#store.queries
						.selectFrom("management_gates")
						.selectAll()
						.where("id", "=", input.id),
				)!,
			);
		});
	}

	listGates(projectId: string): readonly TrackerManagementGate[] {
		return Object.freeze(
			this.#store
				.all<GateRow>(
					this.#store.queries
						.selectFrom("management_gates")
						.selectAll()
						.where("project_id", "=", projectId)
						.orderBy("created_at", "desc"),
				)
				.map(rowGate),
		);
	}

	createIdea(
		input: Parameters<TrackerManagementStorageCapability["createIdea"]>[0],
	): TrackerManagementIdea {
		return this.#store.transaction(() => {
			const existing = this.#store.get<IdeaRow>(
				this.#store.queries
					.selectFrom("management_ideas")
					.selectAll()
					.where("project_id", "=", input.projectId)
					.where("idempotency_key", "=", input.idempotencyKey),
			);
			if (existing) return rowIdea(existing);
			this.#store.run(
				this.#store.queries.insertInto("management_ideas").values({
					id: input.id,
					project_id: input.projectId,
					body: input.body,
					status: "pending",
					promoted_ticket_id: null,
					idempotency_key: input.idempotencyKey,
					created_at: input.now,
					updated_at: input.now,
				}),
			);
			this.#record(
				input.projectId,
				"idea.created",
				input.id,
				`idea:${input.idempotencyKey}`,
				input.actor,
				{},
				input.now,
			);
			return rowIdea(
				this.#store.get<IdeaRow>(
					this.#store.queries
						.selectFrom("management_ideas")
						.selectAll()
						.where("id", "=", input.id),
				)!,
			);
		});
	}

	popIdea(input: {
		readonly id: string;
		readonly projectId: string;
		readonly actor: string;
		readonly now: string;
	}): TrackerManagementIdea | undefined {
		return this.#store.transaction(() => {
			const existing = this.#store.get<IdeaRow>(
				this.#store.queries
					.selectFrom("management_ideas")
					.selectAll()
					.where("id", "=", input.id)
					.where("project_id", "=", input.projectId),
			);
			if (!existing) return undefined;
			if (existing.status !== "pending") return rowIdea(existing);
			this.#store.run(
				this.#store.queries
					.updateTable("management_ideas")
					.set({ status: "popped", updated_at: input.now })
					.where("id", "=", input.id)
					.where("status", "=", "pending"),
			);
			this.#record(
				input.projectId,
				"idea.popped",
				input.id,
				`idea:${input.id}:popped`,
				input.actor,
				{},
				input.now,
			);
			return rowIdea(
				this.#store.get<IdeaRow>(
					this.#store.queries
						.selectFrom("management_ideas")
						.selectAll()
						.where("id", "=", input.id),
				)!,
			);
		});
	}

	promoteIdea(input: {
		readonly id: string;
		readonly projectId: string;
		readonly ticketId: string;
		readonly actor: string;
		readonly now: string;
	}): TrackerManagementIdea | undefined {
		return this.#store.transaction(() => {
			const existing = this.#store.get<IdeaRow>(
				this.#store.queries
					.selectFrom("management_ideas")
					.selectAll()
					.where("id", "=", input.id)
					.where("project_id", "=", input.projectId),
			);
			if (!existing) return undefined;
			if (existing.status === "promoted") return rowIdea(existing);
			this.#store.run(
				this.#store.queries
					.updateTable("management_ideas")
					.set({
						status: "promoted",
						promoted_ticket_id: input.ticketId,
						updated_at: input.now,
					})
					.where("id", "=", input.id)
					.where("status", "in", ["pending", "popped"]),
			);
			this.#record(
				input.projectId,
				"idea.promoted",
				input.id,
				`idea:${input.id}:promoted`,
				input.actor,
				{ ticket_id: input.ticketId },
				input.now,
			);
			return rowIdea(
				this.#store.get<IdeaRow>(
					this.#store.queries
						.selectFrom("management_ideas")
						.selectAll()
						.where("id", "=", input.id),
				)!,
			);
		});
	}

	listIdeas(projectId: string): readonly TrackerManagementIdea[] {
		return Object.freeze(
			this.#store
				.all<IdeaRow>(
					this.#store.queries
						.selectFrom("management_ideas")
						.selectAll()
						.where("project_id", "=", projectId)
						.orderBy("created_at", "asc"),
				)
				.map(rowIdea),
		);
	}

	putAsset(
		input: Parameters<TrackerManagementStorageCapability["putAsset"]>[0],
	): TrackerManagementAsset {
		return this.#store.transaction(() => {
			const existing = this.#store.get<AssetRow>(
				this.#store.queries
					.selectFrom("management_assets")
					.selectAll()
					.where("project_id", "=", input.projectId)
					.where("ticket_id", "=", input.ticketId)
					.where("relative_path", "=", input.relativePath),
			);
			if (existing) return rowAsset(existing);
			this.#store.run(
				this.#store.queries.insertInto("management_assets").values({
					id: input.id,
					project_id: input.projectId,
					ticket_id: input.ticketId,
					relative_path: input.relativePath,
					mime_type: input.mimeType,
					byte_size: input.byteSize,
					sha256: input.sha256,
					storage_path: input.storagePath,
					created_at: input.now,
				}),
			);
			this.#record(
				input.projectId,
				"asset.stored",
				input.id,
				`asset:${input.projectId}:${input.ticketId}:${input.relativePath}`,
				input.actor,
				{
					ticket_id: input.ticketId,
					mime_type: input.mimeType,
					byte_size: input.byteSize,
				},
				input.now,
			);
			return rowAsset(
				this.#store.get<AssetRow>(
					this.#store.queries
						.selectFrom("management_assets")
						.selectAll()
						.where("id", "=", input.id),
				)!,
			);
		});
	}

	getAsset(input: {
		readonly id: string;
		readonly projectId: string;
		readonly ticketId: string;
	}): TrackerManagementAsset | undefined {
		const row = this.#store.get<AssetRow>(
			this.#store.queries
				.selectFrom("management_assets")
				.selectAll()
				.where("id", "=", input.id)
				.where("project_id", "=", input.projectId)
				.where("ticket_id", "=", input.ticketId),
		);
		return row ? rowAsset(row) : undefined;
	}

	listAssets(input: {
		readonly projectId: string;
		readonly ticketId: string;
	}): readonly TrackerManagementAsset[] {
		return Object.freeze(
			this.#store
				.all<AssetRow>(
					this.#store.queries
						.selectFrom("management_assets")
						.selectAll()
						.where("project_id", "=", input.projectId)
						.where("ticket_id", "=", input.ticketId)
						.orderBy("created_at", "asc"),
				)
				.map(rowAsset),
		);
	}

	createOperation(
		input: Parameters<TrackerManagementStorageCapability["createOperation"]>[0],
	): TrackerManagementOperation {
		return this.#store.transaction(() => {
			const existing = this.#store.get<OperationRow>(
				this.#store.queries
					.selectFrom("management_operations")
					.selectAll()
					.where("project_id", "=", input.projectId)
					.where("idempotency_key", "=", input.idempotencyKey),
			);
			if (existing) return rowOperation(existing);
			this.#store.run(
				this.#store.queries.insertInto("management_operations").values({
					id: input.id,
					project_id: input.projectId,
					session_id: input.sessionId ?? null,
					generation_id: input.generationId ?? null,
					kind: input.kind,
					command: input.command,
					payload_json: json(input.payload),
					status: "queued",
					actor: input.actor,
					idempotency_key: input.idempotencyKey,
					created_at: input.now,
					updated_at: input.now,
				}),
			);
			this.#record(
				input.projectId,
				`control.${input.command}`,
				input.id,
				`operation:${input.idempotencyKey}`,
				input.actor,
				{
					command: input.command,
					kind: input.kind,
					session_id: input.sessionId ?? null,
					generation_id: input.generationId ?? null,
				},
				input.now,
			);
			return rowOperation(
				this.#store.get<OperationRow>(
					this.#store.queries
						.selectFrom("management_operations")
						.selectAll()
						.where("id", "=", input.id),
				)!,
			);
		});
	}

	getOperation(
		id: string,
		projectId: string,
	): TrackerManagementOperation | undefined {
		const row = this.#store.get<OperationRow>(
			this.#store.queries
				.selectFrom("management_operations")
				.selectAll()
				.where("id", "=", id)
				.where("project_id", "=", projectId),
		);
		return row ? rowOperation(row) : undefined;
	}

	listOperations(projectId: string): readonly TrackerManagementOperation[] {
		return Object.freeze(
			this.#store
				.all<OperationRow>(
					this.#store.queries
						.selectFrom("management_operations")
						.selectAll()
						.where("project_id", "=", projectId)
						.orderBy("created_at", "desc"),
				)
				.map(rowOperation),
		);
	}

	auditManagement(projectId: string): readonly TrackerManagementAuditRecord[] {
		return Object.freeze(
			this.#store
				.all<AuditRow>(
					this.#store.queries
						.selectFrom("management_audit")
						.selectAll()
						.where("project_id", "=", projectId)
						.orderBy("created_at", "desc"),
				)
				.map(rowAudit),
		);
	}
}
