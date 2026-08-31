import { describe, expect, it } from 'bun:test';
import manifest from '../src/index.js';
import type { AdapterFactoryContext, SandboxProvider } from '../src/types.js';

const env: Record<string, string | undefined> = {
	ARMADA_URL: 'https://armada.example.com',
	ARMADA_QUEUE: 'marimohub',
	MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
};

const context: AdapterFactoryContext = {
	env,
	errors: { preconditionFailed: (message?: string) => new Error(message) },
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
