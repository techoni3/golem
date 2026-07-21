import { Command } from "commander";
export type CliOptionName = "model" | "backend" | "delivery" | "session" | "preset" | "cwd" | "dryRun" | "apply" | "config" | "explain" | "json" | "scope" | "shell" | "name";
export interface CliOptionDefinition {
    readonly name: CliOptionName;
    readonly flags: string;
    readonly description: string;
    readonly takesValue?: boolean;
}
export interface CliCommandDefinition {
    readonly name: string;
    readonly summary: string;
    readonly options?: readonly CliOptionDefinition[];
    readonly presetArgument?: "optional" | "required";
    readonly compatibility?: boolean;
    readonly hidden?: boolean;
    /** Commander grammar for administrative commands; harness verbs use presetArgument. */
    readonly arguments?: string;
}
/** The only command vocabulary. Help, metadata, and parser construction all consume this table. */
export declare const commandRegistry: readonly CliCommandDefinition[];
export declare function commandDefinition(name: string): CliCommandDefinition | undefined;
export declare function createProgram(): Command;
export declare function commandMetadata(): readonly Record<string, unknown>[];
export declare function optionDefinition(name: CliOptionName): CliOptionDefinition;
//# sourceMappingURL=registry.d.ts.map