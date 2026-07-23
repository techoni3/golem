import crypto from "node:crypto";

import type {
	CommandGatewayStorage,
	CommandReceiptRecord,
} from "@golem/persistence";

import type { TrackerCoreServices } from "./core.js";
import { TrackerManagementError } from "./management.js";
import { TrackerCoreError } from "./tickets/service.js";
import type { TrackerClock } from "./types.js";

/**
 * Terminal typed outcome produced by the command gateway.  Mirrors the wire
 * shape of `golem.api-command-outcome/v1` but uses a plain `command_id: string`
 * so the gateway can mint and replay ids without the branded `CommandId`
 * schema (the contract registry validates the shape at the boundary).
 */
export interface CommandGatewayOutcome {
	readonly schema_version: "golem.api-command-outcome/v1";
	readonly command_id: string;
	readonly status:
		| "accepted"
		| "completed"
		| "rejected"
		| "conflict"
		| "pending"
		| "idempotency_mismatch";
	readonly reason_code?: string;
	readonly operation_id?: string;
	readonly result?: unknown;
}

/**
 * Error thrown by the command gateway.  It carries a stable typed code so the
 * control-plane adapter can map it to the correct HTTP status without
 * inspecting the message.
 */
export class CommandGatewayError extends Error {
	readonly status:
		| "tracker.revision.required"
		| "tracker.conflict"
		| "command.idempotency_mismatch"
		| "tracker.not_found"
		| "tracker.phase.invalid"
		| "tracker.input.invalid"
		| "management.invalid"
		| "management.not_found"
		| "management.forbidden"
		| "management.conflict"
		| "management.asset_invalid";
	readonly httpStatus: 400 | 403 | 404 | 409;

	constructor(
		code: CommandGatewayError["status"],
		message: string,
		httpStatus: CommandGatewayError["httpStatus"],
	) {
		super(message);
		this.name = "CommandGatewayError";
		this.status = code;
		this.httpStatus = httpStatus;
	}
}

/** Resource scope carried on every command envelope. */
export interface CommandScope {
	readonly resourceType: string;
	readonly resourceId: string;
}

/** Input to the command gateway. */
export interface CommandGatewayInput {
	readonly commandId: string;
	readonly idempotencyKey: string;
	readonly commandKind: string;
	readonly actorId: string;
	readonly projectId: string;
	readonly correlationId: string;
	readonly scope: CommandScope;
	/**
	 * Required positive expected revision for existing mutable resources.
	 * A syntactically absent value is permitted for idempotent creates; a
	 * present but non-positive value is rejected as
	 * `tracker.revision.required` (400) before any receipt is written.
	 */
	readonly expectedRevision?: number;
	/**
	 * The command payload.  The gateway canonicalizes it into a fingerprint
	 * so a reuse of an idempotency key with a differing payload returns
	 * `command.idempotency_mismatch` (409) with no effect.
	 */
	readonly payload: Readonly<Record<string, unknown>>;
	/**
	 * The domain handler.  The gateway invokes this inside one canonical
	 * tracker transaction, alongside the receipt recording.  The handler
	 * must throw {@link TrackerCoreError} on a legal rejection; the gateway
	 * records that terminal rejection once.
	 */
	readonly handler: () => unknown;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonicalize(child)]),
		);
	}
	return value;
}

function fingerprint(input: {
	readonly commandKind: string;
	readonly projectId: string;
	readonly scope: CommandScope;
	readonly payload: Readonly<Record<string, unknown>>;
}): string {
	const canonical = canonicalize({
		command_kind: input.commandKind,
		project_id: input.projectId,
		resource_type: input.scope.resourceType,
		resource_id: input.scope.resourceId,
		payload: input.payload,
	});
	const text = JSON.stringify(canonical);
	const hash = crypto.createHash("sha256").update(text).digest("hex");
	return `sha256:${hash}`;
}

function outcomeFromReceipt(
	receipt: CommandReceiptRecord,
): CommandGatewayOutcome {
	return Object.freeze({
		schema_version: "golem.api-command-outcome/v1",
		command_id: receipt.command_id,
		status: receipt.outcome_status,
		...(receipt.reason_code ? { reason_code: receipt.reason_code } : {}),
		...(receipt.operation_id ? { operation_id: receipt.operation_id } : {}),
		result: receipt.result,
	});
}

/**
 * One typed command gateway.  All tracker, management, communications, and
 * browser-originated mutations execute through this service, inside one
 * canonical SQLite transaction.  It accepts a resolver-created actor identity,
 * an opaque command id, idempotency key, command kind/payload, and (for
 * existing mutable resources) a required positive expected revision.
 *
 * A matching replay of (project_id, idempotency_key) returns the original
 * typed outcome without re-running any transaction, audit, outbox, delivery,
 * or side effect.  A reuse with a differing kind/payload/scope fingerprint
 * returns `409 command.idempotency_mismatch` with no effect.
 *
 * The gateway itself does not publish WS frames (GOL-80 owns that), decide
 * phase legality, manager exceptional closure, target generation/fence/
 * readiness, asset safety, or settlement — those remain the existing
 * canonical services invoked inside the transaction via the handler.
 */
export interface CommandGateway {
	execute(input: CommandGatewayInput): CommandGatewayOutcome;
}

export function createCommandGateway(options: {
	readonly storage: CommandGatewayStorage;
	readonly clock: TrackerClock;
	readonly core: TrackerCoreServices;
}): CommandGateway {
	const storage = options.storage;
	const clock = options.clock;
	// The gateway consumes the composed tracker core services inside the
	// handler; it does not re-implement phase legality, audit, or outbox.
	// `core` is part of the constructor signature so future handlers can
	// reach the compatibility facade without a second composition seam.
	void options.core;

	function requireRevision(input: CommandGatewayInput): void {
		const candidate = input.expectedRevision;
		if (candidate === undefined) return;
		if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
			throw new CommandGatewayError(
				"tracker.revision.required",
				"expected_revision must be a positive safe integer",
				400,
			);
		}
	}

	function recordTerminal(
		input: CommandGatewayInput,
		outcome: {
			readonly command_id: string;
			readonly status: CommandGatewayOutcome["status"];
			readonly reason_code?: string;
			readonly operation_id?: string;
			readonly result?: Readonly<Record<string, unknown>>;
		},
	): CommandGatewayOutcome {
		const committedAt = clock.now();
		const fp = fingerprint({
			commandKind: input.commandKind,
			projectId: input.projectId,
			scope: input.scope,
			payload: input.payload,
		});
		storage.receipts.record({
			command_id: input.commandId,
			idempotency_key: input.idempotencyKey,
			command_kind: input.commandKind,
			actor_id: input.actorId,
			project_id: input.projectId,
			resource_type: input.scope.resourceType,
			resource_id: input.scope.resourceId,
			correlation_id: input.correlationId,
			fingerprint: fp,
			outcome_status: outcome.status,
			...(outcome.reason_code ? { reason_code: outcome.reason_code } : {}),
			...(outcome.operation_id
				? { operation_id: outcome.operation_id }
				: {}),
			result: (outcome.result as Readonly<Record<string, unknown>>) ?? {},
			committed_at: committedAt,
		});
		return Object.freeze({
			schema_version: "golem.api-command-outcome/v1",
			command_id: outcome.command_id,
			status: outcome.status,
			...(outcome.reason_code ? { reason_code: outcome.reason_code } : {}),
			...(outcome.operation_id ? { operation_id: outcome.operation_id } : {}),
			...(outcome.result !== undefined ? { result: outcome.result } : {}),
		}) as CommandGatewayOutcome;
	}

	function mismatch(
		input: CommandGatewayInput,
		existing: CommandReceiptRecord,
	): CommandGatewayOutcome {
		return Object.freeze({
			schema_version: "golem.api-command-outcome/v1",
			command_id: input.commandId,
			status: "idempotency_mismatch",
			reason_code: "command.idempotency_mismatch",
			result: {
				original_command_id: existing.command_id,
				original_status: existing.outcome_status,
			},
		}) as CommandGatewayOutcome;
	}

	function replayOrMismatch(
		input: CommandGatewayInput,
		existing: CommandReceiptRecord,
	): CommandGatewayOutcome {
		const currentFingerprint = fingerprint({
			commandKind: input.commandKind,
			projectId: input.projectId,
			scope: input.scope,
			payload: input.payload,
		});
		if (existing.fingerprint !== currentFingerprint) {
			return mismatch(input, existing);
		}
		return outcomeFromReceipt(existing);
	}

	return Object.freeze({
		execute(input: CommandGatewayInput): CommandGatewayOutcome {
			// Enforce the positive-revision precondition before any receipt is
			// written.  A syntactically absent revision is permitted for
			// idempotent creates; a present but non-positive value is 400.
			requireRevision(input);
			const existing = storage.receipts.find(
				input.projectId,
				input.idempotencyKey,
			);
			if (existing) {
				return replayOrMismatch(input, existing);
			}
			return storage.transaction(() => {
				// Re-check inside the transaction: a concurrent command may
				// have committed the same idempotency key between the outer
				// find and the transaction start.  The UNIQUE(project_id,
				// idempotency_key) constraint is the authoritative guard.
				const raced = storage.receipts.find(
					input.projectId,
					input.idempotencyKey,
				);
				if (raced) {
					return replayOrMismatch(input, raced);
				}
				try {
					const result = input.handler();
					return recordTerminal(input, {
						command_id: input.commandId,
						status: "completed",
						result: result as Record<string, unknown>,
					});
				} catch (error) {
					if (error instanceof TrackerCoreError) {
						const httpStatus: 400 | 404 | 409 =
							error.code === "tracker.not_found"
								? 404
								: error.code === "tracker.conflict" ||
									  error.code === "tracker.phase.invalid"
									? 409
									: 400;
						// A command that passes preconditions but is legally
						// rejected records its typed terminal rejection once,
						// preserving the service's authoritative error code.
						recordTerminal(input, {
							command_id: input.commandId,
							status:
								error.code === "tracker.conflict"
									? "conflict"
									: "rejected",
							reason_code: error.code,
							result: {},
						});
						throw new CommandGatewayError(
							error.code as CommandGatewayError["status"],
							error.message,
							httpStatus,
						);
					}
					if (error instanceof TrackerManagementError) {
						const httpStatus: 400 | 403 | 404 | 409 =
							error.code === "management.not_found"
								? 404
								: error.code === "management.forbidden"
									? 403
									: error.code === "management.conflict"
									? 409
									: 400;
						recordTerminal(input, {
							command_id: input.commandId,
							status:
								error.code === "management.conflict" ? "conflict" : "rejected",
							reason_code: error.code,
							result: {},
						});
						throw new CommandGatewayError(error.code, error.message, httpStatus);
					}
					throw error;
				}
			});
		},
	});
}
