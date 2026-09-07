import { readFileSync } from 'node:fs';
import type { ArmadaAuth } from './auth.js';
import type { AdapterFactoryContext } from './types.js';

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
	/**
	 * Image of the kernel agent, which an init container copies into the kernel
	 * container (AGENT-DESIGN.md). Required: there is no public default yet, and
	 * a wrong guess would fail at the first session rather than at startup.
	 */
	agentImage: string;
	/** Port the agent listens on inside the pod, exposed next to the kernel's. */
	agentPort: number;
	/**
	 * Hard cap on one session, submitted as `activeDeadlineSeconds`. Armada gives
	 * any pod without one the server default, 72 hours as shipped, so a kernel must
	 * always carry its own.
	 */
	maxLifetimeSeconds: number;
	/**
	 * Backstop for a single `exec`, in seconds. `0` turns it off.
	 *
	 * Not a timeout: the caller's own `ExecOptions.timeout` is the timeout, and
	 * most of marimohub's exec calls deliberately carry none because unpacking a
	 * workspace or running a data preview legitimately takes minutes. This is the
	 * hours-later answer to "nobody expected this to still be running", which
	 * otherwise holds a request and a process for the rest of the session. It is
	 * enforced by the agent, as the deadline of a command that arrived without
	 * one. Streams are exempt: how long one stays open is the consumer's choice.
	 */
	commandMaxSeconds: number;
	/** How to authenticate to Armada. */
	auth: ArmadaAuth;
	/**
	 * Lookout base URL, for `listActive`. Armada's own API has no "list the jobs
	 * I own" call, and Lookout is the component that aggregates jobs across every
	 * executor cluster, so enumeration goes through it. Optional: without it the
	 * provider does not advertise `listActive` and marimohub skips reconciliation,
	 * which is exactly the behaviour before this existed.
	 */
	lookoutUrl?: string | undefined;
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

/** As `requiredUrl`, but absent is a valid answer. */
function optionalUrl(env: Record<string, string | undefined>, name: string): string | undefined {
	if (env[name] === undefined) return undefined;
	return requiredUrl(env, name);
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

function optionalSeconds(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
	least: number = 1,
): number {
	const raw: string | undefined = env[name];
	if (raw === undefined) return fallback;
	const value: number = Number(raw);
	if (!Number.isInteger(value) || value < least) {
		throw new Error(`${name} must be a whole number of seconds, got: ${raw}`);
	}
	return value;
}

/**
 * At most one mechanism may be configured. Anonymous is a real choice, not a
 * fallback: the quickstart server runs with `anonymousAuth: true`.
 */
function readAuth(env: Record<string, string | undefined>): ArmadaAuth {
	const username: string | undefined = env.ARMADA_AUTH_USERNAME;
	const password: string | undefined = env.ARMADA_AUTH_PASSWORD;
	const token: string | undefined = env.ARMADA_AUTH_TOKEN;
	const tokenFile: string | undefined = env.ARMADA_AUTH_TOKEN_FILE;

	const configured: string[] = [
		username !== undefined || password !== undefined ? 'ARMADA_AUTH_USERNAME/PASSWORD' : undefined,
		token !== undefined ? 'ARMADA_AUTH_TOKEN' : undefined,
		tokenFile !== undefined ? 'ARMADA_AUTH_TOKEN_FILE' : undefined,
	].filter((name: string | undefined) => name !== undefined);

	if (configured.length > 1) {
		throw new Error(`Configure one Armada auth mechanism, found: ${configured.join(', ')}`);
	}

	if (username !== undefined || password !== undefined) {
		if (!username || !password) {
			throw new Error('ARMADA_AUTH_USERNAME and ARMADA_AUTH_PASSWORD must be set together');
		}
		return { kind: 'basic', username, password };
	}

	if (token !== undefined) {
		if (!token.trim()) throw new Error('ARMADA_AUTH_TOKEN is empty');
		return { kind: 'bearer', token: token.trim() };
	}

	if (tokenFile !== undefined) {
		// Read once here so a bad path fails marimohub's startup rather than the
		// first session. The value is re-read per request, not cached.
		let contents: string;
		try {
			contents = readFileSync(tokenFile, 'utf8');
		} catch {
			throw new Error(`ARMADA_AUTH_TOKEN_FILE cannot be read: ${tokenFile}`);
		}
		if (!contents.trim()) throw new Error(`ARMADA_AUTH_TOKEN_FILE is empty: ${tokenFile}`);
		return { kind: 'bearerFile', path: tokenFile };
	}

	return { kind: 'anonymous' };
}

/** A day, when neither marimohub nor the environment says otherwise. */
const DEFAULT_MAX_LIFETIME_SECONDS = 24 * 60 * 60;

/**
 * Far past anything marimohub's own commands do, since a backstop that competes
 * with legitimate work is worse than none. The pod's own `activeDeadlineSeconds`
 * (decision 7) is the outer bound; this catches a wedged command long before it.
 */
const DEFAULT_COMMAND_MAX_SECONDS = 6 * 60 * 60;

export function readConfig(
	env: Record<string, string | undefined>,
	compute?: AdapterFactoryContext['compute'],
): ArmadaConfig {
	// MARIMOHUB_COMPUTE_IMAGE is a comma-separated list; the first is the default.
	const image: string | undefined = required(env, 'MARIMOHUB_COMPUTE_IMAGE').split(',')[0]?.trim();
	if (!image) throw new Error('MARIMOHUB_COMPUTE_IMAGE must contain at least one image');

	const config: ArmadaConfig = {
		url: requiredUrl(env, 'ARMADA_URL'),
		queue: required(env, 'ARMADA_QUEUE'),
		namespace: env.ARMADA_NAMESPACE ?? 'default',
		priorityClassName: env.ARMADA_PRIORITY_CLASS,
		image,
		sandboxHostname: env.MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME,
		port: optionalPort(env, 'ARMADA_KERNEL_PORT', 2718),
		agentImage: required(env, 'ARMADA_AGENT_IMAGE'),
		agentPort: optionalPort(env, 'ARMADA_AGENT_PORT', 8718),
		lookoutUrl: optionalUrl(env, 'ARMADA_LOOKOUT_URL'),
		maxLifetimeSeconds:
			compute?.sessionMaxLifetimeSeconds ??
			optionalSeconds(env, 'ARMADA_KERNEL_MAX_LIFETIME_SECONDS', DEFAULT_MAX_LIFETIME_SECONDS),
		commandMaxSeconds: optionalSeconds(
			env,
			'ARMADA_COMMAND_MAX_SECONDS',
			DEFAULT_COMMAND_MAX_SECONDS,
			0,
		),
		auth: readAuth(env),
	};
	if (config.agentPort === config.port) {
		throw new Error(
			`ARMADA_AGENT_PORT and ARMADA_KERNEL_PORT are both ${String(config.port)}; the agent and the kernel each need a port`,
		);
	}
	return config;
}
