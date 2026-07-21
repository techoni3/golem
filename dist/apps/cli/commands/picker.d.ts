export interface PickerEntry {
    readonly harness: string;
    readonly name: string;
    readonly label: string;
    readonly warning?: string;
}
export interface PickerIo {
    readonly stdout: (line: string) => void;
    readonly readLine?: (prompt: string) => Promise<string>;
}
/** A small line-keyboard picker: number/Enter selects; q/Esc cancels without a write. */
export declare function choosePreset(entries: readonly PickerEntry[], io: PickerIo): Promise<PickerEntry | undefined>;
//# sourceMappingURL=picker.d.ts.map