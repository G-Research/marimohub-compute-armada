import { describe, expect, it } from 'bun:test';
import { readConfig } from '../src/config.js';
import { ArmadaCompute } from '../src/provider.js';

/** Stands in for marimohub's `errors.notFound`. */
const notFound: (message: string) => Error = (message: string): Error => new Error(message);

const baseEnv: Record<string, string> = {
	ARMADA_URL: 'http://armada.example.com/',
	ARMADA_QUEUE: 'marimohub',
	MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
	ARMADA_AGENT_IMAGE: 'ghcr.io/example/kernel-agent:1',
	ARMADA_AGENT_TOKEN_SECRET: 'test-secret-of-at-least-32-characters',
};

describe('listActive capability', () => {
	it('is absent without ARMADA_LOOKOUT_URL, so marimohub skips reconciliation', () => {
		const provider: ArmadaCompute = new ArmadaCompute(readConfig(baseEnv), notFound);

		// marimohub reads the optional members as capability flags, so the member
		// must be missing, not present-and-throwing.
		expect(provider.listActive).toBeUndefined();
	});

	it('is present when Lookout is configured', () => {
		const provider: ArmadaCompute = new ArmadaCompute(
			readConfig({ ...baseEnv, ARMADA_LOOKOUT_URL: 'http://lookout.example.com' }),
			notFound,
		);

		expect(typeof provider.listActive).toBe('function');
	});

	it('rejects a Lookout URL that is not http(s)', () => {
		expect(() => readConfig({ ...baseEnv, ARMADA_LOOKOUT_URL: 'lookout.example.com' })).toThrow(
			'ARMADA_LOOKOUT_URL must be an http(s) URL',
		);
	});
});

describe('queue maps', () => {
	it('are refused without Lookout, which is the only way to place an id-only sandbox', () => {
		expect(() =>
			readConfig({ ...baseEnv, ARMADA_QUEUE_BY_PROJECT: '{"proj-b": "team-b"}' }),
		).toThrow('needs ARMADA_LOOKOUT_URL');
	});

	it('are fine without Lookout when every entry names the default queue', () => {
		expect(
			readConfig({ ...baseEnv, ARMADA_QUEUE_BY_PROJECT: '{"proj-b": "marimohub"}' }).queueByProject,
		).toEqual({ 'proj-b': 'marimohub' });
	});
});

describe('multiPort capability', () => {
	it('is off with no surface configured, so marimohub refuses to start one', () => {
		expect(new ArmadaCompute(readConfig(baseEnv), notFound).capabilities.multiPort).toBe(false);
	});

	it('is on exactly when a surface port is declared on every pod', () => {
		const provider: ArmadaCompute = new ArmadaCompute(
			readConfig({ ...baseEnv, MARIMOHUB_SURFACES: 'vscode' }),
			notFound,
		);
		expect(provider.capabilities.multiPort).toBe(true);
	});
});

describe('compute profile capabilities', () => {
	it('apply CPU and memory always, and GPUs only with a node selector map', () => {
		expect(new ArmadaCompute(readConfig(baseEnv), notFound).capabilities).toEqual({
			multiPort: false,
			computeProfiles: true,
			gpuProfiles: false,
		});
	});

	it('apply GPUs once each type maps to a node selector', () => {
		const provider: ArmadaCompute = new ArmadaCompute(
			readConfig({
				...baseEnv,
				ARMADA_GPU_NODE_SELECTORS: '{"A100": {"nvidia.com/gpu.product": "NVIDIA-A100-SXM4-80GB"}}',
			}),
			notFound,
		);
		expect(provider.capabilities.gpuProfiles).toBe(true);
	});
});

describe('connectExisting', () => {
	it('is present, so marimohub can save an expired session before reclaiming it', () => {
		expect(typeof new ArmadaCompute(readConfig(baseEnv), notFound).connectExisting).toBe(
			'function',
		);
	});
});
