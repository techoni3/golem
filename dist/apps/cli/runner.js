import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LauncherResolutionError, parseJsoncConfig, resolveLaunch, } from "@golem/launcher";
import { CLI_EXIT_CODES, CliResolutionError, CliUsageError } from "./errors.js";
import { conciseSelection, stableCliJson } from "./format.js";
import { commandDefinition, commandMetadata, createProgram, } from "./registry.js";
const harnesses = new Set(["codex", "opencode", "claude", "pi"]);
const backends = new Set([
    "openai",
    "anthropic",
    "ollama_local",
    "ollama_cloud",
    "native",
]);
function output(io, line) {
    (io.stdout ?? ((value) => process.stdout.write(`${value}\n`)))(line);
}
function errorOutput(io, line) {
    (io.stderr ?? ((value) => process.stderr.write(`${value}\n`)))(line);
}
function splitPassthrough(argv) {
    const marker = argv.indexOf("--");
    return marker === -1
        ? { known: argv, passthrough: [] }
        : { known: argv.slice(0, marker), passthrough: argv.slice(marker + 1) };
}
function normalizeGlobalPreset(argv) {
    const first = argv[0];
    if (!first?.startsWith("@") || first.length < 2)
        return { argv };
    return {
        argv: ["global-preset", first.slice(1), ...argv.slice(1)],
        globalPreset: first.slice(1),
    };
}
function commanderParse(known) {
    const commandName = known[0] ?? "help";
    const definition = commandDefinition(commandName);
    if (!definition)
        throw new CliUsageError(`unknown command: ${commandName}`);
    if (known.includes("--help") || known.includes("-h"))
        return { command: commandName, commandArgs: [], options: { help: true } };
    const program = createProgram();
    try {
        program.parse(["node", "golem", ...known], { from: "node" });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "invalid command arguments";
        throw new CliUsageError(message.replace(/^error:\s*/iu, ""));
    }
    const command = program.commands.find((entry) => entry.name() === commandName);
    return {
        command: commandName,
        commandArgs: command?.args ?? [],
        options: command?.opts() ?? {},
    };
}
export function parseCliInput(argv) {
    const normalized = normalizeGlobalPreset(argv);
    const split = splitPassthrough(normalized.argv);
    const parsed = commanderParse(split.known);
    const commandArgs = parsed.commandArgs;
    if (parsed.command === "help" || parsed.options.help === true) {
        return {
            command: parsed.command,
            dryRun: false,
            explain: false,
            json: false,
            passthrough: split.passthrough,
            help: true,
        };
    }
    const globalPreset = normalized.globalPreset;
    const optionPreset = typeof parsed.options.preset === "string"
        ? parsed.options.preset
        : undefined;
    const scopedPreset = globalPreset
        ? undefined
        : (optionPreset ?? commandArgs[0]);
    if (commandArgs.length > (globalPreset ? 1 : 1))
        throw new CliUsageError(`unexpected positional argument: ${commandArgs[1]}`);
    const options = parsed.options;
    const result = {
        command: parsed.command,
        ...(globalPreset ? { globalPreset } : {}),
        ...(scopedPreset ? { scopedPreset } : {}),
        ...(typeof options.model === "string" ? { model: options.model } : {}),
        ...(typeof options.backend === "string"
            ? { backend: options.backend }
            : {}),
        ...(typeof options.cwd === "string" ? { cwd: options.cwd } : {}),
        dryRun: options.dryRun === true,
        explain: options.explain === true,
        json: options.json === true,
        passthrough: split.passthrough,
        help: false,
    };
    return result;
}
function renderFailure(result, input, io) {
    if (input.json)
        output(io, stableCliJson(result));
    else {
        errorOutput(io, `${result.error.code}: ${result.error.message}`);
        for (const remedy of result.error.remediation)
            errorOutput(io, `remedy: ${remedy}`);
    }
    return result.error.code.includes("unqualified") ||
        result.error.code.includes("registration") ||
        result.error.code.includes("stale")
        ? CLI_EXIT_CODES.unqualified
        : CLI_EXIT_CODES.resolution;
}
function renderSuccess(result, input, io) {
    if (input.json) {
        output(io, stableCliJson(result));
        return CLI_EXIT_CODES.ok;
    }
    output(io, `selected ${conciseSelection(result)}`);
    if (input.explain) {
        for (const trace of result.trace)
            output(io, `${trace.code}: ${trace.detail}`);
    }
    return CLI_EXIT_CODES.ok;
}
function launcherDocuments() {
    const userPath = process.env.GOLEM_LAUNCHER_CONFIG ??
        (process.env.GOLEM_HOME
            ? join(process.env.GOLEM_HOME, "launcher.jsonc")
            : undefined);
    const projectRoot = process.env.GOLEM_PROJECT_ROOT ?? process.cwd();
    const projectPath = join(projectRoot, ".golem", "launcher.jsonc");
    const read = (file, scope) => {
        if (!file || !existsSync(file))
            return undefined;
        try {
            return parseJsoncConfig(readFileSync(file, "utf8"), scope);
        }
        catch (error) {
            if (error instanceof LauncherResolutionError)
                throw new CliResolutionError(error.issue.code, error.issue.message, error.issue.remediation);
            throw error;
        }
    };
    const user = read(userPath, "user");
    const project = read(existsSync(projectPath) ? projectPath : undefined, "project");
    return {
        ...(user ? { user } : {}),
        ...(project ? { project } : {}),
    };
}
function resolveForInput(input, io) {
    const command = input.command;
    if (!harnesses.has(command) && command !== "global-preset")
        throw new CliUsageError(`command ${command} is a compatibility command; invoke it through the root golem entrypoint`);
    const harness = command === "global-preset" ? undefined : command;
    const explicit = {
        ...(harness ? { harness } : {}),
        ...(input.backend ? { backend: input.backend } : {}),
        ...(input.model ? { modelSelector: input.model } : {}),
    };
    if (input.backend && !backends.has(input.backend)) {
        return {
            schemaVersion: "golem.launch-plan/v1",
            ok: false,
            error: {
                code: "launcher.selection.invalid",
                severity: "error",
                message: "Harness, mode, or backend is not supported.",
                remediation: [
                    "Use a configured harness/backend preset or explicit supported value.",
                ],
            },
            trace: [],
        };
    }
    const documents = launcherDocuments();
    return resolveLaunch({
        ...(harness ? { harness } : {}),
        ...(input.scopedPreset ? { preset: input.scopedPreset } : {}),
        ...(input.globalPreset ? { globalPreset: input.globalPreset } : {}),
        explicit,
        passthrough: input.passthrough,
        ...(documents.user ? { user: documents.user } : {}),
        ...(documents.project ? { project: documents.project } : {}),
        isTTY: io.isTTY ?? Boolean(process.stdin.isTTY),
        now: io.now ?? new Date().toISOString(),
    });
}
export async function runCli(argv = process.argv.slice(2), io = {}) {
    if (argv.includes("--json-schema")) {
        output(io, stableCliJson({
            schemaVersion: "golem.cli-registry/v1",
            commands: commandMetadata(),
        }));
        return CLI_EXIT_CODES.ok;
    }
    let input;
    try {
        input = parseCliInput(argv.length === 0 ? ["help"] : argv);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "invalid command";
        errorOutput(io, `cli.usage: ${message}`);
        return CLI_EXIT_CODES.usage;
    }
    if (input.help || input.command === "help") {
        const program = createProgram();
        const command = program.commands.find((entry) => entry.name() === input.command);
        output(io, command && input.command !== "help"
            ? command.helpInformation()
            : program.helpInformation());
        return CLI_EXIT_CODES.ok;
    }
    if (input.cwd === "") {
        errorOutput(io, "cli.usage: --cwd requires a non-empty path");
        return CLI_EXIT_CODES.usage;
    }
    try {
        const result = resolveForInput(input, io);
        if (!result.ok)
            return renderFailure(result, input, io);
        if (!input.dryRun && input.command !== "codex") {
            return renderFailure({
                schemaVersion: "golem.launch-plan/v1",
                ok: false,
                error: {
                    code: "launcher.adapter.unqualified",
                    severity: "error",
                    message: "This adapter is resolution-only until its real process qualification journey passes.",
                    remediation: [
                        "Use --dry-run or run the adapter qualification journey before spawning.",
                    ],
                },
                trace: result.trace,
            }, input, io);
        }
        return renderSuccess(result, input, io);
    }
    catch (error) {
        if (error instanceof CliResolutionError) {
            errorOutput(io, `${error.code}: ${error.message}`);
            for (const remedy of error.remediation)
                errorOutput(io, `remedy: ${remedy}`);
            return error.exitCode;
        }
        if (error instanceof CliUsageError) {
            errorOutput(io, `cli.usage: ${error.message}`);
            return error.exitCode;
        }
        throw error;
    }
}
export const cliBoundary = Object.freeze({
    parse: parseCliInput,
    run: runCli,
    registry: commandMetadata,
});
//# sourceMappingURL=runner.js.map