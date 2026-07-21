import { Command, Option } from "commander";

export type CliOptionName =
	| "model"
	| "backend"
	| "preset"
	| "cwd"
	| "dryRun"
	| "apply"
	| "config"
	| "explain"
	| "json";

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
}

const commonOptions: readonly CliOptionDefinition[] = [
	{
		name: "model",
		flags: "--model <selector>",
		description: "override the model selector",
		takesValue: true,
	},
	{
		name: "backend",
		flags: "--backend <name>",
		description: "override the backend",
		takesValue: true,
	},
	{
		name: "preset",
		flags: "--preset <name>",
		description: "select a saved preset",
		takesValue: true,
	},
	{
		name: "cwd",
		flags: "--cwd <dir>",
		description: "working directory for the native harness",
		takesValue: true,
	},
	{
		name: "dryRun",
		flags: "--dry-run",
		description: "resolve without spawning a process",
	},
	{
		name: "explain",
		flags: "--explain",
		description: "include deterministic resolution trace",
	},
	{ name: "json", flags: "--json", description: "print stable JSON output" },
];

const openCodeSetupOptions: readonly CliOptionDefinition[] = [
	{
		name: "apply",
		flags: "--apply",
		description: "apply the reviewed managed provider region",
	},
	{
		name: "config",
		flags: "--config <path>",
		description: "OpenCode JSONC config path",
		takesValue: true,
	},
	{ name: "json", flags: "--json", description: "print stable JSON output" },
];

const openCodeProbeOptions: readonly CliOptionDefinition[] = [
	{ name: "json", flags: "--json", description: "print stable JSON output" },
];

/** The only command vocabulary. Help, metadata, and parser construction all consume this table. */
export const commandRegistry: readonly CliCommandDefinition[] = Object.freeze([
	{
		name: "codex",
		summary: "launch the managed Codex compatibility path",
		options: commonOptions,
		presetArgument: "optional",
	},
	{
		name: "opencode",
		summary: "launch OpenCode through the qualified adapter",
		options: commonOptions,
		presetArgument: "optional",
	},
	{
		name: "opencode:setup",
		summary: "review or apply the marked OpenCode provider configuration",
		options: openCodeSetupOptions,
	},
	{
		name: "opencode:refresh",
		summary:
			"record OpenCode provider preflight observations without writing config",
		options: openCodeProbeOptions,
	},
	{
		name: "opencode:doctor",
		summary: "report OpenCode binary, provider, and qualification facts",
		options: openCodeProbeOptions,
	},
	{
		name: "claude",
		summary: "launch Claude Code through the qualified adapter",
		options: commonOptions,
		presetArgument: "optional",
	},
	{
		name: "dashboard",
		summary: "start the legacy dashboard",
		compatibility: true,
	},
	{
		name: "dashboard:restart",
		summary: "restart the legacy dashboard",
		compatibility: true,
	},
	{
		name: "codex-supervisor",
		summary: "run the managed Codex supervisor",
		compatibility: true,
	},
	{ name: "status", summary: "show dashboard health", compatibility: true },
	{
		name: "doctor",
		summary: "sanity-check the environment",
		compatibility: true,
	},
	{
		name: "sync",
		summary: "render installed integrations",
		compatibility: true,
	},
	{ name: "role", summary: "set or clear a session role", compatibility: true },
	{
		name: "sessions",
		summary: "inspect or clean legacy sessions",
		compatibility: true,
	},
	{
		name: "migrate-home",
		summary: "migrate the legacy Golem home",
		compatibility: true,
	},
	{ name: "help", summary: "show command help" },
	{
		name: "global-preset",
		summary: "resolve an @preset token",
		options: commonOptions,
		presetArgument: "required",
		hidden: true,
	},
]);

const optionByName = new Map(
	commonOptions.map((option) => [option.name, option]),
);

export function commandDefinition(
	name: string,
): CliCommandDefinition | undefined {
	return commandRegistry.find((definition) => definition.name === name);
}

export function createProgram(): Command {
	const program = new Command("golem")
		.description("typed Golem command registry")
		.exitOverride();
	program.configureOutput({
		writeOut: () => undefined,
		writeErr: () => undefined,
	});
	for (const definition of commandRegistry) {
		const command = new Command(definition.name)
			.description(definition.summary)
			.allowUnknownOption(false)
			.exitOverride();
		if (definition.hidden)
			(command as unknown as { _hidden: boolean })._hidden = true;
		if (definition.presetArgument === "optional") command.arguments("[preset]");
		if (definition.presetArgument === "required") command.arguments("<preset>");
		for (const option of definition.options ?? []) {
			const commanderOption = new Option(option.flags, option.description);
			command.addOption(commanderOption);
		}
		program.addCommand(command);
	}
	return program as unknown as Command;
}

export function commandMetadata(): readonly Record<string, unknown>[] {
	return commandRegistry
		.filter((definition) => !definition.hidden)
		.map((definition) => ({
			name: definition.name,
			summary: definition.summary,
			compatibility: definition.compatibility === true,
			options: (definition.options ?? []).map((option) => ({
				name: option.name,
				flags: option.flags,
				description: option.description,
			})),
		}));
}

export function optionDefinition(name: CliOptionName): CliOptionDefinition {
	const option = optionByName.get(name);
	if (!option) throw new Error(`unknown CLI option definition: ${name}`);
	return option;
}
