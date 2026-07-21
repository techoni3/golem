import assert from "node:assert/strict";
import { commandRegistry } from "../../dist/apps/cli/registry.js";
import { renderCompletion } from "../../dist/apps/cli/commands/completions.js";

for (const shell of ["bash", "zsh", "fish"]) {
	const completion = renderCompletion(shell, commandRegistry);
	for (const command of commandRegistry.filter((entry) => !entry.hidden && !entry.compatibility))
		assert.match(completion, new RegExp(command.name.replace(/[:]/gu, "\\$&")), `${shell} completion must derive ${command.name} from registry`);
}
process.stdout.write("registry-derived bash/zsh/fish completion vocabulary verified\n");
