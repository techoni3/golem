import { createHash } from "node:crypto";
import type { RuntimeSignalV1 } from "@golem/contracts";

/**
 * The managed Codex process is deliberately narrower than direct Codex.  A
 * managed App Server is only a valid transport for the qualified OpenAI/GPT
 * contribution.  Keeping this check in the adapter boundary means an
 * unsupported local/OSS request is rejected before a child process exists.
 */
export interface ManagedCodexQualificationInput {
	readonly backend?: string;
	readonly model?: string;
	readonly mode?: string;
}

export interface ManagedCodexQualification {
	readonly backend: "openai";
	readonly model: string;
	readonly mode: "managed";
	readonly launchable: true;
	readonly deliveryMode: "managed_app_server";
}

export class ManagedCodexQualificationError extends Error {
	readonly code = "adapter.codex.managed.qualification_required";
	readonly remediation =
		"Use direct Codex for local/OSS models, or select a qualified OpenAI/GPT managed preset.";

	constructor() {
		super("Managed Codex requires a qualified OpenAI/GPT model.");
		this.name = "ManagedCodexQualificationError";
	}
}

function normalized(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const result = value.trim();
	return result || undefined;
}

function opaqueEventId(seed: string): string {
	const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `evt_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Resolve the closed managed qualification set without echoing hostile input. */
export function qualifyManagedCodex(
	input: ManagedCodexQualificationInput = {},
): ManagedCodexQualification {
	const mode = normalized(input.mode) ?? "managed";
	const backend = normalized(input.backend) ?? "openai";
	const model = normalized(input.model) ?? "gpt-4o";
	if (
		mode !== "managed" ||
		backend !== "openai" ||
		!/^gpt(?:-|$)/iu.test(model)
	)
		throw new ManagedCodexQualificationError();
	return Object.freeze({
		backend: "openai",
		model,
		mode: "managed",
		launchable: true,
		deliveryMode: "managed_app_server",
	});
}

export interface ManagedCodexSignalInput {
	readonly kind: RuntimeSignalV1["event_kind"];
	readonly projectId: string;
	readonly sessionId: string;
	readonly generationId: string;
	readonly producerInstanceId: string;
	readonly observedAt: string;
	readonly sequence: number;
	readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * Build a canonical lifecycle signal from an App Server observation.  This is
 * intentionally pure; persistence and transport remain injected composition.
 */
export function managedCodexSignal(
	input: ManagedCodexSignalInput,
): RuntimeSignalV1 {
	const generation = {
		project_id: input.projectId,
		session_id: input.sessionId,
		generation_id: input.generationId,
	};
	const payload = (() => {
		switch (input.kind) {
			case "session.started":
				return { kind: input.kind, generation, metadata: input.payload ?? {} };
			case "session.resumed":
				return { kind: input.kind, generation };
			case "session.activity":
				return {
					kind: input.kind,
					generation,
					activity_kind: "response" as const,
				};
			case "session.idle":
				return { kind: input.kind, generation };
			case "session.waiting":
				return { kind: input.kind, generation, reason: "managed_codex" };
			case "session.ended":
				return { kind: input.kind, generation, disposition: "ended" as const };
			default:
				return {
					kind: "session.activity" as const,
					generation,
					activity_kind: "work" as const,
				};
		}
	})();
	const eventId = opaqueEventId(
		`codex-managed:${input.generationId}:${input.sequence}:${input.kind}`,
	);
	return {
		schema_version: "golem.runtime-signal/v1",
		event_id: eventId,
		event_kind: input.kind,
		producer: "codex-managed-app-server",
		producer_instance_id: input.producerInstanceId,
		harness: "codex",
		producer_sequence: input.sequence,
		correlation_id: input.generationId,
		deduplication_key: `codex-managed:${input.generationId}:${input.sequence}:${input.kind}`,
		clocks: {
			source_observed_at: input.observedAt,
			received_at: input.observedAt,
		},
		provenance: {
			source: "adapter",
			evidence_id: `codex-managed:${input.generationId}`,
			confidence: "observed",
		},
		clear_fields: [],
		payload,
	} as unknown as RuntimeSignalV1;
}
