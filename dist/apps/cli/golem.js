#!/usr/bin/env node
import { runCli } from "./runner.js";
export { CLI_EXIT_CODES, CliResolutionError, CliUsageError } from "./errors.js";
export { commandMetadata, commandRegistry, createProgram } from "./registry.js";
export { runCli } from "./runner.js";
if (import.meta.url === `file://${process.argv[1]}`) {
    const exitCode = await runCli();
    if (exitCode !== 0)
        process.exitCode = exitCode;
}
//# sourceMappingURL=golem.js.map