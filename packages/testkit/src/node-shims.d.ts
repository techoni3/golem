declare module "node:*" {
	const nodeModule: unknown;
	export default nodeModule;
}

declare const process: {
	readonly platform: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
};
