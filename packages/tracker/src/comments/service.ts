import type {
	TrackerCoreComment,
	TrackerCoreStoragePort,
} from "../repositories/port.js";
import {
	createTrackerMutation,
	requireTrackerActor,
	requireTrackerText,
	TrackerCoreError,
} from "../tickets/service.js";
import type { TrackerClock } from "../types.js";

function anchor(value: unknown): Readonly<Record<string, unknown>> | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TrackerCoreError(
			"tracker.input.invalid",
			"comment anchor must be an object",
		);
	return Object.freeze({ ...(value as Record<string, unknown>) });
}

export interface TrackerCommentService {
	add(input: {
		readonly ticketId: string;
		readonly author: string;
		readonly body: string;
		readonly anchor?: Readonly<Record<string, unknown>>;
		readonly tag?: string;
		readonly status?: string;
		readonly dispatchState?: string;
	}): TrackerCoreComment;
	update(input: {
		readonly ticketId: string;
		readonly commentId: string;
		readonly patch: Partial<
			Pick<TrackerCoreComment, "body" | "tag" | "status" | "dispatchState">
		>;
		readonly actor: string;
	}): TrackerCoreComment;
	reply(input: {
		readonly ticketId: string;
		readonly parentId: string;
		readonly author: string;
		readonly body: string;
	}): TrackerCoreComment;
}

export function createTrackerCommentService(options: {
	readonly storage: TrackerCoreStoragePort;
	readonly clock: TrackerClock;
}): TrackerCommentService {
	function add(input: {
		readonly ticketId: string;
		readonly parentId?: string;
		readonly author: string;
		readonly body: string;
		readonly anchor?: Readonly<Record<string, unknown>>;
		readonly tag?: string;
		readonly status?: string;
		readonly dispatchState?: string;
	}): TrackerCoreComment {
		const ticketId = requireTrackerText(input.ticketId, "ticket id");
		if (!options.storage.getWorkItem(ticketId))
			throw new TrackerCoreError(
				"tracker.not_found",
				`ticket ${ticketId} does not exist`,
			);
		const parentId =
			input.parentId === undefined
				? undefined
				: requireTrackerText(input.parentId, "parent comment id");
		if (parentId) {
			const parent = options.storage.getComment(parentId);
			if (!parent || parent.ticketId !== ticketId)
				throw new TrackerCoreError(
					"tracker.not_found",
					"comment parent does not belong to this ticket",
				);
		}
		const now = options.clock.now();
		const author = requireTrackerActor(input.author);
		const commentAnchor =
			input.anchor === undefined ? undefined : anchor(input.anchor);
		const comment: TrackerCoreComment = Object.freeze({
			id: `cmt_${globalThis.crypto.randomUUID()}`,
			ticketId,
			...(parentId ? { parentId } : {}),
			author,
			body: requireTrackerText(input.body, "comment body"),
			...(commentAnchor === undefined ? {} : { anchor: commentAnchor }),
			tag:
				input.tag === undefined
					? "note"
					: requireTrackerText(input.tag, "comment tag"),
			status:
				input.status === undefined
					? "open"
					: requireTrackerText(input.status, "comment status"),
			dispatchState:
				input.dispatchState === undefined
					? "undispatched"
					: requireTrackerText(input.dispatchState, "comment dispatch state"),
			revision: 1,
			createdAt: now,
			updatedAt: now,
		});
		return options.storage.createComment({
			comment,
			mutation: createTrackerMutation(options.clock, author),
		});
	}

	const service: TrackerCommentService = {
		add,
		update(input: Parameters<TrackerCommentService["update"]>[0]) {
			const actor = requireTrackerActor(input.actor);
			const patch = {
				...(input.patch.body === undefined
					? {}
					: { body: requireTrackerText(input.patch.body, "comment body") }),
				...(input.patch.tag === undefined
					? {}
					: { tag: requireTrackerText(input.patch.tag, "comment tag") }),
				...(input.patch.status === undefined
					? {}
					: {
							status: requireTrackerText(input.patch.status, "comment status"),
						}),
				...(input.patch.dispatchState === undefined
					? {}
					: {
							dispatchState: requireTrackerText(
								input.patch.dispatchState,
								"comment dispatch state",
							),
						}),
			};
			const updated = options.storage.updateComment({
				ticketId: requireTrackerText(input.ticketId, "ticket id"),
				commentId: requireTrackerText(input.commentId, "comment id"),
				patch,
				mutation: createTrackerMutation(options.clock, actor),
			});
			if (!updated)
				throw new TrackerCoreError(
					"tracker.not_found",
					"comment does not exist",
				);
			return updated;
		},
		reply(input: Parameters<TrackerCommentService["reply"]>[0]) {
			return add(input);
		},
	};
	return Object.freeze(service);
}
