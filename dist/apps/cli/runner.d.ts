import { commandMetadata } from "./registry.js";
export interface CliIo {
    readonly stdout?: (line: string) => void;
    readonly stderr?: (line: string) => void;
    readonly isTTY?: boolean;
    readonly now?: string;
    /** Injectable only for the TTY picker journey; production reads standard input. */
    readonly readLine?: (prompt: string) => Promise<string>;
}
export interface ParsedCliInput {
    readonly command: string;
    readonly globalPreset?: string;
    readonly scopedPreset?: string;
    readonly model?: string;
    readonly backend?: string;
    readonly session?: string;
    readonly cwd?: string;
    readonly dryRun: boolean;
    readonly apply: boolean;
    readonly config?: string;
    readonly delivery?: string;
    readonly scope?: string;
    readonly shell?: string;
    readonly name?: string;
    readonly explain: boolean;
    readonly json: boolean;
    readonly passthrough: readonly string[];
    readonly help: boolean;
    readonly positionals: readonly string[];
}
export declare function parseCliInput(argv: readonly string[]): ParsedCliInput;
export declare function runCli(argv?: readonly string[], io?: CliIo): Promise<number>;
export declare const cliBoundary: Readonly<{
    parse: typeof parseCliInput;
    run: typeof runCli;
    registry: typeof commandMetadata;
}>;
//# sourceMappingURL=runner.d.ts.map