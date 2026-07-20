import type {
	Disposition,
	DomainExplanation,
	DomainState,
	ExplanationCode,
	ReducerResult,
} from "./types.js";

export function explanation(
	code: ExplanationCode,
	severity: DomainExplanation["severity"],
	facts: DomainExplanation["facts"],
): DomainExplanation {
	return { code, severity, facts };
}

export function result(
	state: DomainState,
	disposition: Disposition,
	code: ExplanationCode,
	facts: DomainExplanation["facts"],
): ReducerResult {
	return {
		state,
		effect: {
			disposition,
			explanation: explanation(
				code,
				disposition === "rejected"
					? "error"
					: disposition === "review"
						? "warning"
						: "info",
				facts,
			),
		},
	};
}
