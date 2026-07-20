declare module "node:crypto" {
	const crypto: {
		createHash(name: "sha256"): {
			update(value: string): { digest(encoding: "hex"): string };
		};
		randomUUID(): string;
	};
	export default crypto;
}

declare module "node:fs" {
	const fs: {
		constants: { COPYFILE_FICLONE: number };
		closeSync(descriptor: number): void;
		existsSync(target: string): boolean;
		mkdirSync(
			target: string,
			options: { recursive: true; mode?: number },
		): void;
		openSync(target: string, flags: "wx", mode: number): number;
		readFileSync(target: string, encoding: "utf8"): string;
		readdirSync(target: string): readonly string[];
		rmSync(target: string, options: { force: true }): void;
		unlinkSync(target: string): void;
		writeFileSync(target: number, value: string): void;
	};
	export default fs;
}

declare module "node:path" {
	const path: {
		basename(target: string): string;
		dirname(target: string): string;
		join(...parts: readonly string[]): string;
	};
	export default path;
}

declare const process: {
	readonly pid: number;
	kill(pid: number, signal: 0): void;
};
