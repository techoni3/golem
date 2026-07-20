import type { LauncherIssue } from "../types.js";

/**
 * Public execution failures expose a stable code/remedy only. Native errno text,
 * paths, and environment values stay inside the local diagnostic boundary.
 */
export class LauncherExecutionError extends Error {
	readonly code: string;
	readonly remediation: readonly string[];

	constructor(issue: LauncherIssue) {
		super(issue.message);
		this.name = "LauncherExecutionError";
		this.code = issue.code;
		this.remediation = issue.remediation;
	}
}

export function executionFailure(
	code: string,
	message: string,
	remediation: readonly string[],
): LauncherExecutionError {
	return new LauncherExecutionError({
		code,
		severity: "error",
		message,
		remediation,
	});
}
