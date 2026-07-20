import type { DeliveryFacts, LaunchFacts } from "./types.js";

// Adapter diagnostics are untrusted text.  Match the complete assignment key
// first, then normalize separators/camel case before deciding whether it is a
// credential-bearing identifier.  A word-boundary around the sensitive suffix
// alone misses keys such as `owner_token`, `OPENAI_API_KEY`, and `accessToken`.
const diagnosticAssignment = /\b([a-z][a-z0-9_-]*)\s*(?:=|:)/giu;
const diagnosticSecretShape =
	/\b(?:bearer\s+[a-z0-9._~+/=-]{8,}|sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]{8,}|xox[baprs]-[a-z0-9-]{8,}|eyj[a-z0-9_-]{10,}\.[a-z0-9._-]{10,})\b/iu;
const diagnosticMarkerShape =
	/\b(?:marker|secret|credential|token|password|api[_-]?key)[-_][a-z0-9][a-z0-9_-]{2,}\b/iu;
const diagnosticKey =
	/^(?:reason|remediation|message|detail|error|diagnostic)$/iu;

const REDACTED_DIAGNOSTIC = "Adapter diagnostic redacted.";
const REDACTED_REMEDIATION = "Use the configured credential provider.";
const MAX_DIAGNOSTIC_LENGTH = 512;

function hasCredentialShape(value: string): boolean {
	return (
		hasSensitiveAssignment(value) ||
		diagnosticSecretShape.test(value) ||
		diagnosticMarkerShape.test(value)
	);
}

function normalizeIdentifier(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/-/g, "_")
		.toLowerCase();
}

function isSensitiveIdentifier(value: string): boolean {
	return /(?:^|_)(?:api_key|token|credential|password|secret)(?:$|_)/u.test(
		normalizeIdentifier(value),
	);
}

function hasSensitiveAssignment(value: string): boolean {
	for (const match of value.matchAll(diagnosticAssignment)) {
		if (match[1] && isSensitiveIdentifier(match[1])) return true;
	}
	return false;
}

/** Adapter-owned fact text is untrusted even when the type says string. */
export function isUnsafeDiagnostic(value: unknown): boolean {
	return (
		typeof value !== "string" || !value.trim() || hasCredentialShape(value)
	);
}

/**
 * Adapter diagnostics are untrusted input. Keep ordinary stable text for
 * useful explanations, but fail closed for credential-shaped values and
 * bound the size of anything that reaches a public projection.
 */
export function redactDiagnostic(
	value: string,
	kind: "reason" | "remediation" | "message" | "detail" = "reason",
): string {
	const text = String(value).trim();
	if (!text || hasCredentialShape(text))
		return kind === "remediation" ? REDACTED_REMEDIATION : REDACTED_DIAGNOSTIC;
	if (text.length <= MAX_DIAGNOSTIC_LENGTH) return text;
	return `${text.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...`;
}

export function redactLaunchFacts(value: {
	readonly status: LaunchFacts["status"];
	readonly reason: string;
	readonly remediation: string;
}): LaunchFacts {
	const unsafe =
		isUnsafeDiagnostic(value.reason) || isUnsafeDiagnostic(value.remediation);
	return {
		status:
			unsafe || !["launchable", "unavailable"].includes(value.status)
				? "unavailable"
				: value.status,
		reason: unsafe
			? REDACTED_DIAGNOSTIC
			: redactDiagnostic(value.reason, "reason"),
		remediation: unsafe
			? REDACTED_REMEDIATION
			: redactDiagnostic(value.remediation, "remediation"),
	};
}

export function redactDeliveryFacts(value: {
	readonly mode: DeliveryFacts["mode"];
	readonly qualification: DeliveryFacts["qualification"];
	readonly readiness: DeliveryFacts["readiness"];
	readonly reason: string;
	readonly remediation: string;
}): DeliveryFacts {
	const unsafe =
		isUnsafeDiagnostic(value.reason) || isUnsafeDiagnostic(value.remediation);
	return {
		mode: value.mode,
		qualification: value.qualification,
		readiness: unsafe ? "not_ready" : value.readiness,
		reason: unsafe
			? REDACTED_DIAGNOSTIC
			: redactDiagnostic(value.reason, "reason"),
		remediation: unsafe
			? REDACTED_REMEDIATION
			: redactDiagnostic(value.remediation, "remediation"),
	};
}

/** Clone a public JSON projection while applying the same diagnostic boundary. */
export function sanitizePublicValue(value: unknown, key?: string): unknown {
	// Sensitive identifiers are opaque at the public boundary: replace their
	// values regardless of runtime type, including nested objects/arrays and
	// primitive values that could otherwise bypass string-only redaction.
	if (key && isSensitiveIdentifier(key)) return REDACTED_DIAGNOSTIC;
	if (typeof value === "string") {
		if (key && diagnosticKey.test(key)) {
			const kind = /remediation/iu.test(key) ? "remediation" : "reason";
			return redactDiagnostic(value, kind);
		}
		return hasCredentialShape(value) ? REDACTED_DIAGNOSTIC : value;
	}
	if (Array.isArray(value))
		return value.map((child) => sanitizePublicValue(child, key));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([childKey, child]) => [
				childKey,
				sanitizePublicValue(child, childKey),
			]),
		);
	return value;
}
