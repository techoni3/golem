export const CLI_EXIT_CODES = Object.freeze({
    ok: 0,
    usage: 2,
    resolution: 3,
    unqualified: 4,
    runtime: 1,
});
export class CliUsageError extends Error {
    exitCode = CLI_EXIT_CODES.usage;
    constructor(message) {
        super(message);
        this.name = "CliUsageError";
    }
}
export class CliResolutionError extends Error {
    exitCode;
    code;
    remediation;
    constructor(code, message, remediation, exitCode = CLI_EXIT_CODES.resolution) {
        super(message);
        this.name = "CliResolutionError";
        this.code = code;
        this.remediation = remediation;
        this.exitCode = exitCode;
    }
}
//# sourceMappingURL=errors.js.map