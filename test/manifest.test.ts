import { describe, expect, it } from 'bun:test';
import manifest from '../src/index.js';
import { ArmadaCompute } from '../src/provider.js';
import type { AdapterFactoryContext, SandboxProvider } from '../src/types.js';

const env: Record<string, string | undefined> = {
	ARMADA_URL: 'https://armada.example.com',
	ARMADA_QUEUE: 'marimohub',
	MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
	ARMADA_AGENT_IMAGE: 'ghcr.io/example/kernel-agent:1',
	ARMADA_AGENT_TOKEN_SECRET: 'test-secret-of-at-least-32-characters',
};

/** Stands in for marimohub's `NotFoundError`, which `errors.notFound` makes. */
class NotFoundError extends Error {}

const context: AdapterFactoryContext = {
	env,
	errors: {
		preconditionFailed: (message?: string) => new Error(message),
		notFound: (message?: string) => new NotFoundError(message),
	},
};

describe('adapter manifest', () => {
	it('declares the shape the loader validates', () => {
		expect(manifest.apiVersion).toBe(1);
		expect(manifest.kind).toBe('compute');
		expect(typeof manifest.create).toBe('function');
	});

	it('builds a provider exposing the full SandboxProvider surface', async () => {
		const provider: SandboxProvider = await manifest.create(context);
		expect(typeof provider.create).toBe('function');
		expect(typeof provider.proxy).toBe('function');
	});

	it("reports a gone sandbox with marimohub's not-found error", async () => {
		// The attach lookup answers that the sandbox has no job at all.
		const realFetch: typeof fetch = globalThis.fetch;
		globalThis.fetch = Object.assign(async (): Promise<Response> => Response.json({}), {
			preconnect: realFetch.preconnect,
		});
		try {
			const provider: SandboxProvider = await manifest.create(context);
			if (!(provider instanceof ArmadaCompute)) throw new Error('expected the Armada provider');
			const error: unknown = await provider
				.connectExisting('sb-gone')
				.exec('true')
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(NotFoundError);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it('refuses a marimohub older than 0.7.1, which offers no errors.notFound', () => {
		// What an older marimohub hands over: the same errors, less notFound.
		const errors: AdapterFactoryContext['errors'] = { ...context.errors };
		Reflect.deleteProperty(errors, 'notFound');

		expect(() => manifest.create({ ...context, errors })).toThrow('needs marimohub 0.7.1 or later');
	});

	it('rejects a missing required variable with an actionable message', () => {
		expect(() => manifest.create({ ...context, env: { ...env, ARMADA_URL: undefined } })).toThrow(
			'ARMADA_URL',
		);
	});

	it('rejects a url that is not http(s)', () => {
		for (const value of ['armada:30001', 'host.docker.internal:30001', 'not a url']) {
			expect(() => manifest.create({ ...context, env: { ...env, ARMADA_URL: value } })).toThrow(
				'ARMADA_URL must be an http(s) URL',
			);
		}
	});

	it('rejects a kernel port that is not a port number', () => {
		for (const value of ['not-a-number', '0', '70000', '2718.5']) {
			expect(() =>
				manifest.create({ ...context, env: { ...env, ARMADA_KERNEL_PORT: value } }),
			).toThrow('ARMADA_KERNEL_PORT must be a port number');
		}
	});
});
