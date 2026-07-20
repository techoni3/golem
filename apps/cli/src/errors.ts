export const CLI_EXIT_CODES = Object.freeze({
	ok: 0,
	usage: 2,
	resolution: 3,
	unqualified: 4,
	runtime: 1,
});

export class CliUsageError extends Error {
	readonly exitCode = CLI_EXIT_CODES.usage;
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

export class CliResolutionError extends Error {
	readonly exitCode: number;
	readonly code: string;
	readonly remediation: readonly string[];
	constructor(
		code: string,
		message: string,
		remediation: readonly string[],
		exitCode = CLI_EXIT_CODES.resolution,
	) {
		super(message);
		this.name = "CliResolutionError";
		this.code = code;
		this.remediation = remediation;
		this.exitCode = exitCode;
	}
}
