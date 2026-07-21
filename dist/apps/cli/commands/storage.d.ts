import type { ConfigScope, ConfigTextPort } from "@golem/launcher";
/** All launcher-owned files live under GOLEM_HOME; shell rc files are never touched. */
export declare function launcherHome(): string;
export declare function launcherConfigPath(scope: ConfigScope): string;
export declare function launcherOwnedPath(name: string): string;
export declare const filesystemConfigPort: ConfigTextPort;
export declare function readOwnedJson(path: string): unknown;
export declare function writeOwnedJson(path: string, value: unknown): void;
//# sourceMappingURL=storage.d.ts.map