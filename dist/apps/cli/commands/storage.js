import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
/** All launcher-owned files live under GOLEM_HOME; shell rc files are never touched. */
export function launcherHome() {
    return resolve(process.env.GOLEM_HOME ?? join(homedir(), ".golem"));
}
export function launcherConfigPath(scope) {
    if (scope === "project")
        return join(resolve(process.env.GOLEM_PROJECT_ROOT ?? process.cwd()), ".golem", "launcher.jsonc");
    return resolve(process.env.GOLEM_LAUNCHER_CONFIG ?? join(launcherHome(), "launcher.jsonc"));
}
export function launcherOwnedPath(name) {
    return join(launcherHome(), name);
}
export const filesystemConfigPort = {
    async readText(path) {
        return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    },
    async writeBackup(path, text) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
    },
    async writeTemporary(path, text) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
    },
    async commitTemporary(temporaryPath, targetPath) {
        mkdirSync(dirname(targetPath), { recursive: true });
        renameSync(temporaryPath, targetPath);
    },
    async rollback(targetPath, backupPath) {
        if (existsSync(backupPath))
            renameSync(backupPath, targetPath);
    },
    async removeTemporary(path) {
        rmSync(path, { force: true });
    },
};
export function readOwnedJson(path) {
    if (!existsSync(path))
        return undefined;
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return undefined;
    }
}
export function writeOwnedJson(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    renameSync(temporary, path);
}
//# sourceMappingURL=storage.js.map