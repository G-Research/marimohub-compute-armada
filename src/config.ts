export interface ArmadaConfig {
	/** Armada REST gateway base URL, http or https. */
	url: string;
	/** Armada queue jobs are submitted to. */
	queue: string;
	/** Kubernetes namespace the executor creates pods in. */
	namespace: string;
	/**
	 * Armada priority class, not a Kubernetes one. Must be in the server's
	 * `allowedPriorityClassNames`. Leave unset to get the server default, which
	 * ships as `armada-default` (`preemptible: false`); only override with
	 * something at least as protected, or sessions die mid-use.
	 */
	priorityClassName?: string | undefined;
	/** Kernel container image. */
	image: string;
	/** Public hostname kernels are reached at. */
	sandboxHostname?: string | undefined;
	/** Port marimo serves on inside the pod. */
	port: number;
}

function required(env: Record<string, string | undefined>, name: string): string {
	const value: string | undefined = env[name];
	if (!value) throw new Error(`Missing required env var: ${name}`);
	return value;
}

/** As `required`, but rejects anything that is not an http(s) URL. */
function requiredUrl(env: Record<string, string | undefined>, name: string): string {
	const value: string = required(env, name);
	const parsed: URL | null = URL.canParse(value) ? new URL(value) : null;
	if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
		throw new Error(`${name} must be an http(s) URL, got: ${value}`);
	}
	return value;
}

function optionalPort(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
): number {
	const raw: string | undefined = env[name];
	if (raw === undefined) return fallback;
	const value: number = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		throw new Error(`${name} must be a port number between 1 and 65535, got: ${raw}`);
	}
	return value;
}

export function readConfig(env: Record<string, string | undefined>): ArmadaConfig {
	// MARIMOHUB_COMPUTE_IMAGE is a comma-separated list; the first is the default.
	const image: string | undefined = required(env, 'MARIMOHUB_COMPUTE_IMAGE').split(',')[0]?.trim();
	if (!image) throw new Error('MARIMOHUB_COMPUTE_IMAGE must contain at least one image');

	return {
		url: requiredUrl(env, 'ARMADA_URL'),
		queue: required(env, 'ARMADA_QUEUE'),
		namespace: env.ARMADA_NAMESPACE ?? 'default',
		priorityClassName: env.ARMADA_PRIORITY_CLASS,
		image,
		sandboxHostname: env.MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME,
		port: optionalPort(env, 'ARMADA_KERNEL_PORT', 2718),
	};
}
