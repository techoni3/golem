import { type Kysely, sql } from "kysely";

import type { SqliteConnection, TrackerTables } from "./internals.js";
import { SyncKyselyTrackerStore } from "./kysely-sync.js";
import type {
	TrackerCoreAuditRecord,
	TrackerCoreComment,
	TrackerCoreExceptionalClose,
	TrackerCoreLink,
	TrackerCoreLinkRelation,
	TrackerCoreMutationMetadata,
	TrackerCorePhaseEvidence,
	TrackerCorePriority,
	TrackerCoreResourceType,
	TrackerCoreState,
	TrackerCoreStorageCapability,
	TrackerCoreStream,
	TrackerCoreWorkItem,
	TrackerCoreWorkItemKind,
} from "./types.js";

interface TicketRow {
	readonly id: string;
	readonly seq: number;
	readonly pseq: number;
	readonly display_id: string;
	readonly project_id: string;
	readonly kind: TrackerCoreWorkItemKind;
	readonly title: string;
	readonly body: string;
	readonly state: TrackerCoreState;
	readonly phase: string | null;
	readonly priority: TrackerCorePriority;
	readonly labels: string;
	readonly stream_id: string | null;
	readonly parent_id: string | null;
	readonly assignee: string | null;
	readonly dispatched_to: string | null;
	readonly dispatched_at: string | null;
	readonly source_ref: string | null;
	readonly wave: number | null;
	readonly created_by: string;
	readonly created_at: string;
	readonly updated_at: string;
	readonly state_changed_at: string | null;
	readonly done_at: string | null;
	readonly archived_at: string | null;
	readonly rank: number;
	readonly revision: number;
}

interface CommentRow {
	readonly id: string;
	readonly ticket_id: string;
	readonly author: string;
	readonly body: string;
	readonly quote: string | null;
	readonly prefix: string | null;
	readonly suffix: string | null;
	readonly section: string | null;
	readonly section_id: string | null;
	readonly tag: string;
	readonly status: string;
	readonly dispatch_state: string;
	readonly parent_id: string | null;
	readonly created_at: string;
	readonly updated_at: string;
}

interface EventRow {
	readonly id: number;
	readonly event_uuid: string | null;
	readonly ticket_id: string | null;
	readonly project_id: string | null;
	readonly actor: string | null;
	readonly actor_kind: string | null;
	readonly actor_label: string | null;
	readonly type: string;
	readonly data: string;
	readonly created_at: string;
}

interface TrackerEventInput {
	readonly ticket?: TrackerCoreWorkItem;
	readonly projectId: string;
	readonly type: string;
	readonly resourceType: TrackerCoreResourceType;
	readonly resourceId: string;
	readonly revision?: number;
	readonly details: Readonly<Record<string, unknown>>;
}

function parseLabels(value: string): readonly string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed)
			? Object.freeze(
					parsed.filter((item): item is string => typeof item === "string"),
				)
			: Object.freeze([]);
	} catch {
		return Object.freeze([]);
	}
}

function json(value: unknown): string {
	return JSON.stringify(value);
}

function rowTicket(row: TicketRow): TrackerCoreWorkItem {
	return Object.freeze({
		id: row.id,
		displayId: row.display_id,
		projectId: row.project_id,
		kind: row.kind,
		title: row.title,
		body: row.body,
		priority: row.priority,
		labels: parseLabels(row.labels),
		...(row.stream_id ? { streamId: row.stream_id } : {}),
		...(row.parent_id ? { parentId: row.parent_id } : {}),
		...(row.assignee ? { assignee: row.assignee } : {}),
		...(row.dispatched_to ? { dispatchedTo: row.dispatched_to } : {}),
		...(row.dispatched_at ? { dispatchedAt: row.dispatched_at } : {}),
		state: row.state,
		phase: row.phase ?? "queued",
		rank: Number(row.rank),
		...(row.wave === null ? {} : { wave: Number(row.wave) }),
		revision: Number(row.revision),
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	});
}

function rowComment(row: CommentRow): TrackerCoreComment {
	const anchor = Object.fromEntries(
		Object.entries({
			quote: row.quote,
			prefix: row.prefix,
			suffix: row.suffix,
			section: row.section,
			sectionId: row.section_id,
		}).filter(([, value]) => value !== null),
	);
	return Object.freeze({
		id: row.id,
		ticketId: row.ticket_id,
		...(row.parent_id ? { parentId: row.parent_id } : {}),
		author: row.author,
		body: row.body,
		...(Object.keys(anchor).length ? { anchor } : {}),
		tag: row.tag,
		status: row.status,
		dispatchState: row.dispatch_state,
		revision: 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	});
}

function ticketPrefix(projectId: string): string {
	const slug = projectId.replace(/-[0-9a-f]{6}$/u, "");
	return (slug.slice(0, 3) || "TKT").toUpperCase();
}

function actorKind(actor: string): "human" | "session" | "system" {
	if (!actor) return "system";
	if (
		actor === "system" ||
		actor.startsWith("system:") ||
		actor.startsWith("golem-") ||
		actor === "golem-drainer"
	)
		return "system";
	if (actor === "human" || actor === "you" || actor.startsWith("human:"))
		return "human";
	return "session";
}

function actorLabel(
	actor: string,
	kind: "human" | "session" | "system",
): string {
	const value = actor.trim();
	if (!value) return kind;
	const prefix = `${kind}:`;
	return value.startsWith(prefix) ? value.slice(prefix.length) || kind : value;
}

/**
 * Typed synchronous adapter over the one live tracker authority. Every SQL
 * statement in this class is emitted by a Kysely<TrackerTables> builder; the
 * private sync bridge exists only because the shipped tracker facade is
 * synchronous better-sqlite3 code.
 */
export class TrackerCoreRepository implements TrackerCoreStorageCapability {
	readonly #store: SyncKyselyTrackerStore;

	constructor(queries: Kysely<TrackerTables>, database: SqliteConnection) {
		this.#store = new SyncKyselyTrackerStore(queries, database);
	}

	#ticket(id: string): TicketRow | undefined {
		return this.#store.get<TicketRow>(
			this.#store.queries
				.selectFrom("tickets")
				.select([
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
					sql<number>`coalesce((select max(id) from events where events.ticket_id = tickets.id), 1)`.as(
						"revision",
					),
				])
				.where((eb) =>
					eb.or([eb("tickets.id", "=", id), eb("tickets.display_id", "=", id)]),
				)
				.limit(1),
		);
	}

	#emit(
		input: {
			readonly mutation: TrackerCoreMutationMetadata;
		} & TrackerEventInput,
	): number {
		const actor = input.mutation.actor;
		const kind = actorKind(actor);
		const topic = input.ticket
			? `ticket/${input.ticket.displayId}`
			: `project/${input.projectId}/events`;
		const eventData = {
			event_id: input.mutation.eventId,
			outbox_id: input.mutation.outboxId,
			audit_id: input.mutation.auditId,
			actor_kind: kind,
			actor_label: actorLabel(actor, kind),
			resource_type: input.resourceType,
			resource_id: input.resourceId,
			revision: input.revision ?? input.ticket?.revision ?? 1,
			...input.details,
		};
		const event = this.#store.get<{ readonly id: number }>(
			this.#store.queries
				.insertInto("events")
				.values({
					event_uuid: input.mutation.eventId,
					ticket_id: input.ticket?.id ?? null,
					project_id: input.projectId,
					topic: topic,
					class: "tracker",
					type: input.type,
					actor,
					actor_kind: kind,
					actor_label: actorLabel(actor, kind),
					data: json(eventData),
					created_at: input.mutation.now,
				})
				.returning("id"),
		);
		if (!event) throw new Error("tracker event insert did not return an id");
		this.#store.run(
			this.#store.queries
				.updateTable("events")
				.set({
					data: json({
						...eventData,
						event_id: String(event.id),
						outbox_id: String(event.id),
						audit_id: String(event.id),
						revision: event.id,
					}),
				})
				.where("id", "=", event.id),
		);
		if (input.ticket?.parentId) {
			const parent = this.#ticket(input.ticket.parentId);
			if (parent?.kind === "spec") {
				this.#store.run(
					this.#store.queries.insertInto("events").values({
						event_uuid: null,
						ticket_id: input.ticket.id,
						project_id: input.projectId,
						topic: `spec/${parent.display_id}/tree`,
						class: "tracker",
						type: input.type,
						actor,
						actor_kind: kind,
						actor_label: actorLabel(actor, kind),
						data: json({
							...eventData,
							event_id: String(event.id),
							outbox_id: String(event.id),
							audit_id: String(event.id),
							revision: event.id,
							mirrored_from_topic: topic,
						}),
						created_at: input.mutation.now,
					}),
				);
			}
		}
		return event.id;
	}

	allocateDisplayId(prefix: "GOL" | "TKT"): string {
		return this.#store.transaction(() => {
			const key = `compat:${prefix}:display_seq`;
			const current =
				Number(
					this.#store.get<{ readonly value: string }>(
						this.#store.queries
							.selectFrom("meta")
							.select("value")
							.where("key", "=", key),
					)?.value ?? "0",
				) + 1;
			this.#store.run(
				this.#store.queries
					.insertInto("meta")
					.values({ key, value: String(current) })
					.onConflict((oc) =>
						oc.column("key").doUpdateSet({ value: String(current) }),
					),
			);
			return `${prefix}-${current}`;
		});
	}

	createWorkItem(input: {
		readonly workItem: TrackerCoreWorkItem;
		readonly mutation: TrackerCoreMutationMetadata;
	}): TrackerCoreWorkItem {
		return this.#store.transaction(() => {
			const item = input.workItem;
			const existingPrefix = this.#store.get<{ readonly prefix: string }>(
				this.#store.queries
					.selectFrom("project_prefixes")
					.select("prefix")
					.where("project_id", "=", item.projectId),
			);
			let prefix = existingPrefix?.prefix;
			if (!prefix) {
				const base = ticketPrefix(item.projectId);
				const taken = new Set(
					this.#store
						.all<{ readonly prefix: string }>(
							this.#store.queries
								.selectFrom("project_prefixes")
								.select("prefix"),
						)
						.map((row) => row.prefix),
				);
				prefix = base;
				for (let suffix = 2; taken.has(prefix); suffix += 1)
					prefix = `${base}${suffix}`;
				this.#store.run(
					this.#store.queries
						.insertInto("project_prefixes")
						.values({ project_id: item.projectId, prefix }),
				);
			}
			const ticketSeq =
				Number(
					this.#store.get<{ readonly value: string }>(
						this.#store.queries
							.selectFrom("meta")
							.select("value")
							.where("key", "=", "ticket_seq"),
					)?.value ?? "0",
				) + 1;
			this.#store.run(
				this.#store.queries
					.insertInto("meta")
					.values({ key: "ticket_seq", value: String(ticketSeq) })
					.onConflict((oc) =>
						oc.column("key").doUpdateSet({ value: String(ticketSeq) }),
					),
			);
			const pseqKey = `pseq:${item.projectId}`;
			const projectSeq =
				Number(
					this.#store.get<{ readonly value: string }>(
						this.#store.queries
							.selectFrom("meta")
							.select("value")
							.where("key", "=", pseqKey),
					)?.value ?? "0",
				) + 1;
			this.#store.run(
				this.#store.queries
					.insertInto("meta")
					.values({ key: pseqKey, value: String(projectSeq) })
					.onConflict((oc) =>
						oc.column("key").doUpdateSet({ value: String(projectSeq) }),
					),
			);
			const id = `TKT-${String(ticketSeq).padStart(4, "0")}`;
			const displayId = `${prefix}-${projectSeq}`;
			this.#store.run(
				this.#store.queries.insertInto("tickets").values({
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
					labels: json(item.labels),
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
					rank: item.rank,
				}),
			);
			const stored = this.getWorkItem(id);
			if (!stored) throw new Error("created ticket cannot be read");
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
					title: stored.title,
				},
			});
			const created = this.getWorkItem(id);
			if (!created)
				throw new Error("created ticket cannot be read after event");
			return created;
		});
	}

	getWorkItem(id: string): TrackerCoreWorkItem | undefined {
		const row = this.#ticket(id);
		return row ? rowTicket(row) : undefined;
	}

	phaseEvidence(id: string): TrackerCorePhaseEvidence {
		const current = this.getWorkItem(id);
		const comments = this.#store.all<{
			readonly body: string;
			readonly author: string;
		}>(
			this.#store.queries
				.selectFrom("comments")
				.select(["body", "author"])
				.where("ticket_id", "=", id),
		);
		const children = this.#store.all<{ readonly state: string }>(
			this.#store.queries
				.selectFrom("tickets")
				.select("state")
				.where("parent_id", "=", id),
		);
		const waves = this.#store.get<{ readonly count: number }>(
			this.#store.queries
				.selectFrom("tickets")
				.select((eb) => eb.fn.count("id").as("count"))
				.where("parent_id", "=", id)
				.where("wave", "is not", null),
		);
		const authorizationEvents = this.#store.all<EventRow>(
			this.#store.queries
				.selectFrom("events")
				.select([
					"id",
					"event_uuid",
					"ticket_id",
					"project_id",
					"actor",
					"actor_kind",
					"actor_label",
					"type",
					"data",
					"created_at",
				])
				.where("ticket_id", "=", id)
				.where("type", "=", "manager_skip_authorized"),
		);
		const hasComment = (pattern: RegExp) =>
			comments.some((comment) => pattern.test(comment.body));
		return Object.freeze({
			closingBrief: hasComment(/closing\s+brief/iu),
			verificationReport: hasComment(/verification|verify-done|smoke|test/iu),
			answerComment: comments.length > 0,
			decisionComment: hasComment(/decision|decided/iu),
			reason: hasComment(/reason|blocked/iu),
			groundingSummary: hasComment(/grounding|grounded/iu),
			design: hasComment(/design/iu),
			concerns: hasComment(/concern/iu),
			humanFinalise: comments.some(
				(comment) =>
					(comment.author === "human" || comment.author.startsWith("human:")) &&
					/finali[sz]e|manager/iu.test(comment.body),
			),
			children: children.length > 0,
			childrenTerminal:
				children.length > 0 &&
				children.every(
					(child) => child.state === "done" || child.state === "archived",
				),
			waves: Number(waves?.count ?? 0) > 0,
			childStarted: children.some((child) => child.state !== "todo"),
			managerDispatch: Boolean(this.getWorkItem(id)?.dispatchedTo),
			managerSkip: authorizationEvents.some((event) => {
				try {
					const details = JSON.parse(event.data) as Record<string, unknown>;
					return (
						details.target_phase === "done" &&
						details.authenticated === true &&
						// Exceptional close is one-step and CAS-bound. The
						// authorization event itself advances the canonical revision,
						// so historic evidence can never be replayed after closure or
						// resurrection. Keep the explicit equality checks here as a
						// defense-in-depth guard for any future two-step adapter.
						event.id === current?.revision &&
						details.current_revision === current?.revision &&
						details.source_phase === current?.phase &&
						details.consumed !== true &&
						(details.role === "human" || details.role === "manager")
					);
				} catch {
					return false;
				}
			}),
		});
	}

	listWorkItems(
		input: {
			readonly projectId?: string;
			readonly kind?: TrackerCoreWorkItemKind;
			readonly phase?: string;
			readonly assignee?: string;
		} = {},
	): readonly TrackerCoreWorkItem[] {
		let query = this.#store.queries
			.selectFrom("tickets")
			.select([
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
				sql<number>`coalesce((select max(id) from events where events.ticket_id = tickets.id), 1)`.as(
					"revision",
				),
			]);
		if (input.projectId !== undefined)
			query = query.where("tickets.project_id", "=", input.projectId);
		if (input.kind !== undefined)
			query = query.where("tickets.kind", "=", input.kind);
		if (input.phase !== undefined)
			query = query.where("tickets.phase", "=", input.phase);
		if (input.assignee !== undefined)
			query = query.where("tickets.assignee", "=", input.assignee);
		return Object.freeze(
			this.#store
				.all<TicketRow>(query.orderBy("tickets.seq", "asc"))
				.map(rowTicket),
		);
	}

	searchWorkItems(
		query: string,
		projectId?: string,
	): readonly TrackerCoreWorkItem[] {
		const term = `%${query.replace(/[\\%_]/gu, "\\$&")}%`;
		let builder = this.#store.queries
			.selectFrom("tickets")
			.select([
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
				sql<number>`coalesce((select max(id) from events where events.ticket_id = tickets.id), 1)`.as(
					"revision",
				),
			])
			.where((eb) =>
				eb.or([
					eb("tickets.title", "like", term),
					eb("tickets.body", "like", term),
					eb("tickets.display_id", "like", term),
				]),
			);
		if (projectId !== undefined)
			builder = builder.where("tickets.project_id", "=", projectId);
		return Object.freeze(
			this.#store
				.all<TicketRow>(builder.orderBy("tickets.updated_at", "desc"))
				.map(rowTicket),
		);
	}

	updateWorkItem(input: {
		readonly id: string;
		readonly expectedRevision: number;
		readonly patch: Partial<
			Pick<
				TrackerCoreWorkItem,
				| "kind"
				| "state"
				| "phase"
				| "title"
				| "body"
				| "priority"
				| "labels"
				| "streamId"
				| "parentId"
				| "assignee"
				| "rank"
				| "wave"
				| "runtimeReference"
			>
		>;
		readonly mutation: TrackerCoreMutationMetadata;
		readonly exceptionalClose?: TrackerCoreExceptionalClose;
	}): TrackerCoreWorkItem | undefined {
		return this.#store.transaction(() => {
			const current = this.getWorkItem(input.id);
			if (!current) return undefined;
			if (current.revision !== input.expectedRevision) return undefined;
			const patch = input.patch;
			const nextKind = patch.kind ?? current.kind;
			const nextPhase = patch.phase ?? current.phase;
			const nextState = patch.state ?? current.state;
			const stateChanged = nextState !== current.state;
			const phaseChanged = nextPhase !== current.phase;
			const assigneeChanged =
				patch.assignee !== undefined && patch.assignee !== current.assignee;
			const changedFields = Object.keys(patch).filter((field) => {
				const key = field as keyof typeof patch;
				return patch[key] !== current[key as keyof TrackerCoreWorkItem];
			});
			const lifecycleFields = {
				...(patch.kind === undefined ? {} : { kind: nextKind }),
				...(patch.state === undefined ? {} : { state: nextState }),
				...(patch.phase === undefined ? {} : { phase: nextPhase }),
			};
			if (input.exceptionalClose) {
				const context = input.exceptionalClose.actorContext;
				if (
					context.authenticated !== true ||
					(context.role !== "human" && context.role !== "manager") ||
					typeof context.actor !== "string" ||
					context.actor.trim().length === 0 ||
					typeof input.exceptionalClose.reason !== "string" ||
					input.exceptionalClose.reason.trim().length === 0
				)
					throw new Error(
						"tracker exceptional close requires trusted authority",
					);
			}
			let eventOrdinal = 0;
			const emit = (event: TrackerEventInput) => {
				eventOrdinal += 1;
				const suffix = eventOrdinal === 1 ? "" : `-${eventOrdinal}`;
				return this.#emit({
					...event,
					mutation: {
						...input.mutation,
						eventId: `${input.mutation.eventId}${suffix}`,
						outboxId: `${input.mutation.outboxId}${suffix}`,
						auditId: `${input.mutation.auditId}${suffix}`,
					},
				});
			};
			const changed = this.#store.run(
				this.#store.queries
					.updateTable("tickets")
					.set({
						...lifecycleFields,
						...(patch.title === undefined ? {} : { title: patch.title }),
						...(patch.body === undefined ? {} : { body: patch.body }),
						...(patch.priority === undefined
							? {}
							: { priority: patch.priority }),
						...(patch.labels === undefined
							? {}
							: { labels: json(patch.labels) }),
						...(patch.streamId === undefined
							? {}
							: { stream_id: patch.streamId }),
						...(patch.parentId === undefined
							? {}
							: { parent_id: patch.parentId }),
						...(patch.assignee === undefined
							? {}
							: { assignee: patch.assignee }),
						...(patch.rank === undefined ? {} : { rank: patch.rank }),
						...(patch.wave === undefined ? {} : { wave: patch.wave }),
						...(stateChanged ? { state_changed_at: input.mutation.now } : {}),
						...(stateChanged && nextState === "done"
							? { done_at: input.mutation.now }
							: {}),
						...(stateChanged && nextState === "archived"
							? { archived_at: input.mutation.now }
							: {}),
						updated_at: input.mutation.now,
					})
					.where("tickets.id", "=", current.id),
			);
			if (changed.changes !== 1) return undefined;
			const stored = this.getWorkItem(current.id);
			if (!stored) throw new Error("updated ticket cannot be read");
			let emittedEvent = false;
			let completionEventId: number | undefined;
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
						reason: input.exceptionalClose.reason.trim(),
					},
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
						to_phase: nextPhase,
					},
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
						state: nextState,
					},
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
						to: patch.assignee ?? null,
					},
				});
				emittedEvent = true;
			}
			if (stateChanged || phaseChanged) {
				const actorForms = [
					input.mutation.actor,
					input.mutation.actor.replace(/^session:/u, ""),
					input.mutation.actor.replace(/^human:/u, ""),
				].filter(Boolean);
				this.#store.run(
					this.#store.queries
						.updateTable("comment_dispatches")
						.set({ status: "addressed", addressed_at: input.mutation.now })
						.where("ticket_id", "=", current.id)
						.where("status", "in", ["pending", "delivered"])
						.where("session_id", "in", actorForms),
				);
				const dispatchedComments = this.#store.all<{
					readonly comment_id: string;
				}>(
					this.#store.queries
						.selectFrom("comment_dispatches")
						.select("comment_id")
						.where("ticket_id", "=", current.id),
				);
				for (const { comment_id: commentId } of dispatchedComments) {
					const outstanding = this.#store.get<{ readonly count: number }>(
						this.#store.queries
							.selectFrom("comment_dispatches")
							.select((eb) => eb.fn.count("id").as("count"))
							.where("comment_id", "=", commentId)
							.where("status", "in", ["pending", "delivered"]),
					);
					if (Number(outstanding?.count ?? 0) === 0)
						this.#store.run(
							this.#store.queries
								.updateTable("comments")
								.set({
									dispatch_state: "addressed",
									updated_at: input.mutation.now,
								})
								.where("id", "=", commentId)
								.where("dispatch_state", "!=", "n/a"),
						);
				}
			}
			if (
				["built", "verified", "rejected", "done"].includes(nextPhase) &&
				(input.exceptionalClose !== undefined ||
					input.mutation.actor !== "human")
			) {
				completionEventId = emit({
					ticket: stored,
					projectId: stored.projectId,
					type: "dispatch_completion_stamped",
					resourceType: "ticket",
					resourceId: stored.id,
					details: { phase: nextPhase },
				});
				/* The completion event id is the exact canonical event used for settlement. */
				emittedEvent = true;
			}
			if (!emittedEvent && changedFields.length > 0) {
				emit({
					ticket: stored,
					projectId: stored.projectId,
					type: "updated",
					resourceType: "ticket",
					resourceId: stored.id,
					details: { fields: changedFields.sort() },
				});
			}
			if (
				["built", "verified", "rejected", "done"].includes(nextPhase) &&
				(input.exceptionalClose !== undefined ||
					input.mutation.actor !== "human")
			) {
				this.#store.run(
					this.#store.queries
						.updateTable("message_envelopes")
						.set({
							completed_at: input.mutation.now,
							completed_event_id: completionEventId ?? null,
						})
						.where("ticket_id", "=", current.id)
						.where("recipient_session_id", "=", input.mutation.actor)
						.where("delivery_attempted_at", "is not", null)
						.where("completed_at", "is", null),
				);
			}
			return this.getWorkItem(current.id) ?? stored;
		});
	}

	transitionWorkItem(input: {
		readonly id: string;
		readonly expectedRevision: number;
		readonly phase: string;
		readonly state: TrackerCoreState;
		readonly artifacts: Readonly<Record<string, unknown>>;
		readonly mutation: TrackerCoreMutationMetadata;
	}): TrackerCoreWorkItem | undefined {
		return this.#store.transaction(() => {
			const current = this.getWorkItem(input.id);
			if (!current) return undefined;
			if (current.revision !== input.expectedRevision) return undefined;
			const changed = this.#store.run(
				this.#store.queries
					.updateTable("tickets")
					.set({
						phase: input.phase,
						state: input.state,
						updated_at: input.mutation.now,
						state_changed_at: input.mutation.now,
					})
					.where("tickets.id", "=", current.id),
			);
			if (changed.changes !== 1) return undefined;
			const stored = this.getWorkItem(current.id);
			if (!stored) throw new Error("transitioned ticket cannot be read");
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
					artifacts: input.artifacts,
				},
			});
			return this.getWorkItem(current.id) ?? stored;
		});
	}

	createComment(input: {
		readonly comment: TrackerCoreComment;
		readonly mutation: TrackerCoreMutationMetadata;
	}): TrackerCoreComment {
		return this.#store.transaction(() => {
			const value = input.comment;
			const anchor = value.anchor ?? {};
			this.#store.run(
				this.#store.queries.insertInto("comments").values({
					id: value.id,
					ticket_id: value.ticketId,
					author: value.author,
					body: value.body,
					quote: typeof anchor.quote === "string" ? anchor.quote : null,
					prefix: typeof anchor.prefix === "string" ? anchor.prefix : null,
					suffix: typeof anchor.suffix === "string" ? anchor.suffix : null,
					section: typeof anchor.section === "string" ? anchor.section : null,
					section_id:
						typeof anchor.sectionId === "string" ? anchor.sectionId : null,
					tag: value.tag,
					status: value.status,
					dispatch_state: value.dispatchState,
					parent_id: value.parentId ?? null,
					created_at: value.createdAt,
					updated_at: value.updatedAt,
				}),
			);
			const ticket = this.getWorkItem(value.ticketId);
			if (!ticket) throw new Error("comment ticket cannot be read");
			this.#emit({
				mutation: input.mutation,
				...(ticket ? { ticket } : {}),
				projectId: ticket.projectId,
				type: value.parentId ? "comment_replied" : "comment_created",
				resourceType: "comment",
				resourceId: value.id,
				details: { comment_id: value.id, parent_id: value.parentId ?? null },
			});
			return value;
		});
	}

	getComment(id: string): TrackerCoreComment | undefined {
		const row = this.#store.get<CommentRow>(
			this.#store.queries
				.selectFrom("comments")
				.selectAll()
				.where("id", "=", id),
		);
		return row ? rowComment(row) : undefined;
	}

	updateComment(input: {
		readonly ticketId: string;
		readonly commentId: string;
		readonly patch: Partial<
			Pick<TrackerCoreComment, "body" | "tag" | "status" | "dispatchState">
		>;
		readonly mutation: TrackerCoreMutationMetadata;
	}): TrackerCoreComment | undefined {
		return this.#store.transaction(() => {
			const changed = this.#store.run(
				this.#store.queries
					.updateTable("comments")
					.set({
						...(input.patch.body === undefined
							? {}
							: { body: input.patch.body }),
						...(input.patch.tag === undefined ? {} : { tag: input.patch.tag }),
						...(input.patch.status === undefined
							? {}
							: { status: input.patch.status }),
						...(input.patch.dispatchState === undefined
							? {}
							: { dispatch_state: input.patch.dispatchState }),
						updated_at: input.mutation.now,
					})
					.where("id", "=", input.commentId)
					.where("ticket_id", "=", input.ticketId),
			);
			if (changed.changes !== 1) return undefined;
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
					details: { comment_id: comment.id },
				});
			return comment;
		});
	}

	listComments(ticketId: string): readonly TrackerCoreComment[] {
		return Object.freeze(
			this.#store
				.all<CommentRow>(
					this.#store.queries
						.selectFrom("comments")
						.selectAll()
						.where("ticket_id", "=", ticketId)
						.orderBy("created_at", "asc")
						.orderBy("id", "asc"),
				)
				.map(rowComment),
		);
	}

	createLink(input: {
		readonly link: TrackerCoreLink;
		readonly mutation: TrackerCoreMutationMetadata;
	}): TrackerCoreLink {
		return this.#store.transaction(() => {
			const value = input.link;
			this.#store.run(
				this.#store.queries.insertInto("links").values({
					from_ticket: value.ticketId,
					to_ticket: value.targetTicketId,
					type: value.relation,
				}),
			);
			const ticket = this.getWorkItem(value.ticketId);
			if (!ticket) throw new Error("link ticket cannot be read");
			this.#emit({
				mutation: input.mutation,
				ticket,
				projectId: ticket.projectId,
				type: "link_created",
				resourceType: "link",
				resourceId: value.id,
				details: {
					from_ticket: value.ticketId,
					to_ticket: value.targetTicketId,
					type: value.relation,
				},
			});
			return value;
		});
	}

	deleteLink(input: {
		readonly ticketId: string;
		readonly targetTicketId: string;
		readonly relation: TrackerCoreLinkRelation;
		readonly mutation: TrackerCoreMutationMetadata;
	}): boolean {
		return this.#store.transaction(() => {
			const deleted = this.#store.run(
				this.#store.queries
					.deleteFrom("links")
					.where("from_ticket", "=", input.ticketId)
					.where("to_ticket", "=", input.targetTicketId)
					.where("type", "=", input.relation),
			);
			if (deleted.changes !== 1) return false;
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
						type: input.relation,
					},
				});
			return true;
		});
	}

	listLinks(ticketId: string): readonly TrackerCoreLink[] {
		const rows = this.#store.all<{
			readonly from_ticket: string;
			readonly to_ticket: string;
			readonly type: TrackerCoreLinkRelation;
		}>(
			this.#store.queries
				.selectFrom("links")
				.select(["from_ticket", "to_ticket", "type"])
				.where((eb) =>
					eb.or([
						eb("from_ticket", "=", ticketId),
						eb("to_ticket", "=", ticketId),
					]),
				)
				.orderBy("type", "asc"),
		);
		return Object.freeze(
			rows.map((row) =>
				Object.freeze({
					id: `${row.from_ticket}:${row.to_ticket}:${row.type}`,
					ticketId: row.from_ticket,
					targetTicketId: row.to_ticket,
					relation: row.type,
					actor: "legacy",
					createdAt: "",
				}),
			),
		);
	}

	upsertStream(input: {
		readonly stream: TrackerCoreStream;
		readonly expectedRevision?: number;
		readonly mutation: TrackerCoreMutationMetadata;
	}): TrackerCoreStream | undefined {
		return this.#store.transaction(() => {
			const existing = this.#store.get<{ readonly id: string }>(
				this.#store.queries
					.selectFrom("streams")
					.select("id")
					.where("id", "=", input.stream.id),
			);
			const currentRevision = Number(
				this.#store.get<{ readonly revision: number }>(
					this.#store.queries
						.selectFrom("events")
						.select((_eb) => sql<number>`coalesce(max(id), 1)`.as("revision"))
						.where(
							sql<boolean>`json_extract(data, '$.stream_id') = ${input.stream.id}`,
						),
				)?.revision ?? 1,
			);
			if (
				(existing &&
					input.expectedRevision !== undefined &&
					input.expectedRevision !== currentRevision) ||
				(!existing && input.expectedRevision !== undefined)
			)
				return undefined;
			if (existing) {
				this.#store.run(
					this.#store.queries
						.updateTable("streams")
						.set({
							name: input.stream.name,
							mode: input.stream.mode,
							description: input.stream.description,
							updated_at: input.mutation.now,
						})
						.where("id", "=", input.stream.id),
				);
			} else {
				this.#store.run(
					this.#store.queries.insertInto("streams").values({
						id: input.stream.id,
						project_id: input.stream.projectId,
						name: input.stream.name,
						mode: input.stream.mode,
						description: input.stream.description,
						created_at: input.stream.createdAt,
						updated_at: input.mutation.now,
					}),
				);
			}
			const row = this.#store.get<{
				readonly id: string;
				readonly project_id: string;
				readonly name: string;
				readonly mode: TrackerCoreStream["mode"];
				readonly description: string;
				readonly created_at: string;
				readonly updated_at: string;
				readonly revision: number;
			}>(
				this.#store.queries
					.selectFrom("streams")
					.select([
						"streams.id",
						"streams.project_id",
						"streams.name",
						"streams.mode",
						"streams.description",
						"streams.created_at",
						"streams.updated_at",
						sql<number>`coalesce((select max(id) from events where json_extract(events.data, '$.stream_id') = streams.id), 1)`.as(
							"revision",
						),
					])
					.where("id", "=", input.stream.id),
			);
			if (!row) return undefined;
			const stream = Object.freeze({
				id: row.id,
				projectId: row.project_id,
				name: row.name,
				mode: row.mode,
				description: row.description,
				revision: existing ? currentRevision + 1 : 1,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			});
			this.#emit({
				mutation: input.mutation,
				projectId: stream.projectId,
				revision: stream.revision,
				type: existing ? "stream_updated" : "stream_created",
				resourceType: "stream",
				resourceId: stream.id,
				details: { stream_id: stream.id },
			});
			return (
				this.listStreams(stream.projectId).find(
					(item) => item.id === stream.id,
				) ?? stream
			);
		});
	}

	listStreams(projectId?: string): readonly TrackerCoreStream[] {
		let query = this.#store.queries
			.selectFrom("streams")
			.select([
				"streams.id",
				"streams.project_id",
				"streams.name",
				"streams.mode",
				"streams.description",
				"streams.created_at",
				"streams.updated_at",
				sql<number>`coalesce((select max(id) from events where json_extract(events.data, '$.stream_id') = streams.id), 1)`.as(
					"revision",
				),
			]);
		if (projectId !== undefined)
			query = query.where("streams.project_id", "=", projectId);
		const rows = this.#store.all<{
			readonly id: string;
			readonly project_id: string;
			readonly name: string;
			readonly mode: TrackerCoreStream["mode"];
			readonly description: string;
			readonly created_at: string;
			readonly updated_at: string;
			readonly revision: number;
		}>(query.orderBy("created_at", "asc").orderBy("id", "asc"));
		return Object.freeze(
			rows.map((row) =>
				Object.freeze({
					id: row.id,
					projectId: row.project_id,
					name: row.name,
					mode: row.mode,
					description: row.description,
					revision: Number(row.revision),
					createdAt: row.created_at,
					updatedAt: row.updated_at,
				}),
			),
		);
	}

	auditCore(): readonly TrackerCoreAuditRecord[] {
		const rows = this.#store.all<EventRow>(
			this.#store.queries
				.selectFrom("events")
				.select([
					"id",
					"event_uuid",
					"ticket_id",
					"project_id",
					"actor",
					"actor_kind",
					"actor_label",
					"type",
					"data",
					"created_at",
				])
				.where("class", "=", "tracker")
				.where("event_uuid", "is not", null)
				.orderBy("id", "asc"),
		);
		return Object.freeze(
			rows.map((row) => {
				let details: Record<string, unknown> = {};
				try {
					details = JSON.parse(row.data) as Record<string, unknown>;
				} catch {
					/* legacy bytes remain observable */
				}
				return Object.freeze({
					id: String(details.audit_id ?? row.event_uuid ?? row.id),
					actor: row.actor ?? "system",
					action: row.type,
					resourceType:
						(details.resource_type as TrackerCoreResourceType | undefined) ??
						"ticket",
					resourceId: String(details.resource_id ?? row.ticket_id ?? ""),
					revision: Number(details.revision ?? 0),
					details,
					createdAt: row.created_at,
				});
			}),
		);
	}
}
