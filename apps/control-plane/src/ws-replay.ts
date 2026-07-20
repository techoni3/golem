import crypto from "node:crypto";

import { WebSocketFrameV1Schema } from "@golem/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { bearerIsValid, isExpectedHost } from "./auth.js";
import type {
	ControlPlaneReplayEntry,
	ControlPlaneReplayPort,
	ControlPlaneReplayResult,
} from "./ports.js";
import { type ControlPlaneStream, ProjectionParamsSchema } from "./schemas.js";

export interface ControlPlaneSocket {
	close(code?: number, data?: string): void;
	once(event: "close", listener: () => void): void;
	send(data: string): void;
}

export class BoundedReplayWindow implements ControlPlaneReplayPort {
	readonly #capacity: number;
	readonly #entries = new Map<ControlPlaneStream, ControlPlaneReplayEntry[]>();
	readonly #nextSequence = new Map<ControlPlaneStream, number>();

	constructor(capacity = 32) {
		if (!Number.isInteger(capacity) || capacity < 1 || capacity > 256)
			throw new Error(
				"replay window capacity must be an integer from 1 to 256",
			);
		this.#capacity = capacity;
	}

	snapshot(stream: ControlPlaneStream) {
		const entries = this.#entries.get(stream) ?? [];
		const latest = entries.at(-1);
		return Object.freeze({
			sequence: latest?.sequence ?? 0,
			resourceRevision: latest?.resourceRevision ?? 0,
		});
	}

	replay(stream: ControlPlaneStream, cursor: number): ControlPlaneReplayResult {
		if (!Number.isInteger(cursor) || cursor < 0)
			return Object.freeze({ kind: "gap", reason: "cursor_gap" });
		const entries = this.#entries.get(stream) ?? [];
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
	): ControlPlaneReplayEntry {
		if (!Number.isInteger(resourceRevision) || resourceRevision < 0)
			throw new Error(
				"replay resource revision must be a non-negative integer",
			);
		const entries = this.#entries.get(stream) ?? [];
		const prior = entries.at(-1);
		const entry = Object.freeze({
			sequence: this.#nextSequence.get(stream) ?? 1,
			resourceRevision: Math.max(
				resourceRevision,
				(prior?.resourceRevision ?? -1) + 1,
			),
			delta: Object.freeze({ ...delta }),
		});
		this.#nextSequence.set(stream, entry.sequence + 1);
		entries.push(entry);
		while (entries.length > this.#capacity) entries.shift();
		this.#entries.set(stream, entries);
		return entry;
	}
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

export function registerWsReplay(options: {
	readonly app: FastifyInstance;
	readonly instanceId: string;
	readonly token: string;
	readonly replay: ControlPlaneReplayPort;
	readonly read: (stream: ControlPlaneStream) => Record<string, unknown>;
	readonly revision: (stream: ControlPlaneStream) => number;
	readonly sockets: Set<ControlPlaneSocket>;
}): void {
	options.app.get(
		"/ws",
		{ websocket: true },
		(socket: ControlPlaneSocket, request) => {
			if (
				!isExpectedHost(request.headers.host) ||
				!bearerIsValid(request, options.token)
			) {
				socket.close(1008, "authentication required");
				return;
			}
			const url = new URL(request.url, originFor(request));
			const parsed = ProjectionParamsSchema.safeParse({
				stream: url.searchParams.get("stream") ?? "runtime.live",
			});
			if (!parsed.success) {
				socket.close(1008, "stream invalid");
				return;
			}
			const stream = parsed.data.stream;
			const suppliedInstance = url.searchParams.get("instance_id");
			const cursorValue = url.searchParams.get("cursor");
			const snapshotUrl = `${originFor(request)}/api/v1/projections/${stream}`;
			let messages: readonly ReturnType<typeof frame>[];
			if (!suppliedInstance || cursorValue === null) {
				const snapshot = options.replay.snapshot(stream);
				messages = [
					frame(
						options.instanceId,
						stream,
						snapshot.sequence,
						Math.max(snapshot.resourceRevision, options.revision(stream)),
						{
							kind: "snapshot",
							cursor: String(snapshot.sequence),
							payload: options.read(stream),
						},
					),
				];
			} else if (suppliedInstance !== options.instanceId) {
				messages = [
					frame(options.instanceId, stream, 0, options.revision(stream), {
						kind: "resync_required",
						reason: "instance_changed",
						snapshot_url: snapshotUrl,
					}),
				];
			} else {
				const result = options.replay.replay(stream, Number(cursorValue));
				messages =
					result.kind === "gap"
						? [
								frame(options.instanceId, stream, 0, options.revision(stream), {
									kind: "resync_required",
									reason: result.reason,
									snapshot_url: snapshotUrl,
								}),
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
			socket.once("close", () => options.sockets.delete(socket));
			for (const message of messages) socket.send(JSON.stringify(message));
		},
	);
}
