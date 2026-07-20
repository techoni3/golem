import type { ControlPlaneStream } from "./schemas.js";

export interface ControlPlaneProjectionPort {
	read(stream: ControlPlaneStream): Record<string, unknown>;
	revision(stream: ControlPlaneStream): number;
}

export interface ControlPlaneReplayEntry {
	readonly sequence: number;
	readonly resourceRevision: number;
	readonly delta: Record<string, unknown>;
}

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
}
