import type { RuntimeSignalV1 } from "@golem/contracts";

export type CodexDirectEvent =
	| "session-start"
	| "user-prompt"
	| "tool-pre"
	| "tool-post"
	| "pre-compact"
	| "post-compact"
	| "subagent-stop"
	| "stop";

export type CodexDirectLifecycleState =
	| "starting"
	| "active"
	| "ended"
	| "errored";

export interface CodexDirectIdentity {
	readonly projectId: string;
	readonly sessionId: string;
	readonly generationId: string;
	readonly generationOrdinal: number;
	readonly projectPath: string;
	readonly rawSessionId: string;
}

export interface CodexDirectCapability {
	readonly harness: "codex";
	readonly tier: "B";
	readonly lifecycle: true;
	readonly delivery: readonly ["pull"];
	readonly pushDelivery: false;
	readonly readiness: "pull_only";
	readonly control: false;
	readonly discovery: true;
	readonly qualification: "unproven";
}

export const codexDirectCapability: CodexDirectCapability = Object.freeze({
	harness: "codex",
	tier: "B",
	lifecycle: true,
	delivery: ["pull"] as const,
	pushDelivery: false,
	readiness: "pull_only",
	control: false,
	discovery: true,
	qualification: "unproven",
});

function stableUuid(seed: string): string {
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < seed.length; index += 1) {
		const code = seed.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193);
		second = Math.imul(second ^ code, 0x85ebca6b);
	}
	const digest =
		`${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}${seed.length.toString(16).padStart(16, "0")}`.padEnd(
			32,
			"0",
		);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Project-first identity is stable for the resolved canonical project root. */
export function codexProjectId(projectPath: string): string {
	return `prj_${stableUuid(`codex-project:${projectPath}`)}`;
}

/** A raw native session is an alias, never the canonical session identity. */
export function codexSessionId(
	projectId: string,
	rawSessionId: string,
): string {
	return `ses_${stableUuid(`codex-session:${projectId}:${rawSessionId}`)}`;
}

export function codexGenerationId(sessionId: string, ordinal: number): string {
	return `gen_${stableUuid(`codex-generation:${sessionId}:${ordinal}`)}`;
}

export function codexProducerId(projectId: string): string {
	return `prod_${stableUuid(`codex-hook:${projectId}`)}`;
}

export function codexEventId(
	sessionId: string,
	revision: number,
	event: CodexDirectEvent,
): string {
	return `evt_${stableUuid(`codex-event:${sessionId}:${revision}:${event}`)}`;
}

export function codexIdentity(input: {
	readonly projectPath: string;
	readonly rawSessionId: string;
	readonly generationOrdinal?: number;
}): CodexDirectIdentity {
	const projectId = codexProjectId(input.projectPath);
	const sessionId = codexSessionId(projectId, input.rawSessionId);
	const generationOrdinal = input.generationOrdinal ?? 1;
	return Object.freeze({
		projectId,
		sessionId,
		generationId: codexGenerationId(sessionId, generationOrdinal),
		generationOrdinal,
		projectPath: input.projectPath,
		rawSessionId: input.rawSessionId,
	});
}

function nowIso(now: string | Date | undefined): string {
	return (
		now instanceof Date ? now : new Date(now ?? Date.now())
	).toISOString();
}

function activityKind(event: CodexDirectEvent): "prompt" | "tool" | "work" {
	if (event === "user-prompt") return "prompt";
	if (event === "tool-pre" || event === "tool-post") return "tool";
	return "work";
}

function eventKind(event: CodexDirectEvent): RuntimeSignalV1["event_kind"] {
	if (event === "session-start") return "session.started";
	if (event === "stop") return "session.ended";
	if (event === "subagent-stop") return "session.idle";
	return "session.activity";
}

/**
 * Translate one Codex lifecycle callback into the canonical runtime wire
 * shape. This function is pure: it has no filesystem, database, or transport
 * authority and is safe to reuse by the installed hook and tests.
 */
export function codexRuntimeSignal(input: {
	readonly identity: CodexDirectIdentity;
	readonly event: CodexDirectEvent;
	readonly revision: number;
	readonly producerId?: string;
	readonly model?: string;
	readonly observedAt?: string | Date;
	readonly generationOrdinal?: number;
	readonly resumed?: boolean;
	readonly resumedFromGenerationId?: string;
}): RuntimeSignalV1 {
	const observedAt = nowIso(input.observedAt);
	const kind =
		input.event === "session-start" && input.resumed
			? "session.resumed"
			: eventKind(input.event);
	const identity = input.generationOrdinal
		? codexIdentity({
				projectPath: input.identity.projectPath,
				rawSessionId: input.identity.rawSessionId,
				generationOrdinal: input.generationOrdinal,
			})
		: input.identity;
	const generation = {
		project_id: identity.projectId,
		session_id: identity.sessionId,
		generation_id: identity.generationId,
	};
	const payload =
		kind === "session.started"
			? {
					kind: "session.started" as const,
					generation,
					metadata: {
						...(input.model ? { model: input.model } : {}),
						...(input.resumed ? { resumed: true } : {}),
					},
				}
			: kind === "session.resumed"
				? {
						kind: "session.resumed" as const,
						generation,
						...(input.resumedFromGenerationId
							? {
									resumed_from_generation_id: input.resumedFromGenerationId,
								}
							: {}),
					}
				: kind === "session.ended"
					? {
							kind: "session.ended" as const,
							generation,
							disposition: "ended" as const,
						}
					: kind === "session.idle"
						? { kind: "session.idle" as const, generation }
						: {
								kind: "session.activity" as const,
								generation,
								activity_kind: activityKind(input.event),
							};
	return {
		schema_version: "golem.runtime-signal/v1",
		event_id: codexEventId(identity.sessionId, input.revision, input.event),
		event_kind: kind,
		producer: "codex-direct-hook",
		producer_instance_id:
			input.producerId ?? codexProducerId(identity.projectId),
		harness: "codex",
		correlation_id: `codex:${identity.sessionId}`,
		deduplication_key: `codex:${identity.sessionId}:${identity.generationId}:${input.revision}:${input.event}`,
		clocks: {
			source_observed_at: observedAt,
			source_event_at: observedAt,
			received_at: observedAt,
		},
		provenance: {
			source: "adapter",
			confidence: "observed",
			evidence_id: `codex-hook:${input.event}`,
		},
		clear_fields: [],
		payload,
	} as unknown as RuntimeSignalV1;
}
