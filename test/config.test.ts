import { describe, expect, it } from 'bun:test';
import { readConfig } from '../src/config.js';
import type { ArmadaConfig } from '../src/config.js';

const baseEnv: Record<string, string> = {
	ARMADA_URL: 'http://armada.example.com',
	ARMADA_QUEUE: 'marimohub',
	MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
	ARMADA_AGENT_IMAGE: 'ghcr.io/example/kernel-agent:1',
};

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
			'ARMADA_INGRESS_ANNOTATIONS: annotation a must be a string',
		);
	});
});
