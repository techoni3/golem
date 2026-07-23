import type { SqliteConnection } from "./internals.js";
import { sha256 } from "./schema.js";
import type {
	CapabilityQualification,
	DeliveryMode,
	EndpointControlState,
	EndpointLifecycleState,
	EndpointReadinessState,
	EndpointRouteKind,
	PersistenceClock,
	RuntimeEndpointCapability,
	RuntimeEndpointDeliveryEligibility,
	RuntimeEndpointEligibility,
	RuntimeEndpointMutationResult,
	RuntimeEndpointStorage,
	RuntimeEndpointView,
} from "./types.js";

interface EndpointRow {
	readonly endpoint_id: string;
	readonly generation_id: string;
	readonly route_kind: EndpointRouteKind;
	readonly revision: number;
	readonly state: EndpointLifecycleState;
	readonly owner_fence: number;
	readonly owner_instance_id: string;
	readonly delivery_mode: DeliveryMode;
	readonly readiness_state: EndpointReadinessState;
	readonly control_state: EndpointControlState;
	readonly consumer_ready: number;
	readonly consumption_observed: number;
	readonly delivery_observed: number;
	readonly delivery_failed: number;
	readonly claimed_at: string;
	readonly heartbeat_at: string | null;
	readonly expires_at: string | null;
	readonly superseded_at: string | null;
}

interface CapabilityRow {
	readonly capability: string;
	readonly adapter_id: string;
	readonly adapter_version: string;
	readonly qualification_state: CapabilityQualification;
	readonly delivery_mode: DeliveryMode;
	readonly readiness_state: EndpointReadinessState;
	readonly evidence_kind: RuntimeEndpointCapability["evidenceKind"];
	readonly observed_at: string;
	readonly expires_at: string | null;
	readonly id: string;
}

interface GenerationRow {
	readonly lifecycle_state: string;
}

interface ExpiryRow extends EndpointRow {
	readonly generation_lifecycle_state: string;
}

function json(value: Readonly<Record<string, unknown>>): string {
	return JSON.stringify(value);
}

function accepted(
	endpointId: string,
	revision: number,
	fence?: number,
): RuntimeEndpointMutationResult {
	return Object.freeze({
		disposition: "accepted" as const,
		code: "runtime.endpoint.accepted",
		endpointId,
		revision,
		...(fence === undefined ? {} : { ownerFence: fence }),
	});
}

function rejected(
	code: string,
	details?: Readonly<Record<string, unknown>>,
): RuntimeEndpointMutationResult {
	return Object.freeze({
		disposition: "rejected" as const,
		code,
		...(details ? { details } : {}),
	});
}

function live(state: EndpointLifecycleState): boolean {
	return state === "claiming" || state === "healthy" || state === "degraded";
}

function terminal(state: string): boolean {
	return state === "ended" || state === "errored" || state === "superseded";
}

function compareTime(left: string, right: string): number {
	return Date.parse(left) - Date.parse(right);
}

/** Public endpoint diagnostics may include adapter/owner labels from untrusted adapters. */
function redactIdentifier(value: string): string {
	return value.replace(
		/((?:owner[_-]?token|access[_-]?token|api[_-]?key|openai[_-]?api[_-]?key|token|credential|password|secret|bearer)\s*[=:]\s*)([^\s,;|]+)/giu,
		"$1[REDACTED]",
	);
}

function consumedEvidence(
	evidence: Readonly<Record<string, unknown>>,
): boolean {
	return (
		evidence.consumed === true ||
		evidence.consumptionObserved === true ||
		evidence.consumption === "observed"
	);
}

/**
 * Transactional endpoint owner. Fences are allocated from durable rows and
 * every accepted semantic mutation appends exactly one ordered runtime effect.
 */
export class RuntimeEndpointRepository implements RuntimeEndpointStorage {
	readonly #database: SqliteConnection;
	readonly #clock: PersistenceClock;

	constructor(database: SqliteConnection, clock: PersistenceClock) {
		this.#database = database;
		this.#clock = clock;
	}

	#emit(
		row: Pick<
			EndpointRow,
			| "endpoint_id"
			| "generation_id"
			| "route_kind"
			| "revision"
			| "owner_fence"
		>,
		kind: string,
		now: string,
	): void {
		const id = sha256(
			`endpoint:${row.endpoint_id}:${row.revision}:${kind}`,
		).slice(0, 32);
		this.#database
			.prepare(
				"INSERT OR IGNORE INTO runtime_outbox(id, destination, payload_json, status, created_at, attempts) VALUES (?, 'tracker', ?, 'pending', ?, 0)",
			)
			.run(
				id,
				json({
					kind,
					endpointId: row.endpoint_id,
					generationId: row.generation_id,
					routeKind: row.route_kind,
					revision: row.revision,
					ownerFence: row.owner_fence,
				}),
				new Date(Date.parse(now) + row.revision).toISOString(),
			);
	}

	#row(endpointId: string): EndpointRow | undefined {
		return this.#database
			.prepare<EndpointRow>(
				"SELECT endpoint_id, generation_id, route_kind, revision, state, owner_fence, owner_instance_id, delivery_mode, readiness_state, control_state, consumer_ready, consumption_observed, delivery_observed, delivery_failed, claimed_at, heartbeat_at, expires_at, superseded_at FROM endpoint_claims WHERE endpoint_id = ?",
			)
			.get(endpointId);
	}

	#nextRevision(generationId: string): number {
		const row = this.#database
			.prepare<{ readonly revision: number | null }>(
				"SELECT MAX(revision) AS revision FROM endpoint_claims WHERE generation_id = ?",
			)
			.get(generationId);
		return (row?.revision ?? 0) + 1;
	}

	#validateGeneration(
		generationId: string,
	): RuntimeEndpointMutationResult | undefined {
		const row = this.#database
			.prepare<GenerationRow>(
				"SELECT lifecycle_state FROM session_generations WHERE generation_id = ?",
			)
			.get(generationId);
		if (!row) return rejected("runtime.endpoint.generation_unresolved");
		if (terminal(row.lifecycle_state))
			return rejected("runtime.endpoint.generation_terminal", {
				remedy: "select a non-terminal generation",
			});
		return undefined;
	}

	#validateOwner(input: {
		endpointId: string;
		generationId: string;
		ownerInstanceId: string;
		ownerFence: number;
	}): {
		readonly row?: EndpointRow;
		readonly error?: RuntimeEndpointMutationResult;
	} {
		const row = this.#row(input.endpointId);
		if (!row) return { error: rejected("runtime.endpoint.unresolved") };
		if (
			row.generation_id !== input.generationId ||
			row.owner_instance_id !== input.ownerInstanceId ||
			row.owner_fence !== input.ownerFence
		)
			return {
				error: rejected("runtime.endpoint.fence_stale", {
					generationId: row.generation_id,
					expectedFence: row.owner_fence,
					receivedFence: input.ownerFence,
				}),
			};
		if (!live(row.state))
			return { error: rejected("runtime.endpoint.fence_stale") };
		const now = this.#clock.now();
		if (row.expires_at && compareTime(row.expires_at, now) <= 0)
			return { error: rejected("runtime.endpoint.lease_expired") };
		return { row };
	}

	claim(input: {
		endpointId?: string;
		generationId: string;
		routeKind: EndpointRouteKind;
		ownerInstanceId: string;
		deliveryMode: DeliveryMode;
		readiness?: EndpointReadinessState;
		controlState?: EndpointControlState;
		leaseMs: number;
	}): RuntimeEndpointMutationResult {
		if (!input.ownerInstanceId.trim())
			return rejected("runtime.endpoint.owner_invalid");
		if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1)
			return rejected("runtime.endpoint.lease_invalid");
		return this.#database.transaction(() => {
			const generationError = this.#validateGeneration(input.generationId);
			if (generationError) return generationError;
			const now = this.#clock.now();
			const fenceRow = this.#database
				.prepare<{ readonly fence: number | null }>(
					"SELECT MAX(fence) AS fence FROM endpoint_fences WHERE generation_id = ? AND route_kind = ?",
				)
				.get(input.generationId, input.routeKind);
			const fence = (fenceRow?.fence ?? 0) + 1;
			const endpointId =
				input.endpointId ??
				`endpoint_${sha256(`${input.generationId}:${input.routeKind}:${input.ownerInstanceId}:${fence}`).slice(0, 24)}`;
			// Resolve conflicts before superseding the active owner or allocating a
			// fence so a rejected duplicate is a true zero-write transaction.
			const existing = this.#row(endpointId);
			if (existing) {
				// A crashed managed host may reconnect with its persisted binding
				// before the lease expires. This is an idempotent reattachment of the
				// *same* owner/fence, not a new claim: it allocates no fence, writes no
				// lifecycle effect, and cannot steal an endpoint from another owner.
				if (
					live(existing.state) &&
					existing.generation_id === input.generationId &&
					existing.route_kind === input.routeKind &&
					existing.owner_instance_id === input.ownerInstanceId
				)
					return accepted(
						existing.endpoint_id,
						existing.revision,
						existing.owner_fence,
					);
				return rejected("runtime.endpoint.endpoint_conflict");
			}
			const prior = this.#database
				.prepare<EndpointRow>(
					"SELECT endpoint_id, generation_id, route_kind, revision, state, owner_fence, owner_instance_id, delivery_mode, readiness_state, control_state, consumer_ready, consumption_observed, delivery_observed, delivery_failed, claimed_at, heartbeat_at, expires_at, superseded_at FROM endpoint_claims WHERE generation_id = ? AND route_kind = ? AND state IN ('claiming', 'healthy', 'degraded') ORDER BY owner_fence DESC LIMIT 1",
				)
				.get(input.generationId, input.routeKind);
			const revision = this.#nextRevision(input.generationId);
			if (prior) {
				this.#database
					.prepare(
						"UPDATE endpoint_claims SET state = 'superseded', superseded_at = ?, revision = ? WHERE endpoint_id = ?",
					)
					.run(now, revision, prior.endpoint_id);
			}
			const expiresAt = this.#clock.after(input.leaseMs);
			this.#database
				.prepare(
					"INSERT INTO endpoint_fences(generation_id, route_kind, fence, allocated_at, owner_instance_id) VALUES (?, ?, ?, ?, ?)",
				)
				.run(
					input.generationId,
					input.routeKind,
					fence,
					now,
					input.ownerInstanceId,
				);
			this.#database
				.prepare(
					"INSERT INTO endpoint_claims(endpoint_id, generation_id, route_kind, revision, state, owner_fence, owner_instance_id, delivery_mode, readiness_state, control_state, consumer_ready, consumption_observed, delivery_observed, delivery_failed, claimed_at, heartbeat_at, expires_at, superseded_at) VALUES (?, ?, ?, ?, 'claiming', ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, NULL)",
				)
				.run(
					endpointId,
					input.generationId,
					input.routeKind,
					revision,
					fence,
					input.ownerInstanceId,
					input.deliveryMode,
					input.readiness ?? "uninitialized",
					input.controlState ?? "disabled",
					now,
					now,
					expiresAt,
				);
			this.#emit(
				{
					endpoint_id: endpointId,
					generation_id: input.generationId,
					route_kind: input.routeKind,
					revision,
					owner_fence: fence,
				},
				"endpoint.claimed",
				now,
			);
			return accepted(endpointId, revision, fence);
		})();
	}

	heartbeat(input: {
		endpointId: string;
		generationId: string;
		ownerInstanceId: string;
		ownerFence: number;
		heartbeatAt?: string;
		leaseMs: number;
	}): RuntimeEndpointMutationResult {
		if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1)
			return rejected("runtime.endpoint.lease_invalid");
		return this.#database.transaction(() => {
			const generationError = this.#validateGeneration(input.generationId);
			if (generationError) return generationError;
			const checked = this.#validateOwner(input);
			if (checked.error) return checked.error;
			const row = checked.row as EndpointRow;
			const now = this.#clock.now();
			const revision = row.revision + 1;
			this.#database
				.prepare(
					"UPDATE endpoint_claims SET revision = ?, heartbeat_at = ?, expires_at = ? WHERE endpoint_id = ?",
				)
				.run(
					revision,
					input.heartbeatAt ?? now,
					this.#clock.after(input.leaseMs),
					row.endpoint_id,
				);
			this.#emit({ ...row, revision }, "endpoint.heartbeat", now);
			return accepted(row.endpoint_id, revision);
		})();
	}

	reportHealth(input: {
		endpointId: string;
		generationId: string;
		ownerInstanceId: string;
		ownerFence: number;
		state: "healthy" | "degraded";
	}): RuntimeEndpointMutationResult {
		return this.#database.transaction(() => {
			const generationError = this.#validateGeneration(input.generationId);
			if (generationError) return generationError;
			const checked = this.#validateOwner(input);
			if (checked.error) return checked.error;
			const row = checked.row as EndpointRow;
			const now = this.#clock.now();
			const revision = row.revision + 1;
			this.#database
				.prepare(
					"UPDATE endpoint_claims SET state = ?, revision = ? WHERE endpoint_id = ?",
				)
				.run(input.state, revision, row.endpoint_id);
			this.#emit({ ...row, revision }, "endpoint.health", now);
			return accepted(row.endpoint_id, revision);
		})();
	}

	reportReadiness(input: {
		endpointId: string;
		generationId: string;
		ownerInstanceId: string;
		ownerFence: number;
		deliveryMode: DeliveryMode;
		readiness: EndpointReadinessState;
		controlState?: EndpointControlState;
	}): RuntimeEndpointMutationResult {
		return this.#database.transaction(() => {
			const generationError = this.#validateGeneration(input.generationId);
			if (generationError) return generationError;
			const checked = this.#validateOwner(input);
			if (checked.error) return checked.error;
			const row = checked.row as EndpointRow;
			const now = this.#clock.now();
			const revision = row.revision + 1;
			this.#database
				.prepare(
					"UPDATE endpoint_claims SET delivery_mode = ?, readiness_state = ?, control_state = ?, revision = ? WHERE endpoint_id = ?",
				)
				.run(
					input.deliveryMode,
					input.readiness,
					input.controlState ?? row.control_state,
					revision,
					row.endpoint_id,
				);
			this.#emit({ ...row, revision }, "endpoint.readiness", now);
			return accepted(row.endpoint_id, revision);
		})();
	}

	probe(input: {
		endpointId: string;
		generationId: string;
		ownerInstanceId: string;
		ownerFence: number;
		consumerReady: boolean;
		readiness?: EndpointReadinessState;
	}): RuntimeEndpointMutationResult {
		return this.#database.transaction(() => {
			const generationError = this.#validateGeneration(input.generationId);
			if (generationError) return generationError;
			const checked = this.#validateOwner(input);
			if (checked.error) return checked.error;
			const row = checked.row as EndpointRow;
			const now = this.#clock.now();
			const revision = row.revision + 1;
			const readiness =
				input.readiness ?? (input.consumerReady ? "ready" : "held_waiting");
			this.#database
				.prepare(
					"UPDATE endpoint_claims SET readiness_state = ?, consumer_ready = ?, revision = ? WHERE endpoint_id = ?",
				)
				.run(readiness, input.consumerReady ? 1 : 0, revision, row.endpoint_id);
			this.#emit({ ...row, revision }, "endpoint.consumer_probe", now);
			return accepted(row.endpoint_id, revision);
		})();
	}

	reportDelivery(input: {
		endpointId: string;
		generationId: string;
		ownerInstanceId: string;
		ownerFence: number;
		status: "accepted" | "delivered" | "failed";
		readiness?: EndpointReadinessState;
	}): RuntimeEndpointMutationResult {
		return this.#database.transaction(() => {
			const generationError = this.#validateGeneration(input.generationId);
			if (generationError) return generationError;
			const checked = this.#validateOwner(input);
			if (checked.error) return checked.error;
			const row = checked.row as EndpointRow;
			const now = this.#clock.now();
			const revision = row.revision + 1;
			const readiness =
				input.readiness ??
				(input.status === "failed" ? "unhealthy" : row.readiness_state);
			this.#database
				.prepare(
					"UPDATE endpoint_claims SET readiness_state = ?, delivery_observed = ?, delivery_failed = ?, revision = ? WHERE endpoint_id = ?",
				)
				.run(
					readiness,
					input.status === "delivered" ? 1 : row.delivery_observed,
					input.status === "failed"
						? 1
						: input.status === "delivered"
							? 0
							: row.delivery_failed,
					revision,
					row.endpoint_id,
				);
			this.#emit(
				{ ...row, revision },
				`endpoint.delivery.${input.status}`,
				now,
			);
			return accepted(row.endpoint_id, revision);
		})();
	}

	reportCapability(input: {
		endpointId: string;
		generationId: string;
		ownerInstanceId: string;
		ownerFence: number;
		capability: RuntimeEndpointCapability;
		evidence: Readonly<Record<string, unknown>>;
	}): RuntimeEndpointMutationResult {
		if (!input.capability.capability.trim())
			return rejected("runtime.endpoint.capability_invalid");
		return this.#database.transaction(() => {
			const generationError = this.#validateGeneration(input.generationId);
			if (generationError) return generationError;
			const checked = this.#validateOwner(input);
			if (checked.error) return checked.error;
			const row = checked.row as EndpointRow;
			const now = this.#clock.now();
			const revision = row.revision + 1;
			const id = sha256(
				// A readiness transition can legitimately follow the initial status
				// observation in the same clock tick. Include the observed capability
				// facts, not just the timestamp, so the durable projection records that
				// transition instead of mistaking it for a replay.
				`${row.endpoint_id}:${input.capability.capability}:${input.capability.evidenceKind}:${input.capability.observedAt}:${input.capability.qualification}:${input.capability.deliveryMode}:${input.capability.readiness}:${json(input.evidence)}`,
			).slice(0, 32);
			if (
				this.#database
					.prepare<{ readonly id: string }>(
						"SELECT id FROM capability_observations WHERE id = ?",
					)
					.get(id)
			)
				return {
					disposition: "ignored",
					code: "runtime.endpoint.capability_duplicate",
					endpointId: row.endpoint_id,
					revision: row.revision,
				} as const;
			this.#database
				.prepare(
					"INSERT OR REPLACE INTO capability_observations(id, endpoint_id, capability, adapter_id, adapter_version, qualification_state, delivery_mode, readiness_state, evidence_kind, evidence_json, observed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					row.endpoint_id,
					input.capability.capability,
					input.capability.adapterId,
					input.capability.adapterVersion,
					input.capability.qualification,
					input.capability.deliveryMode,
					input.capability.readiness,
					input.capability.evidenceKind,
					json(input.evidence),
					input.capability.observedAt,
					input.capability.expiresAt ?? null,
				);
			this.#database
				.prepare(
					"UPDATE endpoint_claims SET consumption_observed = CASE WHEN ? = 1 THEN 1 ELSE consumption_observed END, revision = ? WHERE endpoint_id = ?",
				)
				.run(
					consumedEvidence(input.evidence) ? 1 : 0,
					revision,
					row.endpoint_id,
				);
			this.#emit({ ...row, revision }, "endpoint.capability", now);
			return accepted(row.endpoint_id, revision);
		})();
	}

	release(input: {
		endpointId: string;
		generationId: string;
		ownerInstanceId: string;
		ownerFence: number;
	}): RuntimeEndpointMutationResult {
		return this.#database.transaction(() => {
			const generationError = this.#validateGeneration(input.generationId);
			if (generationError) return generationError;
			const checked = this.#validateOwner(input);
			if (checked.error) return checked.error;
			const row = checked.row as EndpointRow;
			const now = this.#clock.now();
			const revision = row.revision + 1;
			this.#database
				.prepare(
					"UPDATE endpoint_claims SET state = 'released', readiness_state = 'uninitialized', control_state = 'disabled', revision = ?, expires_at = NULL WHERE endpoint_id = ?",
				)
				.run(revision, row.endpoint_id);
			this.#emit({ ...row, revision }, "endpoint.released", now);
			return accepted(row.endpoint_id, revision);
		})();
	}

	expire(now = this.#clock.now()): readonly RuntimeEndpointMutationResult[] {
		return this.#database.transaction(() => {
			const rows = this.#database
				.prepare<ExpiryRow>(
					"SELECT endpoint_claims.endpoint_id, endpoint_claims.generation_id, endpoint_claims.route_kind, endpoint_claims.revision, endpoint_claims.state, endpoint_claims.owner_fence, endpoint_claims.owner_instance_id, endpoint_claims.delivery_mode, endpoint_claims.readiness_state, endpoint_claims.control_state, endpoint_claims.consumer_ready, endpoint_claims.consumption_observed, endpoint_claims.delivery_observed, endpoint_claims.delivery_failed, endpoint_claims.claimed_at, endpoint_claims.heartbeat_at, endpoint_claims.expires_at, endpoint_claims.superseded_at, session_generations.lifecycle_state AS generation_lifecycle_state FROM endpoint_claims JOIN session_generations ON session_generations.generation_id = endpoint_claims.generation_id WHERE endpoint_claims.state IN ('claiming', 'healthy', 'degraded') AND endpoint_claims.expires_at IS NOT NULL AND endpoint_claims.expires_at <= ? ORDER BY endpoint_claims.generation_id, endpoint_claims.route_kind, endpoint_claims.owner_fence",
				)
				.all(now);
			return rows.map((row) => {
				if (terminal(row.generation_lifecycle_state))
					return rejected("runtime.endpoint.generation_terminal", {
						remedy: "select a non-terminal generation",
					});
				const revision = row.revision + 1;
				this.#database
					.prepare(
						"UPDATE endpoint_claims SET state = 'expired', readiness_state = 'uninitialized', control_state = 'disabled', revision = ?, superseded_at = NULL, expires_at = NULL WHERE endpoint_id = ?",
					)
					.run(revision, row.endpoint_id);
				this.#emit({ ...row, revision }, "endpoint.expired", now);
				return accepted(row.endpoint_id, revision);
			});
		})();
	}

	#getCapabilities(
		endpointId: string,
		redact = true,
	): readonly RuntimeEndpointCapability[] {
		return Object.freeze(
			this.#database
				.prepare<CapabilityRow>(
					"SELECT id, capability, adapter_id, adapter_version, qualification_state, delivery_mode, readiness_state, evidence_kind, observed_at, expires_at FROM capability_observations WHERE endpoint_id = ? ORDER BY observed_at DESC, id DESC",
				)
				.all(endpointId)
				.map((row) =>
					Object.freeze({
						capability: redact
							? redactIdentifier(row.capability)
							: row.capability,
						adapterId: redact
							? redactIdentifier(row.adapter_id)
							: row.adapter_id,
						adapterVersion: row.adapter_version,
						qualification: row.qualification_state,
						deliveryMode: row.delivery_mode,
						readiness: row.readiness_state,
						evidenceKind: row.evidence_kind,
						observedAt: row.observed_at,
						...(row.expires_at ? { expiresAt: row.expires_at } : {}),
					}),
				),
		);
	}

	#viewRow(row: EndpointRow): RuntimeEndpointView {
		return Object.freeze({
			endpointId: redactIdentifier(row.endpoint_id),
			generationId: row.generation_id,
			routeKind: row.route_kind,
			revision: row.revision,
			state: row.state,
			ownerFence: row.owner_fence,
			ownerInstanceId: redactIdentifier(row.owner_instance_id),
			deliveryMode: row.delivery_mode,
			readiness: row.readiness_state,
			controlState: row.control_state,
			consumerReady: row.consumer_ready === 1,
			consumptionObserved: row.consumption_observed === 1,
			deliveryObserved: row.delivery_observed === 1,
			deliveryFailed: row.delivery_failed === 1,
			claimedAt: row.claimed_at,
			...(row.heartbeat_at ? { heartbeatAt: row.heartbeat_at } : {}),
			...(row.expires_at ? { expiresAt: row.expires_at } : {}),
			...(row.superseded_at ? { supersededAt: row.superseded_at } : {}),
			capabilities: this.#getCapabilities(row.endpoint_id),
		});
	}

	get(endpointId: string): RuntimeEndpointView | undefined {
		const row = this.#row(endpointId);
		return row ? this.#viewRow(row) : undefined;
	}

	list(generationId: string): readonly RuntimeEndpointView[] {
		return Object.freeze(
			this.#database
				.prepare<EndpointRow>(
					"SELECT endpoint_id, generation_id, route_kind, revision, state, owner_fence, owner_instance_id, delivery_mode, readiness_state, control_state, consumer_ready, consumption_observed, delivery_observed, delivery_failed, claimed_at, heartbeat_at, expires_at, superseded_at FROM endpoint_claims WHERE generation_id = ? ORDER BY route_kind, owner_fence DESC, endpoint_id",
				)
				.all(generationId)
				.map((row) => this.#viewRow(row)),
		);
	}

	eligibility(input: {
		generationId: string;
		routeKind: EndpointRouteKind;
		requiredCapability?: string;
		expectedOwnerFence?: number;
		expectedFence?: number;
		now?: string;
	}): RuntimeEndpointEligibility {
		return this.#classifyEligibility(input, ["ready"], false);
	}

	deliveryEligibility(input: {
		generationId: string;
		routeKind: EndpointRouteKind;
		requiredCapability?: string;
		expectedOwnerFence?: number;
		expectedFence?: number;
		now?: string;
	}): RuntimeEndpointDeliveryEligibility {
		const result = this.#classifyEligibility(
			input,
			["ready", "pull_only", "next_turn"],
			true,
		);
		if (result.disposition !== "eligible" || !result.endpoint)
			return Object.freeze({ ...result, disposition: "ineligible" as const });
		const disposition =
			result.endpoint.readiness === "ready"
				? "ready"
				: result.endpoint.readiness === "pull_only"
					? "pull_only"
					: "next_turn";
		return Object.freeze({ ...result, disposition });
	}

	#classifyEligibility(
		input: {
			generationId: string;
			routeKind: EndpointRouteKind;
			requiredCapability?: string;
			expectedOwnerFence?: number;
			expectedFence?: number;
			now?: string;
		},
		acceptedReadiness: readonly EndpointReadinessState[],
		requireControl: boolean,
	): RuntimeEndpointEligibility {
		const now = input.now ?? this.#clock.now();
		const generation = this.#database
			.prepare<GenerationRow>(
				"SELECT lifecycle_state FROM session_generations WHERE generation_id = ?",
			)
			.get(input.generationId);
		const facts = {
			generationId: input.generationId,
			routeKind: input.routeKind,
		} as Record<string, string | number | boolean>;
		if (!generation)
			return {
				disposition: "ineligible",
				code: "runtime.endpoint.generation_unresolved",
				remedy: "select a known generation",
				facts,
			};
		if (terminal(generation.lifecycle_state))
			return {
				disposition: "ineligible",
				code: "runtime.endpoint.generation_terminal",
				remedy: "select a non-terminal generation",
				facts,
			};
		const row = this.#database
			.prepare<EndpointRow>(
				"SELECT endpoint_id, generation_id, route_kind, revision, state, owner_fence, owner_instance_id, delivery_mode, readiness_state, control_state, consumer_ready, consumption_observed, delivery_observed, delivery_failed, claimed_at, heartbeat_at, expires_at, superseded_at FROM endpoint_claims WHERE generation_id = ? AND route_kind = ? AND state IN ('claiming', 'healthy', 'degraded') ORDER BY owner_fence DESC LIMIT 1",
			)
			.get(input.generationId, input.routeKind);
		if (!row)
			return {
				disposition: "ineligible",
				code: "runtime.endpoint.unclaimed",
				remedy: "claim the endpoint",
				facts,
			};
		const endpoint = this.#viewRow(row);
		const endpointFacts = {
			...facts,
			endpointId: redactIdentifier(row.endpoint_id),
			ownerFence: row.owner_fence,
		};
		const expectedFence = input.expectedOwnerFence ?? input.expectedFence;
		if (expectedFence !== undefined && expectedFence !== row.owner_fence)
			return {
				disposition: "ineligible",
				code: "runtime.endpoint.queued_fence_stale",
				remedy: "refresh endpoint eligibility before delivery",
				endpoint,
				facts: {
					...endpointFacts,
					expectedFence,
					currentFence: row.owner_fence,
				},
			};
		if (row.expires_at && compareTime(row.expires_at, now) <= 0)
			return {
				disposition: "ineligible",
				code: "runtime.endpoint.lease_expired",
				remedy: "renew the endpoint lease",
				endpoint,
				facts: endpointFacts,
			};
		if (row.state !== "healthy")
			return {
				disposition: "ineligible",
				code: "runtime.endpoint.health_unready",
				remedy: "report a healthy endpoint",
				endpoint,
				facts: endpointFacts,
			};
		if (
			row.control_state !== "enabled" &&
			(input.routeKind === "control" || requireControl)
		)
			return {
				disposition: "ineligible",
				code: "runtime.endpoint.control_disabled",
				remedy: "enable endpoint control",
				endpoint,
				facts: endpointFacts,
			};
		if (!acceptedReadiness.includes(row.readiness_state))
			return {
				disposition: "ineligible",
				code: "runtime.endpoint.readiness_unready",
				remedy: "report delivery readiness",
				endpoint,
				facts: endpointFacts,
			};
		if (!input.requiredCapability)
			return {
				disposition: "eligible",
				code: "runtime.endpoint.eligible",
				remedy: "none",
				endpoint,
				facts: endpointFacts,
			};
		if (!row.consumer_ready)
			return {
				disposition: "ineligible",
				code: "runtime.endpoint.consumer_unready",
				remedy: "probe a ready consumer",
				endpoint,
				facts: endpointFacts,
			};
		// A managed App Server can prove its addressed consumer before the first
		// human envelope arrives (for example, by completing its authenticated MCP
		// status probe). Treat that canonical consumption evidence as sufficient to
		// admit the first durable delivery; otherwise delivery readiness would be a
		// circular condition that no new endpoint could satisfy.
		if (
			row.delivery_failed ||
			(!row.delivery_observed && !row.consumption_observed)
		)
			return {
				disposition: "ineligible",
				code: "runtime.endpoint.delivery_unready",
				remedy: "report successful delivery",
				endpoint,
				facts: endpointFacts,
			};
		const storedCapability = this.#getCapabilities(row.endpoint_id, false).find(
			(candidate) =>
				candidate.capability === input.requiredCapability &&
				(!candidate.expiresAt || compareTime(candidate.expiresAt, now) > 0),
		);
		if (!storedCapability)
			return {
				disposition: "ineligible",
				code: "runtime.endpoint.capability_unqualified",
				remedy: "report verified capability evidence",
				endpoint,
				facts: endpointFacts,
			};
		const capability = Object.freeze({
			...storedCapability,
			capability: redactIdentifier(storedCapability.capability),
			adapterId: redactIdentifier(storedCapability.adapterId),
		});
		const capabilityFacts = {
			...endpointFacts,
			capability: redactIdentifier(capability.capability),
		};
		if (capability.deliveryMode !== row.delivery_mode)
			return {
				disposition: "ineligible",
				code: "runtime.endpoint.capability_mode_mismatch",
				remedy: "report capability for endpoint delivery mode",
				endpoint,
				capability,
				facts: capabilityFacts,
			};
		if (capability.qualification !== "supported")
			return {
				disposition: "ineligible",
				code: "runtime.endpoint.capability_unqualified",
				remedy: "report supported capability evidence",
				endpoint,
				capability,
				facts: capabilityFacts,
			};
		if (capability.readiness !== row.readiness_state)
			return {
				disposition: "ineligible",
				code: "runtime.endpoint.capability_unready",
				remedy: "report ready capability evidence",
				endpoint,
				capability,
				facts: capabilityFacts,
			};
		if (!row.consumption_observed)
			return {
				disposition: "ineligible",
				code: "runtime.endpoint.capability_consumption_unverified",
				remedy: "report verified consumption evidence",
				endpoint,
				capability,
				facts: capabilityFacts,
			};
		return {
			disposition: "eligible",
			code: "runtime.endpoint.eligible",
			remedy: "none",
			endpoint,
			capability,
			facts: capabilityFacts,
		};
	}
}
