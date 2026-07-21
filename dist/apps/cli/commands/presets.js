import { listLauncher, loadJsoncConfig, mergeLauncherConfig, planConfigWrite, resolveLaunch, writeJsoncConfig, } from "@golem/launcher";
import { stableCliJson } from "../format.js";
import { filesystemConfigPort, launcherConfigPath, launcherOwnedPath, readOwnedJson, writeOwnedJson, } from "./storage.js";
const harnesses = new Set(["codex", "opencode", "claude"]);
const backends = new Set([
    "openai",
    "anthropic",
    "ollama_local",
    "ollama_cloud",
    "native",
]);
const deliveryModes = new Set([
    "managed_app_server",
    "native_channel",
    "prompt_bridge",
    "pull",
    "next_turn",
]);
const secretLike = /(?:api[_-]?key|token|secret|password|credential|authorization)\s*=/iu;
function safePresetText(value) {
    return (value.trim().length > 0 &&
        !/[\0\r\n]/u.test(value) &&
        !secretLike.test(value));
}
function scopeFor(value) {
    return value === undefined || value === "user"
        ? "user"
        : value === "project"
            ? "project"
            : undefined;
}
function publicPreset(preset) {
    return {
        name: preset.name,
        harness: preset.harness,
        backend: preset.backend,
        model: preset.model_selector,
        delivery: preset.delivery_mode,
    };
}
function history() {
    const value = readOwnedJson(launcherOwnedPath("launcher-history.json"));
    if (!value || typeof value !== "object" || Array.isArray(value))
        return { favorites: [], recent: [] };
    const source = value;
    const strings = (candidate) => Array.isArray(candidate)
        ? candidate
            .filter((entry) => typeof entry === "string" &&
            /^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(entry))
            .slice(0, 24)
        : [];
    return {
        favorites: strings(source.favorites),
        recent: strings(source.recent),
    };
}
function writeHistory(next) {
    writeOwnedJson(launcherOwnedPath("launcher-history.json"), {
        schema_version: "golem.launcher-history/v1",
        favorites: [...next.favorites].sort(),
        recent: [...next.recent].slice(0, 12),
    });
}
export function recordRecentPreset(name) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(name))
        return;
    const current = history();
    writeHistory({
        favorites: current.favorites,
        recent: [name, ...current.recent.filter((entry) => entry !== name)].slice(0, 12),
    });
}
export function presetHistory() {
    return history();
}
function error(io, message) {
    io.stderr(`cli.usage: ${message}`);
    return 2;
}
/** Explicit scoped/global preset CRUD. A review-only invocation cannot create config files. */
export async function runPresets(input, io) {
    const [action = "list", name] = input.positionals;
    const scope = scopeFor(input.scope);
    if (!scope)
        return error(io, "--scope must be user or project");
    const path = launcherConfigPath(scope);
    const document = await loadJsoncConfig(filesystemConfigPort, path, scope);
    const config = document.config;
    if (action === "list") {
        const merged = mergeLauncherConfig({ [scope]: document });
        if ("code" in merged)
            return error(io, merged.message);
        const rows = merged.presets.map(publicPreset);
        const listed = listLauncher({ [scope]: document, now: input.now });
        const result = {
            operation: "presets.list",
            scope,
            path,
            presets: rows,
            capabilities: listed.capabilities,
            history: presetHistory(),
            warnings: document.warnings,
        };
        if (input.json)
            io.stdout(stableCliJson(result));
        else
            for (const row of rows)
                io.stdout(`${row.harness} ${row.name}: ${row.backend} ${row.model} (${row.delivery})`);
        if (!input.json)
            for (const capability of listed.capabilities.filter((entry) => !entry.launchable))
                io.stdout(`${capability.id}: unavailable (${capability.qualification}); remedy: ${capability.launch.remediation}`);
        return 0;
    }
    if (!name)
        return error(io, `presets ${action} requires a preset name`);
    if (action === "favorite") {
        const merged = mergeLauncherConfig({ [scope]: document });
        const exists = config.presets.some((preset) => preset.name === name) ||
            (!("code" in merged) &&
                merged.presets.some((preset) => preset.name === name));
        if (!exists)
            return error(io, `preset ${name} is not configured`);
        const current = history();
        const favorites = current.favorites.includes(name)
            ? current.favorites.filter((entry) => entry !== name)
            : [...current.favorites, name].sort();
        if (!input.apply) {
            const result = {
                operation: "presets.favorite",
                apply: false,
                name,
                favorites,
            };
            if (input.json)
                io.stdout(stableCliJson(result));
            else
                io.stdout(`dry-run favorite ${name}; re-run with --apply to save`);
            return 0;
        }
        writeHistory({ favorites, recent: current.recent });
        if (input.json)
            io.stdout(stableCliJson({
                operation: "presets.favorite",
                apply: true,
                name,
                favorites,
            }));
        else
            io.stdout(`saved favorite ${name}`);
        return 0;
    }
    let next;
    if (action === "remove") {
        next = config.presets.filter((preset) => preset.name !== name);
        if (next.length === config.presets.length)
            return error(io, `preset ${name} is not defined in ${scope} scope`);
    }
    else if (action === "set") {
        const harness = input.positionals[2];
        if (!harness || !harnesses.has(harness))
            return error(io, "presets set requires <name> <codex|opencode|claude>");
        if (!/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(name))
            return error(io, "preset names use letters, numbers, dots, underscores, and dashes only");
        if (!input.backend || !backends.has(input.backend))
            return error(io, "presets set requires --backend <openai|anthropic|ollama_local|ollama_cloud|native>");
        if (!input.model || !safePresetText(input.model))
            return error(io, "presets set requires a non-secret, single-line --model <selector>");
        if (!input.delivery || !deliveryModes.has(input.delivery))
            return error(io, "presets set requires --delivery <mode>");
        const preset = {
            name,
            harness,
            backend: input.backend,
            model_selector: input.model,
            delivery_mode: input.delivery,
            native_args: [],
            env_key_refs: [],
        };
        next = [
            ...config.presets.filter((entry) => !(entry.name === name && entry.harness === harness)),
            preset,
        ];
    }
    else {
        return error(io, `unknown presets action: ${action}`);
    }
    const nextConfig = { ...config, presets: next };
    const plan = planConfigWrite(path, document, nextConfig);
    const result = {
        operation: `presets.${action}`,
        scope,
        name,
        apply: input.apply,
        plan,
    };
    if (!input.apply) {
        if (input.json)
            io.stdout(stableCliJson(result));
        else
            io.stdout(`dry-run ${action} ${name}; re-run with --apply to save (${plan.sourceBytes}B → ${plan.nextBytes}B)`);
        return 0;
    }
    await writeJsoncConfig(filesystemConfigPort, plan, document, nextConfig, "save_launcher_config");
    if (input.json)
        io.stdout(stableCliJson({ ...result, apply: true }));
    else
        io.stdout(`saved ${action} ${name} in ${scope} launcher config`);
    return 0;
}
/** Picker entries are real resolver decisions, not a second eligibility model. */
export function pickerCandidates(input) {
    const merged = mergeLauncherConfig({
        ...(input.user ? { user: input.user } : {}),
        ...(input.project ? { project: input.project } : {}),
    });
    if ("code" in merged)
        return [];
    const historyState = history();
    const candidates = merged.presets.flatMap((preset) => {
        const resolution = resolveLaunch({
            harness: preset.harness,
            preset: preset.name,
            isTTY: true,
            now: input.now,
            ...(input.user ? { user: input.user } : {}),
            ...(input.project ? { project: input.project } : {}),
        });
        if (!resolution.ok || resolution.launch.status !== "launchable")
            return [];
        const hint = historyState.favorites.includes(preset.name)
            ? "favorite"
            : historyState.recent.includes(preset.name)
                ? "recent"
                : "available";
        return [
            {
                harness: preset.harness,
                name: preset.name,
                label: `${preset.harness} ${preset.name} · ${preset.backend} ${preset.model_selector} · ${hint}`,
                ...(resolution.warnings[0]
                    ? { warning: resolution.warnings[0].message }
                    : {}),
            },
        ];
    });
    return candidates.sort((left, right) => left.label.localeCompare(right.label));
}
//# sourceMappingURL=presets.js.map