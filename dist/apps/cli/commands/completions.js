import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stableCliJson } from "../format.js";
import { launcherOwnedPath } from "./storage.js";
function shellFor(input) {
    const candidate = input.shell ?? input.positionals[0] ?? "bash";
    return candidate === "bash" || candidate === "zsh" || candidate === "fish"
        ? candidate
        : undefined;
}
function publicCommands(registry) {
    return registry.filter((command) => !command.hidden && !command.compatibility);
}
function words(registry) {
    return publicCommands(registry)
        .map((command) => command.name)
        .join(" ");
}
/** Generated from the typed registry so parser and completion vocabulary cannot drift. */
export function renderCompletion(shell, registry) {
    const commandWords = words(registry);
    const currentWord = "$" + "{COMP_WORDS[COMP_CWORD]}";
    const optionWords = [
        ...new Set(publicCommands(registry).flatMap((command) => (command.options ?? []).flatMap((option) => option.flags.split(" ").filter((word) => word.startsWith("-"))))),
    ]
        .sort()
        .join(" ");
    if (shell === "bash")
        return `# golem completion — generated from typed registry\n_golem_complete() {\n  local cur="${currentWord}"\n  COMPREPLY=( $(compgen -W '${commandWords} ${optionWords}' -- "$cur") )\n}\ncomplete -F _golem_complete golem\n`;
    if (shell === "zsh")
        return `#compdef golem\n# golem completion — generated from typed registry\n_golem() {\n  local -a commands\n  commands=(${commandWords})\n  _describe 'golem command' commands\n}\ncompdef _golem golem\n`;
    return `# golem completion — generated from typed registry\ncomplete -c golem -f\n${publicCommands(registry)
        .map((command) => `complete -c golem -a '${command.name}' -d '${command.summary.replaceAll("'", "\\'")}'`)
        .join("\n")}\n`;
}
export function completionFile(shell) {
    return launcherOwnedPath(join("completions", `golem.${shell}`));
}
export async function runCompletions(input, io, registry) {
    const shell = shellFor(input);
    if (!shell) {
        io.stderr("cli.usage: completions requires bash, zsh, or fish");
        return 2;
    }
    const text = renderCompletion(shell, registry);
    const target = completionFile(shell);
    if (!input.apply) {
        if (input.json)
            io.stdout(stableCliJson({
                operation: "completions.generate",
                shell,
                target,
                apply: false,
                bytes: text.length,
            }));
        else
            io.stdout(text.trimEnd());
        return 0;
    }
    const existed = existsSync(target);
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
    if (input.json)
        io.stdout(stableCliJson({
            operation: "completions.install",
            shell,
            target,
            apply: true,
            existed,
        }));
    else
        io.stdout(`wrote ${target}; source it explicitly from your ${shell} setup`);
    return 0;
}
//# sourceMappingURL=completions.js.map