import crypto from "node:crypto";

import {
	type BrowserWorkInvalidation,
	BrowserWorkInvalidationSchema,
	type BrowserWorkProjectionResponse,
	type BrowserWorkStream,
	BrowserWorkStreamSchema,
	BrowserWorkWebSocketFrameSchema,
	WebSocketFrameV1Schema,
} from "@golem/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
	type ActorContext,
	type BrowserPrincipalResolver,
	hasRequestAuthorityOverride,
	isExpectedHost,
} from "./auth.js";
import type {
	BrowserWorkReplayEntry,
	BrowserWorkReplayListener,
	BrowserWorkReplayPort,
	BrowserWorkReplayResult,
	ControlPlaneReplayEntry,
	ControlPlaneReplayListener,
	ControlPlaneReplayPort,
	ControlPlaneReplayResult,
	ControlPlaneReplayScope,
} from "./ports.js";
import { type ControlPlaneStream, ProjectionParamsSchema } from "./schemas.js";

export interface ControlPlaneSocket {
	close(code?: number, data?: string): void;
	once(event: "close", listener: () => void): void;
	send(data: string): void;
}

export class BoundedReplayWindow
	implements ControlPlaneReplayPort, BrowserWorkReplayPort
{
	readonly #capacity: number;
	readonly #entries = new Map<string, ControlPlaneReplayEntry[]>();
	readonly #nextSequence = new Map<string, number>();
	readonly #listeners = new Set<ControlPlaneReplayListener>();
	readonly #browserEntries = new Map<string, BrowserWorkReplayEntry[]>();
	readonly #browserNextSequence = new Map<string, number>();
	readonly #browserListeners = new Set<BrowserWorkReplayListener>();

	constructor(capacity = 32) {
		if (!Number.isInteger(capacity) || capacity < 1 || capacity > 256)
			throw new Error(
				"replay window capacity must be an integer from 1 to 256",
			);
		this.#capacity = capacity;
	}

	snapshot(stream: ControlPlaneStream, scope: ControlPlaneReplayScope = {}) {
		const entries = this.#entries.get(scopeKey(stream, scope)) ?? [];
		const latest = entries.at(-1);
		return Object.freeze({
			sequence: latest?.sequence ?? 0,
			resourceRevision: latest?.resourceRevision ?? 0,
		});
	}

	replay(
		stream: ControlPlaneStream,
		cursor: number,
		scope: ControlPlaneReplayScope = {},
	): ControlPlaneReplayResult {
		if (!Number.isInteger(cursor) || cursor < 0)
			return Object.freeze({ kind: "gap", reason: "cursor_gap" });
		const entries = this.#entries.get(scopeKey(stream, scope)) ?? [];
		const oldest = entries[0]?.sequence;
		const latest = entries.at(-1)?.sequence ?? 0;
		if (cursor > latest)
			return Object.freeze({ kind: "gap", reason: "cursor_gap" });
		if (oldest !== undefined && cursor < oldest - 1)
			return Object.freeze({ kind: "gap", reason: "cursor_compacted" });
		return Object.freeze({
			kind: "resume",
			entries: entries.filter((entry) => entry.sequence > cursor),
		});
	}

	publish(
		stream: ControlPlaneStream,
		resourceRevision: number,
		delta: Record<string, unknown>,
		scope: ControlPlaneReplayScope = {},
	): ControlPlaneReplayEntry {
		if (!Number.isInteger(resourceRevision) || resourceRevision < 0)
			throw new Error(
				"replay resource revision must be a non-negative integer",
			);
		const key = scopeKey(stream, scope);
		const entries = this.#entries.get(key) ?? [];
		const prior = entries.at(-1);
		if (prior && resourceRevision < prior.resourceRevision)
			throw new Error(
				"replay resource revision must not regress below the canonical prior revision",
			);
		const entry = Object.freeze({
			sequence: this.#nextSequence.get(key) ?? 1,
			resourceRevision,
			delta: Object.freeze({ ...delta }),
		});
		this.#nextSequence.set(key, entry.sequence + 1);
		entries.push(entry);
		while (entries.length > this.#capacity) entries.shift();
		this.#entries.set(key, entries);
		for (const listener of this.#listeners) listener(stream, entry, scope);
		return entry;
	}

	subscribe(listener: ControlPlaneReplayListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	browserSnapshot(
		stream: BrowserWorkStream,
		scope: ControlPlaneReplayScope = {},
	) {
		const entries = this.#browserEntries.get(scopeKey(stream, scope)) ?? [];
		const latest = entries.at(-1);
		return Object.freeze({
			sequence: latest?.sequence ?? 0,
			resourceRevision: latest?.resourceRevision ?? 0,
		});
	}

	browserReplay(
		stream: BrowserWorkStream,
		cursor: number,
		scope: ControlPlaneReplayScope = {},
	): BrowserWorkReplayResult {
		if (!Number.isInteger(cursor) || cursor < 0)
			return Object.freeze({ kind: "gap", reason: "cursor_gap" });
		const entries = this.#browserEntries.get(scopeKey(stream, scope)) ?? [];
		const oldest = entries[0]?.sequence;
		const latest = entries.at(-1)?.sequence ?? 0;
		if (cursor > latest)
			return Object.freeze({ kind: "gap", reason: "cursor_gap" });
		if (oldest !== undefined && cursor < oldest - 1)
			return Object.freeze({ kind: "gap", reason: "cursor_compacted" });
		return Object.freeze({
			kind: "resume",
			entries: entries.filter((entry) => entry.sequence > cursor),
		});
	}

	publishBrowserWork(
		stream: BrowserWorkStream,
		resourceRevision: number,
		delta: BrowserWorkInvalidation,
		scope: ControlPlaneReplayScope = {},
	): BrowserWorkReplayEntry {
		if (!Number.isInteger(resourceRevision) || resourceRevision < 0)
			throw new Error(
				"browser work replay resource revision must be a non-negative integer",
			);
		const key = scopeKey(stream, scope);
		const entries = this.#browserEntries.get(key) ?? [];
		const prior = entries.at(-1);
		if (prior && resourceRevision < prior.resourceRevision)
			throw new Error(
				"browser work replay resource revision must not regress below the canonical prior revision",
			);
		const entry = Object.freeze({
			sequence: this.#browserNextSequence.get(key) ?? 1,
			resourceRevision,
			delta: BrowserWorkInvalidationSchema.parse(delta),
		});
		this.#browserNextSequence.set(key, entry.sequence + 1);
		entries.push(entry);
		while (entries.length > this.#capacity) entries.shift();
		this.#browserEntries.set(key, entries);
		for (const listener of this.#browserListeners)
			listener(stream, entry, scope);
		return entry;
	}

	subscribeBrowserWork(listener: BrowserWorkReplayListener): () => void {
		this.#browserListeners.add(listener);
		return () => this.#browserListeners.delete(listener);
	}
}

function scopeKey(
	stream: ControlPlaneStream,
	scope: ControlPlaneReplayScope,
): string {
	return `${stream}\u0000${scope.projectId ?? "global"}\u0000${scope.policyVersion ?? 1}`;
}

function scopeFor(
	stream: ControlPlaneStream,
	context: ActorContext,
): ControlPlaneReplayScope {
	return stream === "tracker.tree" ||
		stream === "tracker.board" ||
		stream === "management.controls" ||
		stream === "communication.operations"
		? { projectId: context.defaultProjectId, policyVersion: 1 }
		: {};
}

function originFor(request: FastifyRequest): string {
	return `http://127.0.0.1:${request.socket.localPort ?? 0}`;
}

function frame(
	instanceId: string,
	stream: ControlPlaneStream,
	sequence: number,
	revision: number,
	payload: Record<string, unknown>,
) {
	return WebSocketFrameV1Schema.parse({
		schema_version: "golem.websocket-frame/v1",
		instance_id: instanceId,
		stream,
		sequence,
		resource_revision: revision,
		correlation_id: `corr_${crypto.randomUUID()}`,
		payload,
	});
}

function browserSnapshotFrame(
	instanceId: string,
	sequence: number,
	projection: BrowserWorkProjectionResponse,
) {
	return BrowserWorkWebSocketFrameSchema.parse({
		schema_version: "golem.browser-work-websocket-frame/v1",
		instance_id: instanceId,
		stream: projection.stream,
		sequence,
		resource_revision: projection.resource_revision,
		correlation_id: `corr_${crypto.randomUUID()}`,
		payload: {
			kind: "snapshot",
			cursor: String(sequence),
			payload: projection,
		},
	});
}

function browserDeltaFrame(
	instanceId: string,
	stream: BrowserWorkStream,
	sequence: number,
	revision: number,
	delta: BrowserWorkInvalidation,
) {
	return BrowserWorkWebSocketFrameSchema.parse({
		schema_version: "golem.browser-work-websocket-frame/v1",
		instance_id: instanceId,
		stream,
		sequence,
		resource_revision: revision,
		correlation_id: `corr_${crypto.randomUUID()}`,
		payload: {
			kind: "delta",
			cursor: String(sequence),
			delta: BrowserWorkInvalidationSchema.parse(delta),
		},
	});
}

function browserResyncFrame(
	instanceId: string,
	stream: BrowserWorkStream,
	revision: number,
	reason:
		| "instance_changed"
		| "cursor_gap"
		| "cursor_compacted"
		| "policy_changed",
	snapshotUrl: string,
) {
	return BrowserWorkWebSocketFrameSchema.parse({
		schema_version: "golem.browser-work-websocket-frame/v1",
		instance_id: instanceId,
		stream,
		sequence: 0,
		resource_revision: revision,
		correlation_id: `corr_${crypto.randomUUID()}`,
		payload: { kind: "resync_required", reason, snapshot_url: snapshotUrl },
	});
}

export function registerWsReplay(options: {
	readonly app: FastifyInstance;
	readonly instanceId: string;
	readonly principal: BrowserPrincipalResolver;
	readonly replay: ControlPlaneReplayPort;
	readonly read: (
		stream: ControlPlaneStream,
		projectId?: string,
	) => Record<string, unknown>;
	/** Concrete browser-work snapshots never enter the generic projection wire. */
	readonly browserProjection?: (
		stream: BrowserWorkStream,
		projectId: string,
	) => BrowserWorkProjectionResponse;
	/** Separate, closed browser-work replay journal; never the generic JSON port. */
	readonly browserReplay?: BrowserWorkReplayPort;
	readonly revision: (stream: ControlPlaneStream, projectId?: string) => number;
	readonly sockets: Set<ControlPlaneSocket>;
	/** Streams that are deliberately browser-session-only (GOL-81). */
	readonly browserOnlyStreams?: readonly ControlPlaneStream[];
}): () => void {
	const streams = new Map<
		ControlPlaneSocket,
		{
			readonly stream: ControlPlaneStream;
			readonly context: ActorContext;
			readonly scope: ControlPlaneReplayScope;
		}
	>();
	const unsubscribe = options.replay.subscribe((stream, entry, scope) => {
		if (
			options.browserReplay &&
			BrowserWorkStreamSchema.safeParse(stream).success
		)
			return;
		for (const socket of options.sockets) {
			const subscription = streams.get(socket);
			if (!subscription || subscription.stream !== stream) continue;
			if (scopeKey(stream, subscription.scope) !== scopeKey(stream, scope))
				continue;
			if (
				scope.projectId &&
				!options.principal.policy.allowsProject(
					subscription.context,
					scope.projectId,
				)
			)
				continue;
			try {
				const message = frame(
					options.instanceId,
					stream,
					entry.sequence,
					entry.resourceRevision,
					{
						kind: "delta",
						cursor: String(entry.sequence),
						delta: entry.delta,
					},
				);
				socket.send(JSON.stringify(message));
			} catch {
				options.sockets.delete(socket);
				streams.delete(socket);
			}
		}
	});
	const unsubscribeBrowser = options.browserReplay?.subscribeBrowserWork(
		(stream, entry, scope) => {
			for (const socket of options.sockets) {
				const subscription = streams.get(socket);
				if (!subscription || subscription.stream !== stream) continue;
				if (scopeKey(stream, subscription.scope) !== scopeKey(stream, scope))
					continue;
				if (
					scope.projectId &&
					!options.principal.policy.allowsProject(
						subscription.context,
						scope.projectId,
					)
				)
					continue;
				try {
					const message = browserDeltaFrame(
						options.instanceId,
						stream,
						entry.sequence,
						entry.resourceRevision,
						entry.delta,
					);
					socket.send(JSON.stringify(message));
				} catch {
					options.sockets.delete(socket);
					streams.delete(socket);
				}
			}
		},
	);
	options.app.get(
		"/api/v1/ws",
		{ websocket: true },
		(socket: ControlPlaneSocket, request) => {
			const url = new URL(request.url, originFor(request));
			const parsed = ProjectionParamsSchema.safeParse({
				stream: url.searchParams.get("stream") ?? "runtime.live",
			});
			if (!parsed.success) {
				socket.close(1008, "stream invalid");
				return;
			}
			const stream = parsed.data.stream;
			const browserOnly = options.browserOnlyStreams?.includes(stream) ?? false;
			const context = options.principal.resolve(request, {
				action: "read",
				allowBrowser: true,
				allowBearer: !browserOnly,
			});
			if (
				!isExpectedHost(request.headers.host) ||
				hasRequestAuthorityOverride(request) ||
				!context ||
				!options.principal.policy.allows(context, "read")
			) {
				socket.close(1008, "authentication required");
				return;
			}
			const scope = scopeFor(stream, context);
			const suppliedInstance = url.searchParams.get("instance_id");
			const cursorValue = url.searchParams.get("cursor");
			const suppliedPolicy = url.searchParams.get("policy_version");
			const snapshotUrl = `${originFor(request)}/api/v1/projections/${stream}`;
			const browserStream = BrowserWorkStreamSchema.safeParse(stream);
			const browserProjection = options.browserProjection;
			if (browserStream.success && browserProjection) {
				const browserReplay = options.browserReplay;
				if (!browserReplay) {
					socket.close(1011, "browser replay unavailable");
					return;
				}
				const currentProjection = () =>
					browserProjection(browserStream.data, context.defaultProjectId);
				let messages: readonly ReturnType<typeof browserSnapshotFrame>[];
				if (!suppliedInstance || cursorValue === null) {
					const snapshot = browserReplay.browserSnapshot(
						browserStream.data,
						scope,
					);
					messages = [
						browserSnapshotFrame(
							options.instanceId,
							snapshot.sequence,
							currentProjection(),
						),
					];
				} else if (suppliedInstance !== options.instanceId) {
					messages = [
						browserResyncFrame(
							options.instanceId,
							browserStream.data,
							currentProjection().resource_revision,
							"instance_changed",
							snapshotUrl,
						),
					];
				} else if (
					suppliedPolicy !== null &&
					suppliedPolicy !== String(scope.policyVersion ?? 1)
				) {
					messages = [
						browserResyncFrame(
							options.instanceId,
							browserStream.data,
							currentProjection().resource_revision,
							"policy_changed",
							snapshotUrl,
						),
					];
				} else {
					const result = browserReplay.browserReplay(
						browserStream.data,
						Number(cursorValue),
						scope,
					);
					messages =
						result.kind === "gap"
							? [
									browserResyncFrame(
										options.instanceId,
										browserStream.data,
										currentProjection().resource_revision,
										result.reason,
										snapshotUrl,
									),
								]
							: result.entries.map((entry) =>
									browserDeltaFrame(
										options.instanceId,
										browserStream.data,
										entry.sequence,
										entry.resourceRevision,
										entry.delta,
									),
								);
				}
				options.sockets.add(socket);
				streams.set(socket, { stream, context, scope });
				socket.once("close", () => {
					options.sockets.delete(socket);
					streams.delete(socket);
				});
				for (const message of messages) socket.send(JSON.stringify(message));
				return;
			}
			let messages: readonly ReturnType<typeof frame>[];
			if (!suppliedInstance || cursorValue === null) {
				const snapshot = options.replay.snapshot(stream, scope);
				messages = [
					frame(
						options.instanceId,
						stream,
						snapshot.sequence,
						options.revision(stream, context.defaultProjectId),
						{
							kind: "snapshot",
							cursor: String(snapshot.sequence),
							payload: options.read(stream, context.defaultProjectId),
						},
					),
				];
			} else if (suppliedInstance !== options.instanceId) {
				messages = [
					frame(
						options.instanceId,
						stream,
						0,
						options.revision(stream, context.defaultProjectId),
						{
							kind: "resync_required",
							reason: "instance_changed",
							snapshot_url: snapshotUrl,
						},
					),
				];
			} else if (
				suppliedPolicy !== null &&
				suppliedPolicy !== String(scope.policyVersion ?? 1)
			) {
				messages = [
					frame(
						options.instanceId,
						stream,
						0,
						options.revision(stream, context.defaultProjectId),
						{
							kind: "resync_required",
							reason: "policy_changed",
							snapshot_url: snapshotUrl,
						},
					),
				];
			} else {
				const result = options.replay.replay(
					stream,
					Number(cursorValue),
					scope,
				);
				messages =
					result.kind === "gap"
						? [
								frame(
									options.instanceId,
									stream,
									0,
									options.revision(stream, context.defaultProjectId),
									{
										kind: "resync_required",
										reason: result.reason,
										snapshot_url: snapshotUrl,
									},
								),
							]
						: result.entries.map((entry) =>
								frame(
									options.instanceId,
									stream,
									entry.sequence,
									entry.resourceRevision,
									{
										kind: "delta",
										cursor: String(entry.sequence),
										delta: entry.delta,
									},
								),
							);
			}
			options.sockets.add(socket);
			streams.set(socket, { stream, context, scope });
			socket.once("close", () => {
				options.sockets.delete(socket);
				streams.delete(socket);
			});
			for (const message of messages) socket.send(JSON.stringify(message));
		},
	);
	return () => {
		unsubscribe();
		unsubscribeBrowser?.();
		streams.clear();
	};
}
