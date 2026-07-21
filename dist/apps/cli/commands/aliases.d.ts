export interface AliasCommandInput {
    readonly positionals: readonly string[];
    readonly shell?: string;
    readonly name?: string;
    readonly apply: boolean;
    readonly json: boolean;
}
export interface AliasCommandIo {
    readonly stdout: (line: string) => void;
    readonly stderr: (line: string) => void;
}
/** Alias installation is opt-in, reviewable, and isolated from user shell configuration. */
export declare function runAliases(input: AliasCommandInput, io: AliasCommandIo): Promise<number>;
//# sourceMappingURL=aliases.d.ts.map