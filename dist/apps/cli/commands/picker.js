import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
/** A small line-keyboard picker: number/Enter selects; q/Esc cancels without a write. */
export async function choosePreset(entries, io) {
    if (entries.length === 0) {
        io.stdout("No launchable presets. Run `golem presets list` or `golem doctor` for a remedy.");
        return undefined;
    }
    io.stdout("Choose a qualified launch preset (q to cancel):");
    for (const [index, entry] of entries.entries())
        io.stdout(`${index + 1}) ${entry.label}${entry.warning ? " · pull-only warning" : ""}`);
    const read = io.readLine ??
        (async (prompt) => {
            const terminal = createInterface({ input, output });
            try {
                return await terminal.question(prompt);
            }
            finally {
                terminal.close();
            }
        });
    const answer = (await read("Selection [1]: ")).trim();
    if (answer === "q" || answer === "Q" || answer === "\u001b")
        return undefined;
    if (answer === "")
        return entries[0];
    const index = Number.parseInt(answer, 10) - 1;
    return Number.isInteger(index) && index >= 0 && index < entries.length
        ? entries[index]
        : undefined;
}
//# sourceMappingURL=picker.js.map