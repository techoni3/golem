const secretKey =
	/(?:secret|token|password|credential|api[_-]?key|authorization)/iu;
const secretValue = /(?:Bearer\s+|(?:sk|ghp|xoxb)-)[-_A-Za-z0-9.]{6,}/giu;

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

export function redactedHomePath(relativePath: string): string {
	return relativePath === "." ? "$GOLEM_HOME" : `$GOLEM_HOME/${relativePath}`;
}
