import { executionFailure } from "../process/errors.js";
import type { LaunchPlan } from "../types.js";

const defaultInheritedKeys = [
	"PATH",
	"HOME",
	"LANG",
	"LC_ALL",
	"TZ",
	"TERM",
	"COLORTERM",
	"NO_COLOR",
	"GOLEM_HOME",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
] as const;

const environmentKey = /^[A-Z][A-Z0-9_]*$/u;

export interface AdapterEnvironmentContribution {
	readonly values?: Readonly<Record<string, string>>;
	readonly inheritKeys?: readonly string[];
}

export interface EnvironmentBuildInput {
	readonly plan: LaunchPlan;
	readonly inherited?: Readonly<Record<string, string | undefined>>;
	readonly adapter?: AdapterEnvironmentContribution;
	readonly resolveSecret: (keyReference: string) => string | undefined;
}

export interface SanitizedEnvironment {
	/** Runtime-only values. Launch records intentionally expose only `keys`. */
	readonly values: Readonly<Record<string, string>>;
	readonly keys: readonly string[];
}

function assertKey(key: string): void {
	if (!environmentKey.test(key))
		throw executionFailure(
			"launcher.environment.key_invalid",
			"An environment key reference is invalid.",
			["Use an uppercase environment key reference without shell syntax."],
		);
}

function assertValue(value: string): void {
	if (/[\0\r\n]/u.test(value))
		throw executionFailure(
			"launcher.environment.value_invalid",
			"An environment value contains an unsafe control character.",
			[
				"Store the value in a supported credential provider or safe environment variable.",
			],
		);
}

/** Build a bounded environment; unrelated host credentials never cross the child boundary. */
export function buildSanitizedEnvironment(
	input: EnvironmentBuildInput,
): SanitizedEnvironment {
	const values: Record<string, string> = {};
	const inherited = input.inherited ?? process.env;
	const inheritedKeys = new Set<string>([
		...defaultInheritedKeys,
		...(input.adapter?.inheritKeys ?? []),
	]);
	for (const key of [...inheritedKeys].sort()) {
		assertKey(key);
		const value = inherited[key];
		if (typeof value !== "string" || !value) continue;
		assertValue(value);
		values[key] = value;
	}
	for (const key of [...input.plan.environmentKeyRefs].sort()) {
		assertKey(key);
		const value = input.resolveSecret(key);
		if (typeof value !== "string" || !value)
			throw executionFailure(
				"launcher.environment.secret_missing",
				"A required credential reference is unavailable.",
				[
					"Provide the named credential through the configured environment or credential provider.",
				],
			);
		assertValue(value);
		values[key] = value;
	}
	for (const [key, value] of Object.entries(input.adapter?.values ?? {})) {
		assertKey(key);
		assertValue(value);
		values[key] = value;
	}
	return Object.freeze({
		values: Object.freeze({ ...values }),
		keys: Object.freeze(Object.keys(values).sort()),
	});
}
