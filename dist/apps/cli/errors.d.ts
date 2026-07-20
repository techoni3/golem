export declare const CLI_EXIT_CODES: Readonly<{
    ok: 0;
    usage: 2;
    resolution: 3;
    unqualified: 4;
    runtime: 1;
}>;
export declare class CliUsageError extends Error {
    readonly exitCode: 2;
    constructor(message: string);
}
export declare class CliResolutionError extends Error {
    readonly exitCode: number;
    readonly code: string;
    readonly remediation: readonly string[];
    constructor(code: string, message: string, remediation: readonly string[], exitCode?: 3);
}
//# sourceMappingURL=errors.d.ts.map