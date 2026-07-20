import { stableLaunchPlanJson } from "@golem/launcher";

const sensitiveKey =
	/(?:api[_-]?key|token|secret|password|credential|authorization)/iu;
const sensitiveValue = /(?:api[_-]?key|token|secret|password|credential)\s*=/iu;

export function redactPublic(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactPublic);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => [
				key,
				sensitiveKey.test(key) ? "[redacted]" : redactPublic(child),
			]),
		);
	}
	if (typeof value === "string" && sensitiveValue.test(value))
		return "[redacted]";
	return value;
}

export function stableCliJson(value: unknown): string {
	return stableLaunchPlanJson(redactPublic(value));
}

export function conciseSelection(result: {
	readonly selection?: {
		readonly harness: string;
		readonly backend: string;
		readonly modelSelector: string;
		readonly mode: string;
	};
}): string {
	const selection = result.selection;
	if (!selection) return "unresolved";
	return `${selection.harness} ${selection.backend} ${selection.modelSelector} (${selection.mode})`;
}
