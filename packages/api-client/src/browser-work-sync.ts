import {
	BrowserOpaqueIdSchema,
	BrowserWorkDetailResponseSchema,
	type BrowserWorkProjectionResponse,
	BrowserWorkProjectionResponseSchema,
	type BrowserWorkStream,
	type BrowserWorkWebSocketFrame,
	BrowserWorkWebSocketFrameSchema,
} from "@golem/contracts";

type BrowserWorkDetailResponse = ReturnType<
	typeof BrowserWorkDetailResponseSchema.parse
>;

export type BrowserWorkAuthoritativeSnapshot =
	| BrowserWorkProjectionResponse
	| BrowserWorkDetailResponse;

export type BrowserWorkResourceKey =
	| Readonly<{ kind: "stream"; stream: BrowserWorkStream }>
	| Readonly<{ kind: "detail"; opaque_id: string }>;

export type BrowserWorkInvalidationTag =
	| "delta"
	| "conflict"
	| "command_completion"
	| "detail_invalidation"
	| "disconnect"
	| "instance_changed"
	| "cursor_gap"
	| "cursor_compacted"
	| "policy_changed"
	| "protocol_mismatch"
	| "malformed_frame"
	| "stale_epoch";

export interface BrowserWorkSyncState {
	readonly key: BrowserWorkResourceKey;
	readonly instance_id?: BrowserWorkWebSocketFrame["instance_id"];
	readonly cursor?: string;
	readonly sequence?: number;
	readonly resource_revision?: number;
	readonly invalidation_tags: readonly BrowserWorkInvalidationTag[];
}

export interface BrowserWorkSynchronizer {
	state(): BrowserWorkSyncState;
	consume(raw: string): Promise<void>;
	invalidate(tag: BrowserWorkInvalidationTag): Promise<void>;
	disconnect(): Promise<void>;
}

type SnapshotSource = "http" | "ws";

function checkedKey(key: BrowserWorkResourceKey): BrowserWorkResourceKey {
	return key.kind === "stream"
		? Object.freeze({ kind: "stream", stream: key.stream })
		: Object.freeze({
				kind: "detail",
				opaque_id: BrowserOpaqueIdSchema.parse(key.opaque_id),
			});
}

function appendTag(
	tags: readonly BrowserWorkInvalidationTag[],
	tag: BrowserWorkInvalidationTag,
): readonly BrowserWorkInvalidationTag[] {
	return tags.includes(tag) ? tags : Object.freeze([...tags, tag]);
}

function discardsCursor(tag: BrowserWorkInvalidationTag): boolean {
	return (
		tag === "disconnect" ||
		tag === "instance_changed" ||
		tag === "cursor_gap" ||
		tag === "cursor_compacted" ||
		tag === "policy_changed" ||
		tag === "protocol_mismatch" ||
		tag === "malformed_frame" ||
		tag === "stale_epoch"
	);
}

function resyncTag(
	frame: BrowserWorkWebSocketFrame,
): BrowserWorkInvalidationTag | undefined {
	if (frame.payload.kind !== "resync_required") return undefined;
	return frame.payload.reason;
}

/**
 * Coordinates one browser-work resource without retaining its domain payload.
 * WebSocket snapshots replace truth; every delta or invalidation refetches the
 * generated HTTP resource. Concurrent older HTTP results are discarded.
 */
export function createBrowserWorkSynchronizer(options: {
	readonly key: BrowserWorkResourceKey;
	readonly refetch: (
		key: BrowserWorkResourceKey,
	) => Promise<BrowserWorkAuthoritativeSnapshot>;
	readonly onSnapshot: (
		snapshot: BrowserWorkAuthoritativeSnapshot,
		source: SnapshotSource,
	) => void;
	readonly onInvalidation?: (
		tag: BrowserWorkInvalidationTag,
		state: BrowserWorkSyncState,
	) => void;
}): BrowserWorkSynchronizer {
	const key = checkedKey(options.key);
	let instanceId: BrowserWorkWebSocketFrame["instance_id"] | undefined;
	let cursor: string | undefined;
	let sequence: number | undefined;
	let resourceRevision: number | undefined;
	let invalidationTags: readonly BrowserWorkInvalidationTag[] = Object.freeze(
		[],
	);
	let epoch = 0;

	const state = (): BrowserWorkSyncState =>
		Object.freeze({
			key,
			...(instanceId === undefined ? {} : { instance_id: instanceId }),
			...(cursor === undefined ? {} : { cursor }),
			...(sequence === undefined ? {} : { sequence }),
			...(resourceRevision === undefined
				? {}
				: { resource_revision: resourceRevision }),
			invalidation_tags: invalidationTags,
		});

	const noteInvalidation = (tag: BrowserWorkInvalidationTag) => {
		invalidationTags = appendTag(invalidationTags, tag);
		options.onInvalidation?.(tag, state());
	};

	const validateSnapshot = (
		snapshot: BrowserWorkAuthoritativeSnapshot,
	): BrowserWorkAuthoritativeSnapshot => {
		if (key.kind === "stream") {
			const projection = BrowserWorkProjectionResponseSchema.parse(snapshot);
			if (projection.stream !== key.stream)
				throw new Error("browser-work refetch returned the wrong stream");
			return projection;
		}
		const detail = BrowserWorkDetailResponseSchema.parse(snapshot);
		if (detail.item.opaque_id !== key.opaque_id)
			throw new Error("browser-work refetch returned the wrong detail");
		return detail;
	};

	const refetch = async (tag: BrowserWorkInvalidationTag): Promise<void> => {
		const refetchEpoch = ++epoch;
		resourceRevision = undefined;
		if (discardsCursor(tag)) {
			instanceId = undefined;
			cursor = undefined;
			sequence = undefined;
		}
		noteInvalidation(tag);
		const snapshot = validateSnapshot(await options.refetch(key));
		if (epoch !== refetchEpoch) {
			noteInvalidation("stale_epoch");
			await refetch("stale_epoch");
			return;
		}
		resourceRevision =
			snapshot.schema_version === "golem.browser-work-projection/v1"
				? snapshot.resource_revision
				: snapshot.item.revision;
		invalidationTags = Object.freeze([]);
		options.onSnapshot(snapshot, "http");
	};

	const consumeFrame = async (
		frame: BrowserWorkWebSocketFrame,
	): Promise<void> => {
		if (key.kind !== "stream" || frame.stream !== key.stream) {
			await refetch("protocol_mismatch");
			return;
		}
		if (frame.payload.kind === "snapshot") {
			++epoch;
			instanceId = frame.instance_id;
			cursor = frame.payload.cursor;
			sequence = frame.sequence;
			resourceRevision = frame.resource_revision;
			invalidationTags = Object.freeze([]);
			options.onSnapshot(frame.payload.payload, "ws");
			return;
		}
		const reason = resyncTag(frame);
		if (reason) {
			await refetch(reason);
			return;
		}
		if (frame.payload.kind !== "delta") {
			await refetch("protocol_mismatch");
			return;
		}
		if (instanceId === undefined || sequence === undefined) {
			await refetch("cursor_gap");
			return;
		}
		if (frame.instance_id !== instanceId) {
			await refetch("instance_changed");
			return;
		}
		if (frame.sequence <= sequence) {
			await refetch("stale_epoch");
			return;
		}
		if (frame.sequence !== sequence + 1) {
			await refetch("cursor_gap");
			return;
		}
		cursor = frame.payload.cursor;
		sequence = frame.sequence;
		await refetch("delta");
	};

	return Object.freeze({
		state,
		async consume(raw: string) {
			let decoded: object | string | number | boolean | null;
			try {
				decoded = JSON.parse(raw);
			} catch {
				await refetch("malformed_frame");
				return;
			}
			const parsed = BrowserWorkWebSocketFrameSchema.safeParse(decoded);
			if (!parsed.success) {
				await refetch("protocol_mismatch");
				return;
			}
			await consumeFrame(parsed.data);
		},
		invalidate: refetch,
		disconnect: () => refetch("disconnect"),
	});
}
