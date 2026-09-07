import { describe, expect, it } from 'bun:test';
import { readConfig } from '../src/config.js';
import { ArmadaCompute } from '../src/provider.js';

const baseEnv: Record<string, string> = {
	ARMADA_URL: 'http://armada.example.com/',
	ARMADA_QUEUE: 'marimohub',
	MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
	ARMADA_AGENT_IMAGE: 'ghcr.io/example/kernel-agent:1',
};

describe('listActive capability', () => {
	it('is absent without ARMADA_LOOKOUT_URL, so marimohub skips reconciliation', () => {
		const provider: ArmadaCompute = new ArmadaCompute(readConfig(baseEnv));

		// marimohub reads the optional members as capability flags, so the member
		// must be missing, not present-and-throwing.
		expect(provider.listActive).toBeUndefined();
	});

	it('is present when Lookout is configured', () => {
		const provider: ArmadaCompute = new ArmadaCompute(
			readConfig({ ...baseEnv, ARMADA_LOOKOUT_URL: 'http://lookout.example.com' }),
		);

		expect(typeof provider.listActive).toBe('function');
	});

	it('rejects a Lookout URL that is not http(s)', () => {
		expect(() => readConfig({ ...baseEnv, ARMADA_LOOKOUT_URL: 'lookout.example.com' })).toThrow(
			'ARMADA_LOOKOUT_URL must be an http(s) URL',
		);
	});
});
