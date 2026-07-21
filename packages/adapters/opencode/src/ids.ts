import { createHash } from "node:crypto";

function uuidFor(seed: string): string {
	const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function opaqueId(prefix: string, seed: string): string {
	return `${prefix}_${uuidFor(seed)}`;
}

export function stableTimestamp(
	value: string | undefined,
	fallback: () => string,
): string {
	if (value && Number.isFinite(Date.parse(value)))
		return new Date(value).toISOString();
	return new Date(fallback()).toISOString();
}
