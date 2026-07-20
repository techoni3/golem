import { redactDiagnostic, sanitizePublicValue } from "./public-safety.js";
import type {
	LaunchExplanation,
	LauncherIssue,
	LaunchFailure,
} from "./types.js";
import { deepFreeze, isRecord } from "./types.js";

export class LauncherResolutionError extends Error {
	readonly issue: LauncherIssue;

	constructor(issue: LauncherIssue) {
		super(issue.code);
		this.name = "LauncherResolutionError";
		this.issue = issue;
	}
}

export function issue(
	code: string,
	message: string,
	remediation: readonly string[],
	severity: LauncherIssue["severity"] = "error",
): LauncherIssue {
	return deepFreeze({
		code,
		severity,
		message: redactDiagnostic(message, "message"),
		remediation: remediation.map((entry) =>
			redactDiagnostic(entry, "remediation"),
		),
	});
}

export function failure(
	error: LauncherIssue,
	trace: readonly LaunchExplanation[],
): LaunchFailure {
	return deepFreeze({
		schemaVersion: "golem.launch-plan/v1",
		ok: false,
		error,
		trace: [...trace],
	});
}

export function stableLaunchPlanJson(value: unknown): string {
	return JSON.stringify(sortJson(sanitizePublicValue(value)));
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, sortJson(child)]),
	);
}
