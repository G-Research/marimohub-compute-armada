import { describe, expect, it } from 'bun:test';
import type { V1Container, V1PodSpec } from '@kubernetes/client-node';
import { readConfig } from '../src/config.js';
import type { ArmadaConfig } from '../src/config.js';
import { AGENT_PATH, AGENT_TOKEN_HASH_ENV, buildPodSpec, exposedPorts } from '../src/podspec.js';
import type { AgentSpec } from '../src/podspec.js';

const baseEnv: Record<string, string> = {
	ARMADA_URL: 'http://armada.example.com',
	ARMADA_QUEUE: 'marimohub',
	MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
	ARMADA_AGENT_IMAGE: 'ghcr.io/example/kernel-agent:1',
};
const config: ArmadaConfig = readConfig(baseEnv);
const agent: AgentSpec = { tokenSha256: 'ab'.repeat(32) };

describe('podspec', () => {
	it('satisfies the rules Armada rejects submissions over', () => {
		const spec: V1PodSpec = buildPodSpec(config, agent);
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
		expect(container?.ports).toEqual([
			{ containerPort: config.port, protocol: 'TCP' },
			{ containerPort: config.agentPort, protocol: 'TCP' },
		]);
	});

	it('gives the init container resources Armada accepts, including a fractional cpu', () => {
		const install: V1Container | undefined = buildPodSpec(config, agent).initContainers?.[0];

		expect(install?.image).toBe('ghcr.io/example/kernel-agent:1');
		expect(install?.resources?.requests).toEqual(install?.resources?.limits ?? {});
		// A server with the fractional-cpu assertion on rejects a whole core.
		expect(install?.resources?.requests?.['cpu']).toMatch(/^\d+m$/);
	});

	it('never inherits Armada default deadline', () => {
		expect(buildPodSpec(config, agent).activeDeadlineSeconds).toBe(config.maxLifetimeSeconds);

		const lived: ArmadaConfig = readConfig(baseEnv, { sessionMaxLifetimeSeconds: 900 });
		expect(buildPodSpec(lived, agent).activeDeadlineSeconds).toBe(900);
	});

	it('runs the agent as PID 1 from the volume the init container filled', () => {
		const spec: V1PodSpec = buildPodSpec(config, agent);
		const kernel: V1Container | undefined = spec.containers[0];

		expect(kernel?.command).toEqual([AGENT_PATH, '--port', '8718']);
		expect(spec.initContainers?.[0]?.command).toEqual(['/agent', 'install', AGENT_PATH]);
		// Both containers mount the same volume, so the copy is what the kernel runs.
		expect(kernel?.volumeMounts).toEqual(spec.initContainers?.[0]?.volumeMounts);
		expect(spec.volumes?.map((volume: { name: string }) => volume.name)).toEqual(
			kernel?.volumeMounts?.map((mount: { name: string }) => mount.name),
		);
	});

	it('carries the hash of the token and never the token', () => {
		const spec: V1PodSpec = buildPodSpec(config, agent);
		expect(spec.containers[0]?.env).toEqual([
			{ name: AGENT_TOKEN_HASH_ENV, value: agent.tokenSha256 },
		]);
		expect(JSON.stringify(spec)).not.toContain('token');
	});

	it('takes the image and resources marimohub asks for', () => {
		const spec: V1PodSpec = buildPodSpec(config, agent, {
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
		const spec: V1PodSpec = buildPodSpec(config, agent, { resources: { gpu: 'A100' } });
		expect(spec.containers[0]?.resources?.requests?.['nvidia.com/gpu']).toBe('1');
	});

	it('exposes every port the pod declares, and only those', () => {
		expect(exposedPorts(buildPodSpec(config, agent))).toEqual([config.port, config.agentPort]);
		expect(exposedPorts({ containers: [{ name: 'mute' }] })).toEqual([]);
	});

	it('omits the priority class unless one is configured', () => {
		expect('priorityClassName' in buildPodSpec(config, agent)).toBe(false);

		const pinned: ArmadaConfig = readConfig({
			...baseEnv,
			ARMADA_PRIORITY_CLASS: 'armada-default',
		});
		expect(buildPodSpec(pinned, agent).priorityClassName).toBe('armada-default');
	});

	it('refuses an agent port that collides with the kernel port', () => {
		expect(() => readConfig({ ...baseEnv, ARMADA_AGENT_PORT: '2718' })).toThrow(
			'ARMADA_AGENT_PORT and ARMADA_KERNEL_PORT are both 2718',
		);
	});
});
