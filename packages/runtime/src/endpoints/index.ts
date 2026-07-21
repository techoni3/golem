import type {
	EndpointRouteKind,
	RuntimeEndpointEligibility,
	RuntimeEndpointMutationResult,
	RuntimeEndpointStorage,
	RuntimeEndpointView,
} from "@golem/persistence";

export interface EndpointServiceOptions {
	readonly storage: RuntimeEndpointStorage;
}

/** Application-facing endpoint service; transport and harness adapters stay outside this package. */
export class EndpointService {
	readonly #storage: RuntimeEndpointStorage;

	constructor(options: EndpointServiceOptions) {
		this.#storage = options.storage;
	}

	claim(
		input: Parameters<RuntimeEndpointStorage["claim"]>[0],
	): RuntimeEndpointMutationResult {
		return this.#storage.claim(input);
	}

	heartbeat(
		input: Parameters<RuntimeEndpointStorage["heartbeat"]>[0],
	): RuntimeEndpointMutationResult {
		return this.#storage.heartbeat(input);
	}

	reportHealth(
		input: Parameters<RuntimeEndpointStorage["reportHealth"]>[0],
	): RuntimeEndpointMutationResult {
		return this.#storage.reportHealth(input);
	}

	reportReadiness(
		input: Parameters<RuntimeEndpointStorage["reportReadiness"]>[0],
	): RuntimeEndpointMutationResult {
		return this.#storage.reportReadiness(input);
	}

	probe(
		input: Parameters<RuntimeEndpointStorage["probe"]>[0],
	): RuntimeEndpointMutationResult {
		return this.#storage.probe(input);
	}

	reportDelivery(
		input: Parameters<RuntimeEndpointStorage["reportDelivery"]>[0],
	): RuntimeEndpointMutationResult {
		return this.#storage.reportDelivery(input);
	}

	reportCapability(
		input: Parameters<RuntimeEndpointStorage["reportCapability"]>[0],
	): RuntimeEndpointMutationResult {
		return this.#storage.reportCapability(input);
	}

	release(
		input: Parameters<RuntimeEndpointStorage["release"]>[0],
	): RuntimeEndpointMutationResult {
		return this.#storage.release(input);
	}

	expire(now?: string): readonly RuntimeEndpointMutationResult[] {
		return this.#storage.expire(now);
	}

	eligibility(
		input: Parameters<RuntimeEndpointStorage["eligibility"]>[0],
	): RuntimeEndpointEligibility {
		return this.#storage.eligibility(input);
	}

	get(endpointId: string): RuntimeEndpointView | undefined {
		return this.#storage.get(endpointId);
	}

	list(
		generationId: string,
		routeKind?: EndpointRouteKind,
	): readonly RuntimeEndpointView[] {
		const endpoints = this.#storage.list(generationId);
		return routeKind
			? endpoints.filter((endpoint) => endpoint.routeKind === routeKind)
			: endpoints;
	}
}

export function createEndpointService(
	options: EndpointServiceOptions,
): EndpointService {
	return new EndpointService(options);
}
