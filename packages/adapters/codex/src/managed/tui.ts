export interface ManagedCodexTuiBinding {
	readonly socketPath: string;
	readonly generationId: string;
	readonly remote: string;
	readonly cwd: string;
}

/**
 * The TUI bridge receives an opaque reserved socket from composition. The
 * adapter never accepts a caller-owned remote or cwd and therefore cannot
 * bypass the canonical endpoint fence.
 */
export interface ManagedCodexTuiPort {
	readonly open: (input: {
		readonly generationId: string;
		readonly cwd: string;
	}) => Promise<ManagedCodexTuiBinding>;
	readonly close: () => Promise<void>;
}

export function validateManagedTuiBinding(
	binding: ManagedCodexTuiBinding,
	expected: { readonly generationId: string; readonly cwd: string },
): ManagedCodexTuiBinding {
	if (
		binding.generationId !== expected.generationId ||
		binding.cwd !== expected.cwd
	)
		throw new Error("adapter.codex.managed.tui_binding_mismatch");
	return Object.freeze({ ...binding });
}
