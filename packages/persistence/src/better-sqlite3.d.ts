declare module "better-sqlite3" {
	export interface RunResult {
		readonly changes: number;
		readonly lastInsertRowid: number | bigint;
	}

	export interface Statement<Row = Record<string, unknown>> {
		readonly reader: boolean;
		run(...parameters: readonly unknown[]): RunResult;
		get(...parameters: readonly unknown[]): Row | undefined;
		all(...parameters: readonly unknown[]): readonly Row[];
	}

	export interface DatabaseOptions {
		readonly readonly?: boolean;
		readonly fileMustExist?: boolean;
	}

	export default class Database {
		constructor(filename: string, options?: DatabaseOptions);
		pragma(source: string, options?: { readonly simple?: boolean }): unknown;
		exec(source: string): this;
		prepare<Row = Record<string, unknown>>(source: string): Statement<Row>;
		transaction<Args extends readonly unknown[], Result>(
			fn: (...arguments_: Args) => Result,
		): (...arguments_: Args) => Result;
		close(): void;
	}
}
