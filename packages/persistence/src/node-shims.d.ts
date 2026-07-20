declare module "node:*" {
	const nodeModule: unknown;
	export default nodeModule;
}

declare const process: {
	readonly pid: number;
	kill(pid: number, signal: 0): void;
};
