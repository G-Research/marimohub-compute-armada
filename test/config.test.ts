import { describe, expect, it } from 'bun:test';
import { DEFAULT_IMAGE, readConfig } from '../src/config.js';
import type { ArmadaConfig } from '../src/config.js';

const baseEnv: Record<string, string> = {
	ARMADA_URL: 'http://armada.example.com',
	ARMADA_QUEUE: 'marimohub',
	MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
	ARMADA_AGENT_IMAGE: 'ghcr.io/example/kernel-agent:1',
};

describe('MARIMOHUB_COMPUTE_IMAGE', () => {
	it("is marimo's published sandbox image when unset", () => {
		const env: Record<string, string> = { ...baseEnv };
		delete env.MARIMOHUB_COMPUTE_IMAGE;
		expect(readConfig(env).image).toBe(DEFAULT_IMAGE);
	});

	it('takes the first of a list', () => {
		expect(readConfig({ ...baseEnv, MARIMOHUB_COMPUTE_IMAGE: 'a:1, b:2' }).image).toBe('a:1');
	});

	it('refuses an empty value rather than silently defaulting', () => {
		expect(() => readConfig({ ...baseEnv, MARIMOHUB_COMPUTE_IMAGE: '' })).toThrow(
			'at least one image',
		);
	});
});

describe('ARMADA_EXPOSE', () => {
	it('is a NodePort service unless told otherwise', () => {
		expect(readConfig(baseEnv).expose).toEqual({ kind: 'nodeport' });
	});

	it('is an Ingress with TLS on by default', () => {
		const config: ArmadaConfig = readConfig({ ...baseEnv, ARMADA_EXPOSE: 'ingress' });
		expect(config.expose).toEqual({
			kind: 'ingress',
			tls: true,
			certName: undefined,
			annotations: {},
		});
	});

	it('reads the certificate name and per-job annotations', () => {
		const config: ArmadaConfig = readConfig({
			...baseEnv,
			ARMADA_EXPOSE: 'ingress',
			ARMADA_INGRESS_TLS: 'false',
			ARMADA_INGRESS_CERT_NAME: 'kernels-',
			ARMADA_INGRESS_ANNOTATIONS: '{"nginx.ingress.kubernetes.io/proxy-read-timeout":"3600"}',
		});
		expect(config.expose).toEqual({
			kind: 'ingress',
			tls: false,
			certName: 'kernels-',
			annotations: { 'nginx.ingress.kubernetes.io/proxy-read-timeout': '3600' },
		});
	});

	it('rejects a value that is neither', () => {
		expect(() => readConfig({ ...baseEnv, ARMADA_EXPOSE: 'loadbalancer' })).toThrow(
			'ARMADA_EXPOSE must be nodeport or ingress, got: loadbalancer',
		);
	});

	it('rejects ingress settings beside a NodePort, rather than ignoring them', () => {
		expect(() =>
			readConfig({ ...baseEnv, ARMADA_INGRESS_TLS: 'true', ARMADA_INGRESS_CERT_NAME: 'x-' }),
		).toThrow('ARMADA_INGRESS_TLS, ARMADA_INGRESS_CERT_NAME only apply with ARMADA_EXPOSE=ingress');
	});

	it('rejects a TLS flag that is not true or false', () => {
		expect(() =>
			readConfig({ ...baseEnv, ARMADA_EXPOSE: 'ingress', ARMADA_INGRESS_TLS: 'yes' }),
		).toThrow('ARMADA_INGRESS_TLS must be true or false, got: yes');
	});

	it('rejects annotations that are not a JSON object of strings', () => {
		const ingress: Record<string, string> = { ...baseEnv, ARMADA_EXPOSE: 'ingress' };
		expect(() => readConfig({ ...ingress, ARMADA_INGRESS_ANNOTATIONS: 'nginx' })).toThrow(
			'ARMADA_INGRESS_ANNOTATIONS must be a JSON object, got: nginx',
		);
		expect(() => readConfig({ ...ingress, ARMADA_INGRESS_ANNOTATIONS: '["a"]' })).toThrow(
			'ARMADA_INGRESS_ANNOTATIONS must be a JSON object, got: ["a"]',
		);
		expect(() => readConfig({ ...ingress, ARMADA_INGRESS_ANNOTATIONS: '{"a":1}' })).toThrow(
			'ARMADA_INGRESS_ANNOTATIONS: a must be a non-empty string',
		);
	});
});

describe('surface ports', () => {
	it('are empty unless marimohub enables a secondary surface', () => {
		expect(readConfig(baseEnv).surfacePorts).toEqual([]);
		expect(readConfig({ ...baseEnv, MARIMOHUB_SURFACES: 'marimo' }).surfacePorts).toEqual([]);
		// An id marimohub accepts but this table does not know can only come from
		// a newer marimohub, whose surface would have no port on the pod.
		expect(() => readConfig({ ...baseEnv, MARIMOHUB_SURFACES: 'vscode,jupyter' })).toThrow(
			'MARIMOHUB_SURFACES names "jupyter", a surface this adapter does not know',
		);
	});

	it("follow marimohub's surface variables and their defaults", () => {
		expect(readConfig({ ...baseEnv, MARIMOHUB_SURFACES: 'vscode' }).surfacePorts).toEqual([8443]);
		expect(
			readConfig({ ...baseEnv, MARIMOHUB_SURFACES: 'marimo, vscode,opencode' }).surfacePorts,
		).toEqual([8443, 4096]);
		expect(
			readConfig({
				...baseEnv,
				MARIMOHUB_SURFACES: 'opencode',
				MARIMOHUB_SURFACE_OPENCODE_PORT: '5000',
			}).surfacePorts,
		).toEqual([5000]);
	});

	it('reject a surface on the agent port or the kernel port', () => {
		expect(() =>
			readConfig({
				...baseEnv,
				MARIMOHUB_SURFACES: 'vscode',
				MARIMOHUB_SURFACE_VSCODE_PORT: '8718',
			}),
		).toThrow('is 8718, which is the agent port');
		expect(() =>
			readConfig({
				...baseEnv,
				MARIMOHUB_SURFACES: 'vscode',
				MARIMOHUB_SURFACE_VSCODE_PORT: '2718',
			}),
		).toThrow('is 2718, which is the kernel port');
	});

	it('reject a surface port that is not a port', () => {
		expect(() =>
			readConfig({ ...baseEnv, MARIMOHUB_SURFACES: 'vscode', MARIMOHUB_SURFACE_VSCODE_PORT: 'x' }),
		).toThrow('MARIMOHUB_SURFACE_VSCODE_PORT must be a port number');
	});
});
