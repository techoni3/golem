import type { Harness } from "@golem/contracts";
import { loadJsoncConfig } from "@golem/launcher";
export interface PresetCommandInput {
    readonly positionals: readonly string[];
    readonly scope?: string;
    readonly backend?: string;
    readonly model?: string;
    readonly delivery?: string;
    readonly apply: boolean;
    readonly json: boolean;
    readonly now: string;
}
export interface PresetCommandIo {
    readonly stdout: (line: string) => void;
    readonly stderr: (line: string) => void;
}
export declare function recordRecentPreset(name: string): void;
export declare function presetHistory(): {
    readonly favorites: readonly string[];
    readonly recent: readonly string[];
};
/** Explicit scoped/global preset CRUD. A review-only invocation cannot create config files. */
export declare function runPresets(input: PresetCommandInput, io: PresetCommandIo): Promise<number>;
/** Picker entries are real resolver decisions, not a second eligibility model. */
export declare function pickerCandidates(input: {
    readonly now: string;
    readonly user?: Awaited<ReturnType<typeof loadJsoncConfig>>;
    readonly project?: Awaited<ReturnType<typeof loadJsoncConfig>>;
}): readonly {
    readonly harness: Harness;
    readonly name: string;
    readonly label: string;
    readonly warning?: string;
}[];
//# sourceMappingURL=presets.d.ts.map