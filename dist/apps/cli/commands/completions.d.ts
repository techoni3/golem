import type { CliCommandDefinition } from "../registry.js";
export type CompletionShell = "bash" | "zsh" | "fish";
export interface CompletionCommandInput {
    readonly positionals: readonly string[];
    readonly shell?: string;
    readonly apply: boolean;
    readonly json: boolean;
}
export interface CompletionCommandIo {
    readonly stdout: (line: string) => void;
    readonly stderr: (line: string) => void;
}
/** Generated from the typed registry so parser and completion vocabulary cannot drift. */
export declare function renderCompletion(shell: CompletionShell, registry: readonly CliCommandDefinition[]): string;
export declare function completionFile(shell: CompletionShell): string;
export declare function runCompletions(input: CompletionCommandInput, io: CompletionCommandIo, registry: readonly CliCommandDefinition[]): Promise<number>;
//# sourceMappingURL=completions.d.ts.map