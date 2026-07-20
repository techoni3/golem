import { explanation } from "./explain.js";
import { isTerminal } from "./lifecycle.js";
import type { DomainExplanation, DomainState, SessionRecord } from "./types.js";

export interface DomainProjections {
	readonly live: readonly SessionRecord[];
	readonly history: readonly SessionRecord[];
	readonly diagnostics: readonly DomainExplanation[];
}

export function projectDomain(state: DomainState): DomainProjections {
	const live: SessionRecord[] = [];
	const history: SessionRecord[] = [];
	const diagnostics: DomainExplanation[] = [];
	for (const session of Object.values(state.sessions)) {
		const active = session.activeGenerationId
			? state.generations[session.activeGenerationId]
			: undefined;
		if (active && !isTerminal(active.state)) {
			live.push(session);
			diagnostics.push(
				explanation("domain.projection.live", "info", {
					sessionId: session.sessionId,
					generationId: active.generationId,
				}),
			);
			continue;
		}
		if (session.generationIds.length > 0) {
			history.push(session);
			diagnostics.push(
				explanation("domain.projection.history_terminal", "info", {
					sessionId: session.sessionId,
				}),
			);
		} else
			diagnostics.push(
				explanation("domain.projection.no_active_generation", "warning", {
					sessionId: session.sessionId,
				}),
			);
	}
	return { live, history, diagnostics };
}
