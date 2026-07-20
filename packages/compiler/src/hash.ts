import crypto from "node:crypto";

export function sha256(value: string | Uint8Array): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
	return `${JSON.stringify(stableValue(value))}\n`;
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, stableValue(child)]),
	);
}
