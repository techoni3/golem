import {
	GenerationIdSchema,
	ProjectIdSchema,
	SessionIdSchema,
} from "@golem/contracts";

import {
	canonicalTrackerState,
	initialTrackerPhase,
	TrackerPhaseError,
	validateTrackerPhaseTransition,
} from "../phases/machine.js";
import type {
	TrackerCoreActorContext,
	TrackerCoreComment,
	TrackerCoreExceptionalClose,
	TrackerCoreLink,
	TrackerCoreMutationMetadata,
	TrackerCorePriority,
	TrackerCoreRuntimeReference,
	TrackerCoreStoragePort,
	TrackerCoreWorkItem,
	TrackerCoreWorkItemKind,
} from "../repositories/port.js";
import type { TrackerClock } from "../types.js";

const workItemKinds = new Set<TrackerCoreWorkItemKind>([
	"spec",
	"work-item",
	"question",
	"decision",
	"fix",
]);
const priorities = new Set<TrackerCorePriority>(["P0", "P1", "P2", "P3", null]);

type MutableTicketPatch = {
	-readonly [Key in
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
		| "runtimeReference"]?: TrackerCoreWorkItem[Key];
};

export class TrackerCoreError extends Error {
	constructor(
		readonly code:
			| "tracker.input.invalid"
			| "tracker.not_found"
			| "tracker.conflict"
			| "tracker.runtime_reference.invalid"
			| "tracker.phase.invalid",
		message: string,
	) {
		super(message);
		this.name = "TrackerCoreError";
	}
}

function invalid(message: string): never {
	throw new TrackerCoreError("tracker.input.invalid", message);
}

export function requireTrackerText(value: unknown, field: string): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > 4_096
	)
		invalid(`${field} must be nonblank text up to 4096 characters`);
	return value.trim();
}

export function requireTrackerActor(value: unknown): string {
	return requireTrackerText(value, "actor");
}

function requireRevision(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1)
		invalid("expected revision must be a positive safe integer");
	return value as number;
}

function requireRank(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value))
		invalid("rank must be finite");
	return value;
}

function requireWave(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < 0)
		invalid("wave must be a nonnegative safe integer");
	return value as number;
}

function requireLabels(value: unknown): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) invalid("labels must be an array");
	const labels = value.map((label) => requireTrackerText(label, "label"));
	if (new Set(labels).size !== labels.length) invalid("labels must be unique");
	return Object.freeze(labels);
}

function requireKind(value: unknown): TrackerCoreWorkItemKind {
	if (
		typeof value !== "string" ||
		!workItemKinds.has(value as TrackerCoreWorkItemKind)
	)
		invalid("ticket kind is unsupported");
	return value as TrackerCoreWorkItemKind;
}

function requirePriority(value: unknown): TrackerCorePriority {
	if (value === undefined || value === null) return null;
	if (
		typeof value !== "string" ||
		!priorities.has(value as TrackerCorePriority)
	)
		invalid("ticket priority is unsupported");
	return value as TrackerCorePriority;
}

function phaseForLegacyState(
	kind: TrackerCoreWorkItemKind,
	state: TrackerCoreWorkItem["state"],
	currentPhase: string,
): string {
	if (state === "archived")
		return kind === "spec"
			? "done"
			: kind === "question" || kind === "decision"
				? "closed"
				: "done";
	const preferred: Readonly<
		Record<TrackerCoreWorkItemKind, Readonly<Record<string, string>>>
	> = {
		spec: {
			todo: "drafting",
			in_progress: "designing",
			blocked: "parked",
			review: "designed",
			done: "done",
		},
		"work-item": {
			todo: "queued",
			in_progress: "building",
			blocked: "blocked",
			review: "built",
			done: "done",
		},
		fix: {
			todo: "queued",
			in_progress: "building",
			blocked: "blocked",
			review: "built",
			done: "done",
		},
		question: {
			todo: "open",
			in_progress: "open",
			blocked: "open",
			review: "answered",
			done: "closed",
		},
		decision: {
			todo: "open",
			in_progress: "open",
			blocked: "open",
			review: "decided",
			done: "closed",
		},
	};
	return preferred[kind][state] ?? currentPhase;
}

function runtimeReference(
	value: unknown,
): TrackerCoreRuntimeReference | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TrackerCoreError(
			"tracker.runtime_reference.invalid",
			"runtime reference must be a typed opaque reference",
		);
	const candidate = value as Record<string, unknown>;
	if (!ProjectIdSchema.safeParse(candidate.projectId).success)
		throw new TrackerCoreError(
			"tracker.runtime_reference.invalid",
			"runtime project reference must be an opaque prj_ id",
		);
	if (
		candidate.sessionId !== undefined &&
		!SessionIdSchema.safeParse(candidate.sessionId).success
	)
		throw new TrackerCoreError(
			"tracker.runtime_reference.invalid",
			"runtime session reference must be an opaque ses_ id",
		);
	if (
		candidate.generationId !== undefined &&
		!GenerationIdSchema.safeParse(candidate.generationId).success
	)
		throw new TrackerCoreError(
			"tracker.runtime_reference.invalid",
			"runtime generation reference must be an opaque gen_ id",
		);
	return Object.freeze({
		projectId: candidate.projectId as string,
		...(candidate.sessionId === undefined
			? {}
			: { sessionId: candidate.sessionId as string }),
		...(candidate.generationId === undefined
			? {}
			: { generationId: candidate.generationId as string }),
	});
}

function requireTrustedAuthority(value: unknown): TrackerCoreActorContext {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TrackerCoreError(
			"tracker.phase.invalid",
			"exceptional close requires an authenticated manager or human authority",
		);
	const context = value as Partial<TrackerCoreActorContext>;
	if (
		context.authenticated !== true ||
		(context.role !== "manager" && context.role !== "human") ||
		(context.source !== "dashboard" &&
			context.source !== "mcp" &&
			context.source !== "journey") ||
		typeof context.actor !== "string" ||
		context.actor.trim().length === 0
	)
		throw new TrackerCoreError(
			"tracker.phase.invalid",
			"exceptional close requires an authenticated manager or human authority",
		);
	return Object.freeze({
		actor: context.actor.trim(),
		role: context.role,
		authenticated: true,
		source: context.source,
	});
}

function requireExceptionalClose(value: unknown): TrackerCoreExceptionalClose {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TrackerCoreError(
			"tracker.phase.invalid",
			"exceptional close requires an authenticated manager or human authority",
		);
	const candidate = value as Partial<TrackerCoreExceptionalClose>;
	const reason = requireTrackerText(
		candidate.reason,
		"exceptional close reason",
	);
	return Object.freeze({
		reason,
		actorContext: requireTrustedAuthority(candidate.actorContext),
	});
}

export function createTrackerMutation(
	clock: TrackerClock,
	actor: string,
): TrackerCoreMutationMetadata {
	return Object.freeze({
		actor,
		eventId: `evt_${globalThis.crypto.randomUUID()}`,
		outboxId: `out_${globalThis.crypto.randomUUID()}`,
		auditId: `aud_${globalThis.crypto.randomUUID()}`,
		now: clock.now(),
	});
}

export interface TrackerTicketDetail {
	readonly ticket: TrackerCoreWorkItem;
	readonly comments: readonly TrackerCoreComment[];
	readonly links: readonly TrackerCoreLink[];
}

export interface TrackerTicketService {
	create(input: {
		readonly projectId: string;
		readonly kind?: TrackerCoreWorkItemKind;
		readonly title: string;
		readonly body?: string;
		readonly priority?: TrackerCorePriority;
		readonly labels?: readonly string[];
		readonly streamId?: string;
		readonly parentId?: string;
		readonly assignee?: string;
		readonly rank?: number;
		readonly wave?: number;
		readonly runtimeReference?: TrackerCoreRuntimeReference;
		readonly actor: string;
	}): TrackerCoreWorkItem;
	get(id: string): TrackerTicketDetail | undefined;
	list(input?: {
		readonly projectId?: string;
		readonly kind?: TrackerCoreWorkItemKind;
		readonly phase?: string;
		readonly assignee?: string;
	}): readonly TrackerCoreWorkItem[];
	search(query: string, projectId?: string): readonly TrackerCoreWorkItem[];
	update(input: {
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
		/** A reason is useful for blocked transitions, but never authorizes done. */
		readonly reason?: string;
		readonly exceptionalClose?: TrackerCoreExceptionalClose;
		readonly actor: string;
	}): TrackerCoreWorkItem;
	/** Internal delivery seam; not exposed as a caller-controlled ticket patch. */
	recordDispatch(input: {
		readonly id: string;
		readonly expectedRevision: number;
		readonly dispatchedTo: string;
		readonly assignee?: string;
		readonly actor: string;
	}): TrackerCoreWorkItem;
	transition(input: {
		readonly id: string;
		readonly expectedRevision: number;
		readonly phase: string;
		readonly reason?: string;
		readonly actor: string;
	}): TrackerCoreWorkItem;
	exceptionalClose(input: {
		readonly id: string;
		readonly expectedRevision: number;
		readonly reason: string;
		readonly actorContext: TrackerCoreActorContext;
	}): TrackerCoreWorkItem;
}

export function createTrackerTicketService(options: {
	readonly storage: TrackerCoreStoragePort;
	readonly clock: TrackerClock;
}): TrackerTicketService {
	function requireTicket(id: string): TrackerCoreWorkItem {
		const ticket = options.storage.getWorkItem(
			requireTrackerText(id, "ticket id"),
		);
		if (!ticket)
			throw new TrackerCoreError(
				"tracker.not_found",
				`ticket ${id} does not exist`,
			);
		return ticket;
	}

	const service: TrackerTicketService = {
		create(input: Parameters<TrackerTicketService["create"]>[0]) {
			const kind = requireKind(input.kind ?? "work-item");
			const actor = requireTrackerActor(input.actor);
			const projectId = requireTrackerText(input.projectId, "project id");
			const parentId =
				input.parentId === undefined
					? undefined
					: requireTrackerText(input.parentId, "parent id");
			if (parentId && !options.storage.getWorkItem(parentId))
				throw new TrackerCoreError(
					"tracker.not_found",
					`parent ticket ${parentId} does not exist`,
				);
			const now = options.clock.now();
			const wave =
				input.wave === undefined ? undefined : requireWave(input.wave);
			if (input.runtimeReference !== undefined)
				runtimeReference(input.runtimeReference);
			const item: TrackerCoreWorkItem = Object.freeze({
				// The persistence repository atomically allocates the live TKT id and
				// per-project display id; services never maintain a second sequence.
				id: "pending",
				displayId: "pending",
				projectId,
				kind,
				title: requireTrackerText(input.title, "title"),
				body: input.body ?? "",
				priority: requirePriority(input.priority),
				labels: requireLabels(input.labels),
				...(input.streamId === undefined
					? {}
					: { streamId: requireTrackerText(input.streamId, "stream id") }),
				...(parentId ? { parentId } : {}),
				...(input.assignee === undefined
					? {}
					: { assignee: requireTrackerText(input.assignee, "assignee") }),
				state: canonicalTrackerState(kind, initialTrackerPhase(kind)),
				phase: initialTrackerPhase(kind),
				rank: input.rank === undefined ? 0 : requireRank(input.rank),
				...(wave === undefined ? {} : { wave }),
				revision: 1,
				createdBy: actor,
				createdAt: now,
				updatedAt: now,
			});
			return options.storage.createWorkItem({
				workItem: item,
				mutation: createTrackerMutation(options.clock, actor),
			});
		},
		get(id: string) {
			const ticket = options.storage.getWorkItem(
				requireTrackerText(id, "ticket id"),
			);
			if (!ticket) return undefined;
			return Object.freeze({
				ticket,
				comments: options.storage.listComments(ticket.id),
				links: options.storage.listLinks(ticket.id),
			});
		},
		list(input: Parameters<TrackerTicketService["list"]>[0] = {}) {
			return options.storage.listWorkItems(input);
		},
		search(query: string, projectId?: string) {
			return options.storage.searchWorkItems(
				requireTrackerText(query, "search query"),
				projectId,
			);
		},
		update(input: Parameters<TrackerTicketService["update"]>[0]) {
			const exceptionalClose = input.exceptionalClose
				? requireExceptionalClose(input.exceptionalClose)
				: undefined;
			const actor = exceptionalClose
				? exceptionalClose.actorContext.actor
				: requireTrackerActor(input.actor);
			const expectedRevision = requireRevision(input.expectedRevision);
			const current = requireTicket(input.id);
			const patch: MutableTicketPatch = {};
			if (input.patch.kind !== undefined)
				patch.kind = requireKind(input.patch.kind);
			if (input.patch.state !== undefined) {
				if (
					![
						"todo",
						"in_progress",
						"blocked",
						"review",
						"done",
						"archived",
					].includes(input.patch.state)
				)
					invalid("ticket state is unsupported");
				patch.state = input.patch.state;
			}
			if (input.patch.phase !== undefined)
				patch.phase = requireTrackerText(input.patch.phase, "phase");
			if (input.patch.title !== undefined)
				patch.title = requireTrackerText(input.patch.title, "title");
			if (input.patch.body !== undefined) patch.body = input.patch.body;
			if (input.patch.priority !== undefined)
				patch.priority = requirePriority(input.patch.priority);
			if (input.patch.labels !== undefined)
				patch.labels = requireLabels(input.patch.labels);
			if (input.patch.streamId !== undefined)
				patch.streamId = requireTrackerText(input.patch.streamId, "stream id");
			if (input.patch.parentId !== undefined)
				patch.parentId = requireTrackerText(input.patch.parentId, "parent id");
			if (input.patch.assignee !== undefined)
				patch.assignee = requireTrackerText(input.patch.assignee, "assignee");
			if (input.patch.rank !== undefined)
				patch.rank = requireRank(input.patch.rank);
			if (input.patch.wave !== undefined) {
				const wave = requireWave(input.patch.wave);
				if (wave !== undefined) patch.wave = wave;
			}
			if (input.patch.runtimeReference !== undefined)
				runtimeReference(input.patch.runtimeReference);
			const patchKind = patch.kind ?? current.kind;
			if (patch.state !== undefined && patch.phase === undefined)
				patch.phase = phaseForLegacyState(
					patchKind,
					patch.state,
					current.phase,
				);
			const nextKind = patch.kind ?? current.kind;
			const nextPhase = patch.phase ?? current.phase;
			const lifecycleChanged =
				nextKind !== current.kind ||
				nextPhase !== current.phase ||
				patch.state !== undefined;
			if (exceptionalClose && nextPhase !== "done")
				throw new TrackerCoreError(
					"tracker.phase.invalid",
					"exceptional close must target the done phase",
				);
			if (lifecycleChanged) {
				const durableEvidence = options.storage.phaseEvidence(current.id);
				const artifacts = Object.freeze({
					...durableEvidence,
					// Caller text is never completion evidence; only this typed intent or
					// an already persisted authorization event can satisfy done.
					verifiedOrSkipReason:
						current.phase === "verified" ||
						durableEvidence.managerSkip ||
						Boolean(exceptionalClose),
					reason:
						durableEvidence.reason ||
						(nextPhase === "blocked" &&
							typeof input.reason === "string" &&
							input.reason.trim().length > 0),
				});
				try {
					const canonicalState =
						patch.state === "archived"
							? "archived"
							: canonicalTrackerState(nextKind, nextPhase);
					if (
						patch.state !== "archived" &&
						nextKind === current.kind &&
						nextPhase !== current.phase
					) {
						validateTrackerPhaseTransition({
							kind: nextKind,
							from: current.phase,
							to: nextPhase,
							artifacts,
						});
					}
					patch.state = canonicalState;
				} catch (error) {
					if (error instanceof TrackerPhaseError)
						throw new TrackerCoreError("tracker.phase.invalid", error.message);
					throw error;
				}
			}
			const updated = options.storage.updateWorkItem({
				id: requireTrackerText(input.id, "ticket id"),
				expectedRevision,
				patch,
				mutation: createTrackerMutation(options.clock, actor),
				...(exceptionalClose ? { exceptionalClose } : {}),
			});
			if (!updated)
				throw new TrackerCoreError(
					"tracker.conflict",
					"ticket revision is stale or ticket does not exist",
				);
			return updated;
		},
		recordDispatch(input: Parameters<TrackerTicketService["recordDispatch"]>[0]) {
				const updated = options.storage.recordWorkItemDispatch({
					id: requireTrackerText(input.id, "ticket id"),
					expectedRevision: requireRevision(input.expectedRevision),
					dispatchedTo: requireTrackerText(input.dispatchedTo, "dispatch recipient"),
					...(input.assignee === undefined
						? {}
						: { assignee: requireTrackerText(input.assignee, "assignee") }),
					mutation: createTrackerMutation(
						options.clock,
						requireTrackerActor(input.actor),
					),
				});
			if (!updated)
				throw new TrackerCoreError(
					"tracker.conflict",
					"ticket revision is stale or ticket does not exist",
				);
			return updated;
		},
		transition(input: Parameters<TrackerTicketService["transition"]>[0]) {
			return service.update({
				id: input.id,
				expectedRevision: input.expectedRevision,
				patch: { phase: input.phase },
				...(input.reason === undefined ? {} : { reason: input.reason }),
				actor: input.actor,
			});
		},
		exceptionalClose(input) {
			const actorContext = requireTrustedAuthority(input.actorContext);
			return service.update({
				id: input.id,
				expectedRevision: input.expectedRevision,
				patch: { phase: "done", state: "done" },
				reason: input.reason,
				exceptionalClose: {
					reason: input.reason,
					actorContext,
				},
				actor: actorContext.actor,
			});
		},
	};
	return Object.freeze(service);
}
