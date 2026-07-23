declare const process: {
	readonly env: Readonly<Record<string, string | undefined>>;
	once(signal: "SIGTERM" | "SIGINT", listener: () => void): void;
	exit(code?: number): never;
};

declare class Buffer extends Uint8Array {}

declare module "node:stream" {
	export class Readable {}
	export class Writable {}
}

declare module "node:fs" {
	const fs: {
		readFileSync(target: string, encoding: "utf8"): string;
	};
	export default fs;
}

declare module "node:os" {
	const os: {
		homedir(): string;
	};
	export default os;
}

declare module "node:path" {
	const path: {
		join(...parts: readonly string[]): string;
	};
	export default path;
}
