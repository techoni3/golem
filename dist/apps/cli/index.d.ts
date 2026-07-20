import type { ApiClientBoundary } from "@golem/api-client";
import type { LauncherBoundary } from "@golem/launcher";
export { CLI_EXIT_CODES, CliResolutionError, CliUsageError } from "./errors.js";
export { commandMetadata, commandRegistry, createProgram } from "./registry.js";
export type { CliIo, ParsedCliInput } from "./runner.js";
export { cliBoundary, parseCliInput, runCli } from "./runner.js";
export interface CliComposition {
    readonly apiClient: ApiClientBoundary;
    readonly launcher: LauncherBoundary;
}
//# sourceMappingURL=index.d.ts.map