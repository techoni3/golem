import { commandMetadata } from "./registry.js";
export interface CliIo {
    readonly stdout?: (line: string) => void;
    readonly stderr?: (line: string) => void;
    readonly isTTY?: boolean;
    readonly now?: string;
}
export interface ParsedCliInput {
    readonly command: string;
    readonly globalPreset?: string;
    readonly scopedPreset?: string;
    readonly model?: string;
    readonly backend?: string;
    readonly cwd?: string;
    readonly dryRun: boolean;
    readonly explain: boolean;
    readonly json: boolean;
    readonly passthrough: readonly string[];
    readonly help: boolean;
}
export declare function parseCliInput(argv: readonly string[]): ParsedCliInput;
export declare function runCli(argv?: readonly string[], io?: CliIo): Promise<number>;
export declare const cliBoundary: Readonly<{
    parse: typeof parseCliInput;
    run: typeof runCli;
    registry: typeof commandMetadata;
}>;
//# sourceMappingURL=runner.d.ts.map