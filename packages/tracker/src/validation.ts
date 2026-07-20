import type { BusEvent, JsonObject, TrackerClock } from "./types.js";

const isoTimestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u;

export const trackerValidationLimits = Object.freeze({
	maxIdentifierLength: 256,
	maxAttempts: 20,
	maxRetryDelayMs: 60_000,
	maxLeaseMs: 300_000,
	maxClaimLimit: 100,
	maxSubscriptionPendingLimit: 1_000,
	maxCursor: 1_000_000_000,
	maxDeadlineHorizonMs: 366 * 24 * 60 * 60 * 1_000,
	maxJsonDepth: 16,
	maxJsonBytes: 64 * 1_024,
	maxDiagnosticCharacters: 1_024,
});

export type TrackerValidationCode =
	| "invalid_identifier"
	| "invalid_deadline"
	| "invalid_max_attempts"
	| "invalid_retry_delay"
	| "invalid_claim_limit"
	| "invalid_lease"
	| "invalid_cursor"
	| "invalid_range"
	| "invalid_subscription_class"
	| "invalid_subscription_status"
	| "invalid_json"
	| "invalid_diagnostic";

/** Stable service-boundary error; SQLite constraint text never escapes callers. */
export class TrackerValidationError extends Error {
	constructor(
		readonly code: TrackerValidationCode,
		detail: string,
	) {
		super(`tracker input invalid: ${detail}`);
		this.name = "TrackerValidationError";
	}
}

function invalid(code: TrackerValidationCode, detail: string): never {
	throw new TrackerValidationError(code, detail);
}

function timestamp(value: unknown, label: string): number {
	if (typeof value !== "string" || !isoTimestamp.test(value))
		invalid("invalid_deadline", `${label} must be an ISO-8601 UTC timestamp`);
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(milliseconds))
		invalid("invalid_deadline", `${label} must be finite`);
	return milliseconds;
}

function positiveInteger(
	value: unknown,
	maximum: number,
	code: TrackerValidationCode,
	label: string,
): number {
	if (
		!Number.isInteger(value) ||
		(value as number) < 1 ||
		(value as number) > maximum
	)
		invalid(code, `${label} must be an integer from 1 to ${maximum}`);
	return value as number;
}

export function requireIdentifier(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > trackerValidationLimits.maxIdentifierLength
	)
		invalid(
			"invalid_identifier",
			`${label} must be nonblank and at most ${trackerValidationLimits.maxIdentifierLength} characters`,
		);
	return value;
}

export function requireDeadline(value: unknown, clock: TrackerClock): string {
	const deadline = timestamp(value, "deadline");
	const now = timestamp(clock.now(), "clock now");
	if (
		deadline <= now ||
		deadline - now > trackerValidationLimits.maxDeadlineHorizonMs
	)
		invalid(
			"invalid_deadline",
			"deadline must be future and within the supported horizon",
		);
	return value as string;
}

export function requireMaxAttempts(value: unknown): number {
	return positiveInteger(
		value,
		trackerValidationLimits.maxAttempts,
		"invalid_max_attempts",
		"max attempts",
	);
}

export function requireRetryDelay(value: unknown): number {
	return positiveInteger(
		value,
		trackerValidationLimits.maxRetryDelayMs,
		"invalid_retry_delay",
		"retry delay",
	);
}

export function requireClaimLimit(value: unknown): number {
	return positiveInteger(
		value,
		trackerValidationLimits.maxClaimLimit,
		"invalid_claim_limit",
		"claim limit",
	);
}

export function requireSubscriptionPendingLimit(value: unknown): number {
	return positiveInteger(
		value,
		trackerValidationLimits.maxSubscriptionPendingLimit,
		"invalid_claim_limit",
		"subscription pending limit",
	);
}

export function requireLease(value: unknown): number {
	return positiveInteger(
		value,
		trackerValidationLimits.maxLeaseMs,
		"invalid_lease",
		"lease",
	);
}

export function requireCursor(value: unknown, label = "cursor"): number {
	if (
		!Number.isInteger(value) ||
		(value as number) < 0 ||
		(value as number) > trackerValidationLimits.maxCursor
	)
		invalid(
			"invalid_cursor",
			`${label} must be an integer from 0 to ${trackerValidationLimits.maxCursor}`,
		);
	return value as number;
}

export function requireCursorRange(from: unknown, to: unknown): void {
	const fromSequence = requireCursor(from, "from sequence");
	const toSequence = requireCursor(to, "to sequence");
	if (toSequence < fromSequence)
		invalid("invalid_range", "to sequence cannot precede from sequence");
}

export function requireSubscriptionClasses(
	value: unknown,
): readonly BusEvent["class"][] {
	if (!Array.isArray(value) || value.length === 0)
		invalid(
			"invalid_subscription_class",
			"subscription requires event classes",
		);
	const classes = value as readonly unknown[];
	const allowed = new Set<BusEvent["class"]>([
		"tracker",
		"lifecycle",
		"custom",
	]);
	if (
		classes.some(
			(entry) =>
				typeof entry !== "string" || !allowed.has(entry as BusEvent["class"]),
		) ||
		new Set(classes).size !== classes.length
	)
		invalid(
			"invalid_subscription_class",
			"subscription classes must be unique tracker, lifecycle, or custom values",
		);
	return Object.freeze([...classes] as BusEvent["class"][]);
}

export function requireSubscriptionStatus(value: unknown): void {
	if (value !== "active" && value !== "offline" && value !== "suspended")
		invalid(
			"invalid_subscription_status",
			"subscription status is unsupported",
		);
}

function inspectJson(
	value: unknown,
	depth: number,
	ancestors: Set<object>,
): void {
	if (depth > trackerValidationLimits.maxJsonDepth)
		invalid("invalid_json", "JSON depth exceeds the supported limit");
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return;
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			invalid("invalid_json", "JSON numbers must be finite");
		return;
	}
	if (typeof value !== "object")
		invalid("invalid_json", "JSON contains a non-serializable value");
	if (ancestors.has(value))
		invalid("invalid_json", "JSON cannot contain cycles");
	if (Array.isArray(value)) {
		ancestors.add(value);
		for (const entry of value) inspectJson(entry, depth + 1, ancestors);
		ancestors.delete(value);
		return;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null)
		invalid("invalid_json", "JSON objects must be plain records");
	ancestors.add(value);
	for (const entry of Object.values(value))
		inspectJson(entry, depth + 1, ancestors);
	ancestors.delete(value);
}

function utf8ByteLength(value: string): number {
	let length = 0;
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		length +=
			codePoint <= 0x7f
				? 1
				: codePoint <= 0x7ff
					? 2
					: codePoint <= 0xffff
						? 3
						: 4;
	}
	return length;
}

export function requireJsonObject(
	value: unknown,
	label: string,
): asserts value is JsonObject {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		invalid("invalid_json", `${label} must be a JSON object`);
	inspectJson(value, 0, new Set());
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		invalid("invalid_json", `${label} cannot be serialized`);
	}
	if (utf8ByteLength(serialized) > trackerValidationLimits.maxJsonBytes)
		invalid("invalid_json", `${label} exceeds the serialized byte limit`);
}

export function requireBusClass(
	value: unknown,
): asserts value is BusEvent["class"] {
	if (value !== "tracker" && value !== "lifecycle" && value !== "custom")
		invalid("invalid_subscription_class", "bus event class is unsupported");
}

export function requireTimestamp(value: unknown, label: string): string {
	timestamp(value, label);
	return value as string;
}

/** Redact before the storage port so a transport diagnostic is never persisted raw. */
export function sanitizeDiagnostic(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0)
		invalid("invalid_diagnostic", "delivery diagnostic must be nonblank text");
	return value
		.replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, "Bearer [REDACTED]")
		.replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY))=\S+/gu, "$1=[REDACTED]")
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@")
		.replace(/(?:^|\s)(?:~\/|\/)[^\s]+/gu, " [REDACTED_PATH]")
		.slice(0, trackerValidationLimits.maxDiagnosticCharacters);
}
