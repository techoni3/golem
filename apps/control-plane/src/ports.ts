import type { RuntimeSignalV1 } from "@golem/contracts";
import type { ControlPlaneStream } from "./schemas.js";

/** Producers may submit a durable envelope but never obtain persistence. */
export interface RuntimeIngressPort {
	ingest(signal: RuntimeSignalV1): {
		readonly eventId: string;
		readonly status: "spooled" | "already_pending";
	};
}

/** Payload-free service facts supplied by the bounded runtime scheduler. */
export interface RuntimeHealthPort {
	health(): {
		readonly inbox: {
			readonly pending: number;
			readonly processing: number;
			readonly archived: number;
			readonly quarantined: number;
			readonly retrying: number;
			readonly oldestPendingAgeMs?: number;
			readonly oldestRetryAgeMs?: number;
		};
		readonly outbox: {
			readonly pending: number;
			readonly claimed: number;
			readonly published: number;
			readonly permanentFailures: number;
			readonly oldestRetryAgeMs?: number;
			readonly lastSuccessAt?: string;
		};
		readonly lastSuccessfulMaterializationAt?: string;
		readonly lastTickError?: string;
	};
}

export interface ControlPlaneProjectionPort {
	read(stream: ControlPlaneStream): Record<string, unknown>;
	revision(stream: ControlPlaneStream): number;
}

export interface ControlPlaneReplayEntry {
	readonly sequence: number;
	readonly resourceRevision: number;
	readonly delta: Record<string, unknown>;
}

export type ControlPlaneReplayListener = (
	stream: ControlPlaneStream,
	entry: ControlPlaneReplayEntry,
) => void;

export type ControlPlaneReplayResult =
	| {
			readonly kind: "resume";
			readonly entries: readonly ControlPlaneReplayEntry[];
	  }
	| {
			readonly kind: "gap";
			readonly reason: "cursor_gap" | "cursor_compacted";
	  };

/** A bounded stream journal injected by a real projection/materializer later. */
export interface ControlPlaneReplayPort {
	snapshot(stream: ControlPlaneStream): {
		readonly sequence: number;
		readonly resourceRevision: number;
	};
	replay(stream: ControlPlaneStream, cursor: number): ControlPlaneReplayResult;
	publish(
		stream: ControlPlaneStream,
		resourceRevision: number,
		delta: Record<string, unknown>,
	): ControlPlaneReplayEntry;
	subscribe(listener: ControlPlaneReplayListener): () => void;
}
