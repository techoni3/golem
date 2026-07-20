import crypto from "node:crypto";

import type { SqliteConnection } from "./internals.js";
import type {
	ClaimedTrackerDeliveryEnvelope,
	ClaimedTrackerPassiveBatch,
	TrackerAppendBusEventResult,
	TrackerBusEvent,
	TrackerCreateEnvelopeResult,
	TrackerDeliveryEligibility,
	TrackerDeliveryEnvelope,
	TrackerJsonObject,
	TrackerPendingSubscriptionEvents,
	TrackerStorageCapability,
	TrackerSubscription,
} from "./types.js";

type EnvelopeStatus = TrackerDeliveryEnvelope["status"];

interface EnvelopeRow {
	readonly id: string;
	readonly root_id: string;
	readonly parent_id: string | null;
	readonly idempotency_key: string;
	readonly fingerprint: string;
	readonly sender_id: string;
	readonly recipient_id: string;
	readonly reply_to_recipient_id: string | null;
	readonly kind: string;
	readonly payload_json: string;
	readonly endpoint_json: string;
	readonly status: EnvelopeStatus;
	readonly attempts: number;
	readonly max_attempts: number;
	readonly deadline_at: string | null;
	readonly next_attempt_at: string | null;
	readonly claim_owner: string | null;
	readonly claim_token: string | null;
	readonly claim_until: string | null;
	readonly created_at: string;
}

interface EventRow {
	readonly sequence: number;
	readonly id: string;
	readonly deduplication_key: string;
	readonly fingerprint: string;
	readonly topic: string;
	readonly class: TrackerBusEvent["class"];
	readonly payload_json: string;
	readonly created_at: string;
}

interface SubscriptionRow {
	readonly id: string;
	readonly name: string;
	readonly recipient_id: string;
	readonly topic: string;
	readonly classes_json: string;
	readonly cursor_sequence: number;
	readonly manual: number;
	readonly status: TrackerSubscription["status"];
	readonly created_at: string;
}

interface PassiveRow {
	readonly sequence: number;
	readonly recipient_id: string;
	readonly ticket_id: string;
	readonly category: string;
	readonly baseline_json: string;
	readonly value_json: string;
	readonly event_id: string;
}

interface PassiveCursorRow {
	readonly recipient_id: string;
	readonly cursor_sequence: number;
	readonly pending_json: string | null;
	readonly pending_to_sequence: number | null;
	readonly lease_id: string | null;
	readonly lease_until: string | null;
}

function parseObject(value: string): TrackerJsonObject {
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as TrackerJsonObject)
			: {};
	} catch {
		return {};
	}
}

function parseClasses(value: string): readonly TrackerBusEvent["class"][] {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return ["tracker", "lifecycle", "custom"];
		const classes = parsed.filter(
			(item): item is TrackerBusEvent["class"] =>
				item === "tracker" || item === "lifecycle" || item === "custom",
		);
		return classes.length > 0
			? Object.freeze(classes)
			: ["tracker", "lifecycle", "custom"];
	} catch {
		return ["tracker", "lifecycle", "custom"];
	}
}

function endpoint(value: string): TrackerDeliveryEligibility {
	const candidate = parseObject(value) as Partial<TrackerDeliveryEligibility>;
	const capabilities = Array.isArray(candidate.capabilities)
		? candidate.capabilities.filter(
				(item): item is TrackerDeliveryEligibility["capabilities"][number] =>
					Boolean(item) &&
					typeof item === "object" &&
					typeof (item as { capability?: unknown }).capability === "string" &&
					typeof (item as { qualification?: unknown }).qualification ===
						"string" &&
					typeof (item as { observedAt?: unknown }).observedAt === "string",
			)
		: [];
	return Object.freeze({
		recipientId: String(candidate.recipientId ?? ""),
		generationId: String(candidate.generationId ?? ""),
		endpointId: String(candidate.endpointId ?? ""),
		ownerFence: Number(candidate.ownerFence ?? 0),
		readiness: candidate.readiness ?? "uninitialized",
		mode: candidate.mode ?? "pull",
		capabilities: Object.freeze(capabilities.map((item) => ({ ...item }))),
	});
}

function hydrateEnvelope(row: EnvelopeRow): TrackerDeliveryEnvelope {
	return Object.freeze({
		id: row.id,
		rootId: row.root_id,
		...(row.parent_id ? { parentId: row.parent_id } : {}),
		idempotencyKey: row.idempotency_key,
		senderId: row.sender_id,
		recipientId: row.recipient_id,
		...(row.reply_to_recipient_id
			? { replyToRecipientId: row.reply_to_recipient_id }
			: {}),
		kind: row.kind,
		payload: parseObject(row.payload_json),
		endpoint: endpoint(row.endpoint_json),
		status: row.status,
		attempts: Number(row.attempts),
		maxAttempts: Number(row.max_attempts),
		...(row.deadline_at ? { deadlineAt: row.deadline_at } : {}),
		...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
		createdAt: row.created_at,
	});
}

function hydrateClaim(row: EnvelopeRow): ClaimedTrackerDeliveryEnvelope {
	if (!row.claim_owner || !row.claim_token || !row.claim_until)
		throw new Error("claimed tracker envelope is missing its lease facts");
	return Object.freeze({
		...hydrateEnvelope(row),
		status: "claimed",
		claimOwner: row.claim_owner,
		claimToken: row.claim_token,
		claimUntil: row.claim_until,
	});
}

function hydrateEvent(row: EventRow): TrackerBusEvent {
	return Object.freeze({
		sequence: Number(row.sequence),
		id: row.id,
		deduplicationKey: row.deduplication_key,
		topic: row.topic,
		class: row.class,
		payload: parseObject(row.payload_json),
		createdAt: row.created_at,
	});
}

function hydrateSubscription(row: SubscriptionRow): TrackerSubscription {
	return Object.freeze({
		id: row.id,
		name: row.name,
		recipientId: row.recipient_id,
		topic: row.topic,
		classes: parseClasses(row.classes_json),
		cursor: Number(row.cursor_sequence),
		manual: row.manual === 1,
		status: row.status,
		createdAt: row.created_at,
	});
}

function passiveEntry(row: PassiveRow) {
	return Object.freeze({
		recipientId: row.recipient_id,
		ticketId: row.ticket_id,
		category: row.category,
		baseline: parseObject(row.baseline_json),
		value: parseObject(row.value_json),
		eventId: row.event_id,
	});
}

function json(value: unknown): string {
	return JSON.stringify(value);
}

function redactDiagnostic(value: string): string {
	return value
		.replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, "Bearer [REDACTED]")
		.replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY))=\S+/gu, "$1=[REDACTED]")
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@")
		.slice(0, 1_024);
}

/** Private SQLite implementation, instantiated only by PersistenceOwner. */
export class TrackerRepository implements TrackerStorageCapability {
	readonly #database: SqliteConnection;

	constructor(database: SqliteConnection) {
		this.#database = database;
	}

	#audit(
		kind: string,
		subjectId: string,
		details: TrackerJsonObject,
		now: string,
	): void {
		this.#database
			.prepare(
				"INSERT INTO tracker_delivery_audit(id, kind, subject_id, details_json, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(crypto.randomUUID(), kind, subjectId, json(details), now);
	}

	#create(
		envelope: TrackerDeliveryEnvelope,
		fingerprint: string,
	): TrackerCreateEnvelopeResult {
		const existingId = this.#database
			.prepare<EnvelopeRow>("SELECT * FROM tracker_envelopes WHERE id = ?")
			.get(envelope.id);
		if (existingId)
			return existingId.fingerprint === fingerprint
				? { kind: "duplicate", envelope: hydrateEnvelope(existingId) }
				: { kind: "conflict", reason: "id" };
		const existingKey = this.#database
			.prepare<EnvelopeRow>(
				"SELECT * FROM tracker_envelopes WHERE idempotency_key = ?",
			)
			.get(envelope.idempotencyKey);
		if (existingKey)
			return existingKey.fingerprint === fingerprint
				? { kind: "duplicate", envelope: hydrateEnvelope(existingKey) }
				: { kind: "conflict", reason: "idempotency_key" };
		this.#database
			.prepare(
				"INSERT INTO tracker_envelopes(id, root_id, parent_id, idempotency_key, fingerprint, sender_id, recipient_id, reply_to_recipient_id, kind, payload_json, endpoint_json, status, attempts, max_attempts, deadline_at, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				envelope.id,
				envelope.rootId,
				envelope.parentId ?? null,
				envelope.idempotencyKey,
				fingerprint,
				envelope.senderId,
				envelope.recipientId,
				envelope.replyToRecipientId ?? null,
				envelope.kind,
				json(envelope.payload),
				json(envelope.endpoint),
				envelope.status,
				envelope.attempts,
				envelope.maxAttempts,
				envelope.deadlineAt ?? null,
				envelope.nextAttemptAt ?? null,
				envelope.createdAt,
			);
		return { kind: "created", envelope };
	}

	createEnvelope(input: {
		readonly envelope: TrackerDeliveryEnvelope;
		readonly fingerprint: string;
	}): TrackerCreateEnvelopeResult {
		return this.#database.transaction((): TrackerCreateEnvelopeResult => {
			const result = this.#create(input.envelope, input.fingerprint);
			if (result.kind === "created")
				this.#audit(
					"envelope.created",
					input.envelope.id,
					{ recipient_id: input.envelope.recipientId },
					input.envelope.createdAt,
				);
			return result;
		})();
	}

	#recover(now: string): readonly TrackerDeliveryEnvelope[] {
		const expired = this.#database
			.prepare<EnvelopeRow>(
				"SELECT * FROM tracker_envelopes WHERE status IN ('pending', 'claimed', 'retrying') AND deadline_at IS NOT NULL AND deadline_at <= ? ORDER BY created_at, id",
			)
			.all(now);
		const leased = this.#database
			.prepare<EnvelopeRow>(
				"SELECT * FROM tracker_envelopes WHERE status = 'claimed' AND claim_until <= ? ORDER BY claim_until, id",
			)
			.all(now);
		const settled: TrackerDeliveryEnvelope[] = [];
		for (const row of expired) {
			this.#database
				.prepare(
					"UPDATE tracker_envelopes SET status = 'expired', claim_owner = NULL, claim_token = NULL, claim_until = NULL, next_attempt_at = NULL, last_error = 'delivery deadline elapsed' WHERE id = ? AND status IN ('pending', 'claimed', 'retrying')",
				)
				.run(row.id);
			const updated = this.#database
				.prepare<EnvelopeRow>("SELECT * FROM tracker_envelopes WHERE id = ?")
				.get(row.id);
			if (updated) {
				settled.push(hydrateEnvelope(updated));
				this.#audit("envelope.expired", row.id, {}, now);
			}
		}
		for (const row of leased) {
			if (row.deadline_at && row.deadline_at <= now) continue;
			const exhausted = Number(row.attempts) >= Number(row.max_attempts);
			const changed = this.#database
				.prepare(
					"UPDATE tracker_envelopes SET status = ?, claim_owner = NULL, claim_token = NULL, claim_until = NULL, next_attempt_at = ?, last_error = ? WHERE id = ? AND status = 'claimed' AND claim_token = ?",
				)
				.run(
					exhausted ? "dead_letter" : "retrying",
					exhausted ? null : now,
					exhausted
						? "claim lease expired after final attempt"
						: "claim lease expired",
					row.id,
					row.claim_token,
				).changes;
			if (changed !== 1) continue;
			const updated = this.#database
				.prepare<EnvelopeRow>("SELECT * FROM tracker_envelopes WHERE id = ?")
				.get(row.id);
			if (updated) {
				settled.push(hydrateEnvelope(updated));
				this.#audit(
					exhausted ? "envelope.dead_letter" : "envelope.lease_replayed",
					row.id,
					{},
					now,
				);
			}
		}
		return Object.freeze(settled);
	}

	claimEnvelopes(input: {
		readonly workerId: string;
		readonly now: string;
		readonly claimUntil: string;
		readonly limit: number;
	}): readonly ClaimedTrackerDeliveryEnvelope[] {
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#recover(input.now);
			const candidates = this.#database
				.prepare<EnvelopeRow>(
					"SELECT * FROM tracker_envelopes WHERE status IN ('pending', 'retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND (deadline_at IS NULL OR deadline_at > ?) AND attempts < max_attempts ORDER BY created_at, id LIMIT ?",
				)
				.all(input.now, input.now, input.limit);
			const claims: ClaimedTrackerDeliveryEnvelope[] = [];
			for (const candidate of candidates) {
				const token = crypto.randomUUID();
				const changed = this.#database
					.prepare(
						"UPDATE tracker_envelopes SET status = 'claimed', attempts = attempts + 1, claim_owner = ?, claim_token = ?, claim_until = ?, next_attempt_at = NULL WHERE id = ? AND status IN ('pending', 'retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)",
					)
					.run(
						input.workerId,
						token,
						input.claimUntil,
						candidate.id,
						input.now,
					).changes;
				if (changed !== 1) continue;
				const row = this.#database
					.prepare<EnvelopeRow>("SELECT * FROM tracker_envelopes WHERE id = ?")
					.get(candidate.id);
				if (!row) throw new Error("claimed tracker envelope disappeared");
				claims.push(hydrateClaim(row));
				this.#audit(
					"envelope.claimed",
					candidate.id,
					{ worker_id: input.workerId },
					input.now,
				);
			}
			this.#database.exec("COMMIT");
			return Object.freeze(claims);
		} catch (error) {
			try {
				this.#database.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	settleEnvelope(input: {
		readonly id: string;
		readonly claimToken: string;
		readonly now: string;
		readonly status:
			| "pending"
			| "delivered"
			| "retrying"
			| "dead_letter"
			| "expired";
		readonly nextAttemptAt?: string;
		readonly error?: string;
	}): TrackerDeliveryEnvelope | undefined {
		return this.#database.transaction(
			(): TrackerDeliveryEnvelope | undefined => {
				const changed = this.#database
					.prepare(
						"UPDATE tracker_envelopes SET status = ?, claim_owner = CASE WHEN ? = 'delivered' THEN claim_owner ELSE NULL END, claim_token = CASE WHEN ? = 'delivered' THEN claim_token ELSE NULL END, claim_until = CASE WHEN ? = 'delivered' THEN claim_until ELSE NULL END, next_attempt_at = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END, last_error = ? WHERE id = ? AND status = 'claimed' AND claim_token = ?",
					)
					.run(
						input.status,
						input.status,
						input.status,
						input.status,
						input.nextAttemptAt ?? null,
						input.status,
						input.now,
						input.error ? redactDiagnostic(input.error) : null,
						input.id,
						input.claimToken,
					).changes;
				if (changed !== 1) return undefined;
				const row = this.#database
					.prepare<EnvelopeRow>("SELECT * FROM tracker_envelopes WHERE id = ?")
					.get(input.id);
				if (!row) return undefined;
				this.#audit(
					`envelope.${input.status}`,
					input.id,
					{ error: input.error ? redactDiagnostic(input.error) : null },
					input.now,
				);
				return hydrateEnvelope(row);
			},
		)();
	}

	acknowledgeEnvelope(input: {
		readonly id: string;
		readonly claimToken: string;
		readonly acknowledgementId: string;
		readonly recipientId: string;
		readonly payload: TrackerJsonObject;
		readonly now: string;
	}): boolean {
		return this.#database.transaction((): boolean => {
			const row = this.#database
				.prepare<EnvelopeRow>("SELECT * FROM tracker_envelopes WHERE id = ?")
				.get(input.id);
			if (!row || row.recipient_id !== input.recipientId) return false;
			const existing = this.#database
				.prepare<{ readonly payload_json: string }>(
					"SELECT payload_json FROM tracker_envelope_acknowledgements WHERE envelope_id = ? AND acknowledgement_id = ?",
				)
				.get(input.id, input.acknowledgementId);
			if (row.status === "acknowledged")
				return Boolean(
					existing && existing.payload_json === json(input.payload),
				);
			if (
				!["claimed", "delivered"].includes(row.status) ||
				row.claim_token !== input.claimToken
			)
				return false;
			const inserted = this.#database
				.prepare(
					"INSERT OR IGNORE INTO tracker_envelope_acknowledgements(envelope_id, acknowledgement_id, recipient_id, payload_json, acknowledged_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run(
					input.id,
					input.acknowledgementId,
					input.recipientId,
					json(input.payload),
					input.now,
				).changes;
			if (inserted === 0) return existing?.payload_json === json(input.payload);
			const settled = this.#database
				.prepare(
					"UPDATE tracker_envelopes SET status = 'acknowledged', acknowledged_at = COALESCE(acknowledged_at, ?), claim_owner = NULL, claim_token = NULL, claim_until = NULL WHERE id = ? AND recipient_id = ? AND status IN ('claimed', 'delivered') AND claim_token = ?",
				)
				.run(input.now, input.id, input.recipientId, input.claimToken).changes;
			if (settled !== 1) return false;
			this.#audit(
				"envelope.acknowledged",
				input.id,
				{ recipient_id: input.recipientId },
				input.now,
			);
			return true;
		})();
	}

	createReplyEnvelope(input: {
		readonly parentId: string;
		readonly claimToken: string;
		readonly envelope: TrackerDeliveryEnvelope;
		readonly fingerprint: string;
	}): TrackerCreateEnvelopeResult {
		return this.#database.transaction((): TrackerCreateEnvelopeResult => {
			const parent = this.#database
				.prepare<EnvelopeRow>("SELECT * FROM tracker_envelopes WHERE id = ?")
				.get(input.parentId);
			if (!parent) return { kind: "conflict", reason: "id" };
			if (
				parent.reply_to_recipient_id !== input.envelope.recipientId ||
				parent.recipient_id !== input.envelope.senderId ||
				!["claimed", "delivered"].includes(parent.status) ||
				parent.claim_token !== input.claimToken
			)
				throw new Error(
					"reply envelope does not match its durable reply route",
				);
			const result = this.#create(input.envelope, input.fingerprint);
			if (result.kind === "created")
				this.#audit(
					"envelope.reply_created",
					input.envelope.id,
					{ parent_id: input.parentId },
					input.envelope.createdAt,
				);
			return result;
		})();
	}

	recoverEnvelopes(now: string): readonly TrackerDeliveryEnvelope[] {
		return this.#database.transaction(() => this.#recover(now))();
	}

	appendBusEvent(input: {
		readonly event: Omit<TrackerBusEvent, "sequence">;
		readonly fingerprint: string;
	}): TrackerAppendBusEventResult {
		return this.#database.transaction((): TrackerAppendBusEventResult => {
			const byId = this.#database
				.prepare<EventRow>("SELECT * FROM tracker_bus_events WHERE id = ?")
				.get(input.event.id);
			if (byId)
				return byId.fingerprint === input.fingerprint
					? { kind: "duplicate", event: hydrateEvent(byId) }
					: { kind: "conflict", reason: "id" };
			const byKey = this.#database
				.prepare<EventRow>(
					"SELECT * FROM tracker_bus_events WHERE deduplication_key = ?",
				)
				.get(input.event.deduplicationKey);
			if (byKey)
				return byKey.fingerprint === input.fingerprint
					? { kind: "duplicate", event: hydrateEvent(byKey) }
					: { kind: "conflict", reason: "deduplication_key" };
			this.#database
				.prepare(
					"INSERT INTO tracker_bus_events(id, deduplication_key, fingerprint, topic, class, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					input.event.id,
					input.event.deduplicationKey,
					input.fingerprint,
					input.event.topic,
					input.event.class,
					json(input.event.payload),
					input.event.createdAt,
				);
			const row = this.#database
				.prepare<EventRow>("SELECT * FROM tracker_bus_events WHERE id = ?")
				.get(input.event.id);
			if (!row) throw new Error("created bus event disappeared");
			this.#audit("bus.appended", row.id, { topic: row.topic }, row.created_at);
			return { kind: "created", event: hydrateEvent(row) };
		})();
	}

	upsertSubscription(input: TrackerSubscription): TrackerSubscription {
		return this.#database.transaction(() => {
			this.#database
				.prepare(
					"INSERT INTO tracker_subscriptions(id, name, recipient_id, topic, classes_json, cursor_sequence, manual, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(recipient_id, name) DO UPDATE SET topic = excluded.topic, classes_json = excluded.classes_json, cursor_sequence = MAX(tracker_subscriptions.cursor_sequence, excluded.cursor_sequence), manual = excluded.manual, status = excluded.status",
				)
				.run(
					input.id,
					input.name,
					input.recipientId,
					input.topic,
					json(input.classes),
					input.cursor,
					input.manual ? 1 : 0,
					input.status,
					input.createdAt,
				);
			const row = this.#database
				.prepare<SubscriptionRow>(
					"SELECT * FROM tracker_subscriptions WHERE recipient_id = ? AND name = ?",
				)
				.get(input.recipientId, input.name);
			if (!row) throw new Error("subscription upsert disappeared");
			this.#audit(
				"subscription.upserted",
				row.id,
				{ recipient_id: row.recipient_id },
				input.createdAt,
			);
			return hydrateSubscription(row);
		})();
	}

	pendingSubscriptionEvents(input: {
		readonly id: string;
		readonly limit: number;
	}): TrackerPendingSubscriptionEvents | undefined {
		const subscriptionRow = this.#database
			.prepare<SubscriptionRow>(
				"SELECT * FROM tracker_subscriptions WHERE id = ?",
			)
			.get(input.id);
		if (subscriptionRow?.status !== "active") return undefined;
		const subscription = hydrateSubscription(subscriptionRow);
		const placeholders = subscription.classes.map(() => "?").join(", ");
		const rows = this.#database
			.prepare<EventRow>(
				`SELECT * FROM tracker_bus_events WHERE topic = ? AND sequence > ? AND class IN (${placeholders}) ORDER BY sequence ASC LIMIT ?`,
			)
			.all(
				subscription.topic,
				subscription.cursor,
				...subscription.classes,
				input.limit,
			);
		const events = rows.map(hydrateEvent);
		return Object.freeze({
			subscription,
			events: Object.freeze(events),
			fromSequence: subscription.cursor,
			toSequence: events.at(-1)?.sequence ?? subscription.cursor,
		});
	}

	advanceSubscriptionCursor(input: {
		readonly id: string;
		readonly fromSequence: number;
		readonly toSequence: number;
	}): boolean {
		if (input.toSequence < input.fromSequence) return false;
		return (
			this.#database
				.prepare(
					"UPDATE tracker_subscriptions SET cursor_sequence = ? WHERE id = ? AND cursor_sequence = ? AND status = 'active'",
				)
				.run(input.toSequence, input.id, input.fromSequence).changes === 1
		);
	}

	upsertPassiveDelta(input: {
		readonly recipientId: string;
		readonly ticketId: string;
		readonly category: string;
		readonly baseline: TrackerJsonObject;
		readonly value: TrackerJsonObject;
		readonly eventId: string;
		readonly now: string;
	}): void {
		this.#database.transaction(() => {
			this.#database
				.prepare(
					"INSERT INTO tracker_passive_slots(recipient_id, ticket_id, category, baseline_json, value_json, event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(recipient_id, ticket_id, category) DO UPDATE SET sequence = (SELECT COALESCE(MAX(sequence), 0) + 1 FROM tracker_passive_slots), value_json = excluded.value_json, event_id = excluded.event_id, updated_at = excluded.updated_at",
				)
				.run(
					input.recipientId,
					input.ticketId,
					input.category,
					json(input.baseline),
					json(input.value),
					input.eventId,
					input.now,
					input.now,
				);
			this.#audit(
				"passive.coalesced",
				input.eventId,
				{ recipient_id: input.recipientId },
				input.now,
			);
		})();
	}

	claimPassiveBatch(input: {
		readonly recipientId: string;
		readonly leaseId: string;
		readonly leaseUntil: string;
		readonly now: string;
	}): ClaimedTrackerPassiveBatch | undefined {
		return this.#database.transaction(() => {
			let cursor = this.#database
				.prepare<PassiveCursorRow>(
					"SELECT * FROM tracker_passive_cursors WHERE recipient_id = ?",
				)
				.get(input.recipientId);
			if (
				cursor?.lease_id &&
				cursor.lease_until &&
				cursor.lease_until > input.now
			)
				return undefined;
			if (!cursor) {
				this.#database
					.prepare(
						"INSERT INTO tracker_passive_cursors(recipient_id, cursor_sequence, updated_at) VALUES (?, 0, ?)",
					)
					.run(input.recipientId, input.now);
				cursor = this.#database
					.prepare<PassiveCursorRow>(
						"SELECT * FROM tracker_passive_cursors WHERE recipient_id = ?",
					)
					.get(input.recipientId);
			}
			if (!cursor) throw new Error("passive cursor creation disappeared");
			let entries: readonly ReturnType<typeof passiveEntry>[];
			let toSequence: number;
			if (cursor.pending_json && cursor.pending_to_sequence !== null) {
				const parsed = JSON.parse(cursor.pending_json) as unknown;
				entries = Array.isArray(parsed)
					? Object.freeze(parsed as readonly ReturnType<typeof passiveEntry>[])
					: [];
				toSequence = cursor.pending_to_sequence;
			} else {
				const rows = this.#database
					.prepare<PassiveRow>(
						"SELECT * FROM tracker_passive_slots WHERE recipient_id = ? AND sequence > ? ORDER BY sequence ASC",
					)
					.all(input.recipientId, cursor.cursor_sequence);
				if (rows.length === 0) return undefined;
				entries = Object.freeze(rows.map(passiveEntry));
				toSequence = Number(rows.at(-1)?.sequence);
				this.#database
					.prepare(
						"UPDATE tracker_passive_cursors SET pending_json = ?, pending_to_sequence = ?, updated_at = ? WHERE recipient_id = ?",
					)
					.run(json(entries), toSequence, input.now, input.recipientId);
			}
			const claimed = this.#database
				.prepare(
					"UPDATE tracker_passive_cursors SET lease_id = ?, lease_until = ?, updated_at = ? WHERE recipient_id = ? AND (lease_id IS NULL OR lease_until <= ?)",
				)
				.run(
					input.leaseId,
					input.leaseUntil,
					input.now,
					input.recipientId,
					input.now,
				).changes;
			if (claimed !== 1) return undefined;
			this.#audit(
				"passive.claimed",
				input.leaseId,
				{ recipient_id: input.recipientId },
				input.now,
			);
			return Object.freeze({
				recipientId: input.recipientId,
				leaseId: input.leaseId,
				leaseUntil: input.leaseUntil,
				cursor: cursor.cursor_sequence,
				body: entries
					.map((entry) => `- ${entry.ticketId}: ${entry.category}`)
					.join("\n"),
				entries,
			});
		})();
	}

	commitPassiveBatch(input: {
		readonly recipientId: string;
		readonly leaseId: string;
		readonly now: string;
	}): boolean {
		return this.#database.transaction(() => {
			const cursor = this.#database
				.prepare<PassiveCursorRow>(
					"SELECT * FROM tracker_passive_cursors WHERE recipient_id = ? AND lease_id = ?",
				)
				.get(input.recipientId, input.leaseId);
			if (!cursor || cursor.pending_to_sequence === null) return false;
			this.#database
				.prepare(
					"DELETE FROM tracker_passive_slots WHERE recipient_id = ? AND sequence <= ?",
				)
				.run(input.recipientId, cursor.pending_to_sequence);
			const changed = this.#database
				.prepare(
					"UPDATE tracker_passive_cursors SET cursor_sequence = ?, pending_json = NULL, pending_to_sequence = NULL, lease_id = NULL, lease_until = NULL, updated_at = ? WHERE recipient_id = ? AND lease_id = ?",
				)
				.run(
					cursor.pending_to_sequence,
					input.now,
					input.recipientId,
					input.leaseId,
				).changes;
			if (changed === 1)
				this.#audit(
					"passive.committed",
					input.leaseId,
					{ recipient_id: input.recipientId },
					input.now,
				);
			return changed === 1;
		})();
	}

	releasePassiveBatch(input: {
		readonly recipientId: string;
		readonly leaseId: string;
		readonly now: string;
	}): boolean {
		const changed = this.#database
			.prepare(
				"UPDATE tracker_passive_cursors SET lease_id = NULL, lease_until = NULL, updated_at = ? WHERE recipient_id = ? AND lease_id = ? AND pending_json IS NOT NULL",
			)
			.run(input.now, input.recipientId, input.leaseId).changes;
		if (changed === 1)
			this.#audit(
				"passive.released",
				input.leaseId,
				{ recipient_id: input.recipientId },
				input.now,
			);
		return changed === 1;
	}

	prune(input: { readonly now: string; readonly before: string }): {
		readonly events: number;
		readonly envelopes: number;
		readonly auditId: string;
	} {
		return this.#database.transaction(() => {
			const events = this.#database
				.prepare(
					"DELETE FROM tracker_bus_events WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM tracker_subscriptions s WHERE s.topic = tracker_bus_events.topic AND s.status IN ('active', 'offline') AND s.cursor_sequence < tracker_bus_events.sequence)",
				)
				.run(input.before).changes;
			const envelopes = this.#database
				.prepare(
					"DELETE FROM tracker_envelopes WHERE created_at < ? AND status IN ('acknowledged', 'expired', 'cancelled') AND NOT EXISTS (SELECT 1 FROM tracker_envelopes child WHERE child.parent_id = tracker_envelopes.id)",
				)
				.run(input.before).changes;
			const auditId = crypto.randomUUID();
			this.#database
				.prepare(
					"INSERT INTO tracker_delivery_audit(id, kind, subject_id, details_json, created_at) VALUES (?, 'tracker.pruned', 'tracker', ?, ?)",
				)
				.run(auditId, json({ events, envelopes }), input.now);
			return Object.freeze({ events, envelopes, auditId });
		})();
	}

	audit() {
		return this.#database
			.prepare<{
				readonly id: string;
				readonly kind: string;
				readonly subject_id: string;
				readonly details_json: string;
				readonly created_at: string;
			}>(
				"SELECT id, kind, subject_id, details_json, created_at FROM tracker_delivery_audit ORDER BY created_at, id",
			)
			.all()
			.map((row) =>
				Object.freeze({
					id: row.id,
					kind: row.kind,
					subjectId: row.subject_id,
					details: parseObject(row.details_json),
					createdAt: row.created_at,
				}),
			);
	}
}
