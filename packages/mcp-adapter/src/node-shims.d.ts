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
