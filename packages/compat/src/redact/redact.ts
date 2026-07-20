import { createHash } from "node:crypto";

const secretKey =
	/(?:secret|token|password|credential|api[_-]?key|authorization)/iu;
const secretValue = /(?:Bearer\s+|(?:sk|ghp|xoxb)-)[-_A-Za-z0-9.]{6,}/iu;
const secretPathSegment =
	/(?:Bearer\s+|(?:sk|ghp|xoxb)-)[-_A-Za-z0-9.]{6,}|(?:secret|token|password|credential|api[_-]?key|authorization)/iu;

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Never let an audit result turn a config value or a credential-shaped string into diagnostics. */
export function redactAuditValue(value: unknown): string | number | boolean {
	if (typeof value === "string")
		return secretValue.test(value)
			? "$REDACTED"
			: value.length > 160
				? "$TRUNCATED"
				: value;
	if (typeof value === "number" || typeof value === "boolean") return value;
	return "$REDACTED";
}

export function isSecretLikeKey(key: string): boolean {
	return secretKey.test(key);
}

/** Preserve safe structure while replacing credential-shaped path components with stable opaque aliases. */
export function redactedRelativePath(relativePath: string): string {
	return relativePath
		.replaceAll("\\", "/")
		.split("/")
		.filter((segment) => segment && segment !== ".")
		.map((segment) =>
			secretPathSegment.test(segment)
				? `$REDACTED_${digest(segment)}`
				: segment,
		)
		.join("/");
}

export function redactedHomePath(relativePath: string): string {
	const safeRelative = redactedRelativePath(relativePath);
	return safeRelative ? `$GOLEM_HOME/${safeRelative}` : "$GOLEM_HOME";
}
