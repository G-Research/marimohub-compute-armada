import { describe, expect, it } from 'bun:test';
import type { V1Container, V1PodSpec } from '@kubernetes/client-node';
import { readConfig } from '../src/config.js';
import type { ArmadaConfig } from '../src/config.js';
import { buildPodSpec } from '../src/podspec.js';

const config: ArmadaConfig = readConfig({
	ARMADA_URL: 'http://armada.example.com',
	ARMADA_QUEUE: 'marimohub',
	MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
});

describe('podspec', () => {
	it('satisfies the rules Armada rejects submissions over', () => {
		const spec: V1PodSpec = buildPodSpec(config);
		const container: V1Container | undefined = spec.containers[0];

		expect(spec.restartPolicy).toBe('Never');
		// Inside Armada's 1s to 5m window; 0 would be rewritten, above the cap rejected.
		expect(spec.terminationGracePeriodSeconds).toBeGreaterThanOrEqual(1);
		expect(spec.terminationGracePeriodSeconds).toBeLessThanOrEqual(300);
		// Requests must equal limits, and every container must set both.
		expect(container?.resources?.requests).toEqual(container?.resources?.limits ?? {});
		expect(container?.resources?.requests?.['cpu']).toBeDefined();
		expect(container?.resources?.requests?.['memory']).toBeDefined();
		// Only declared container ports can be exposed by a service or ingress.
		expect(container?.ports).toEqual([{ containerPort: config.port, protocol: 'TCP' }]);
	});

	it('never inherits Armada default deadline', () => {
		expect(buildPodSpec(config).activeDeadlineSeconds).toBe(config.maxLifetimeSeconds);

		const lived: ArmadaConfig = readConfig(
			{
				ARMADA_URL: 'http://armada.example.com',
				ARMADA_QUEUE: 'marimohub',
				MARIMOHUB_COMPUTE_IMAGE: 'image:latest',
			},
			{ sessionMaxLifetimeSeconds: 900 },
		);
		expect(buildPodSpec(lived).activeDeadlineSeconds).toBe(900);
	});

	it('idles, because marimohub starts the kernel itself', () => {
		expect(buildPodSpec(config).containers[0]?.command).toEqual(['sleep', 'infinity']);
	});

	it('takes the image and resources marimohub asks for', () => {
		const spec: V1PodSpec = buildPodSpec(config, {
			image: 'other:tag',
			resources: { cpu: 4, memoryBytes: 8589934592, gpu: 'A100:2' },
		});
		const container: V1Container | undefined = spec.containers[0];

		expect(container?.image).toBe('other:tag');
		expect(container?.resources?.requests).toEqual({
			cpu: '4',
			memory: '8589934592',
			'nvidia.com/gpu': '2',
		});
	});

	it('defaults a gpu without a count to one', () => {
		const spec: V1PodSpec = buildPodSpec(config, { resources: { gpu: 'A100' } });
		expect(spec.containers[0]?.resources?.requests?.['nvidia.com/gpu']).toBe('1');
	});

	it('omits the priority class unless one is configured', () => {
		expect('priorityClassName' in buildPodSpec(config)).toBe(false);

		const pinned: ArmadaConfig = readConfig({
			ARMADA_URL: 'http://armada.example.com',
			ARMADA_QUEUE: 'marimohub',
			MARIMOHUB_COMPUTE_IMAGE: 'image:latest',
			ARMADA_PRIORITY_CLASS: 'armada-default',
		});
		expect(buildPodSpec(pinned).priorityClassName).toBe('armada-default');
	});
});
