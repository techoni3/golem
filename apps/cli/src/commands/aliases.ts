import {
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { stableCliJson } from "../format.js";
import { launcherOwnedPath } from "./storage.js";

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

type Shell = "bash" | "zsh" | "fish";
const nativeHarnesses = new Set(["codex", "claude", "opencode", "golem"]);

function shellFor(value: string | undefined): Shell | undefined {
	return value === undefined ||
		value === "bash" ||
		value === "zsh" ||
		value === "fish"
		? (value ?? "bash")
		: undefined;
}

function aliasFile(shell: Shell): string {
	return launcherOwnedPath(join("aliases", `golem.${shell}`));
}

function aliasNames(name: string | undefined): readonly string[] | undefined {
	if (name === undefined)
		return ["golem-codex", "golem-opencode", "golem-claude"];
	if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(name) || nativeHarnesses.has(name))
		return undefined;
	return [name];
}

function render(shell: Shell, names: readonly string[]): string {
	const targetFor = (name: string) =>
		name === "golem-codex"
			? "codex"
			: name === "golem-opencode"
				? "opencode"
				: name === "golem-claude"
					? "claude"
					: "codex";
	if (shell === "fish")
		return `# golem optional aliases — source explicitly\n${names.map((name) => `alias ${name} 'golem ${targetFor(name)}'`).join("\n")}\n`;
	return `# golem optional aliases — source explicitly; no shell rc file was changed\n${names.map((name) => `alias ${name}='golem ${targetFor(name)}'`).join("\n")}\n`;
}

/** Alias installation is opt-in, reviewable, and isolated from user shell configuration. */
export async function runAliases(
	input: AliasCommandInput,
	io: AliasCommandIo,
): Promise<number> {
	const [action = "install"] = input.positionals;
	const shell = shellFor(input.shell);
	const names = aliasNames(input.name);
	if (!shell) {
		io.stderr("cli.usage: aliases --shell must be bash, zsh, or fish");
		return 2;
	}
	if (!names) {
		io.stderr(
			"cli.usage: alias names must be non-native names (never codex, claude, opencode, or golem)",
		);
		return 2;
	}
	const target = aliasFile(shell);
	if (action === "uninstall") {
		if (!input.apply) {
			const result = {
				operation: "aliases.uninstall",
				shell,
				target,
				apply: false,
				exists: existsSync(target),
			};
			if (input.json) io.stdout(stableCliJson(result));
			else
				io.stdout(
					`dry-run remove ${target}; re-run with --apply to remove only this Golem-owned file`,
				);
			return 0;
		}
		rmSync(target, { force: true });
		if (input.json)
			io.stdout(
				stableCliJson({
					operation: "aliases.uninstall",
					shell,
					target,
					apply: true,
				}),
			);
		else io.stdout(`removed ${target}; no shell rc file was changed`);
		return 0;
	}
	if (action !== "install") {
		io.stderr(`cli.usage: unknown aliases action: ${action}`);
		return 2;
	}
	const text = render(shell, names);
	if (!input.apply) {
		const result = {
			operation: "aliases.install",
			shell,
			target,
			aliases: names,
			apply: false,
			text,
		};
		if (input.json) io.stdout(stableCliJson(result));
		else
			io.stdout(
				`dry-run aliases: ${names.join(", ")}\nsource ${target} after re-running with --apply`,
			);
		return 0;
	}
	mkdirSync(dirname(target), { recursive: true });
	const temporary = `${target}.tmp`;
	writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
	if (input.json)
		io.stdout(
			stableCliJson({
				operation: "aliases.install",
				shell,
				target,
				aliases: names,
				apply: true,
			}),
		);
	else
		io.stdout(
			`wrote ${target}; source it explicitly (your shell configuration was not edited)`,
		);
	return 0;
}
