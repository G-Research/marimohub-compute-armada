import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import type { V1Container, V1PodSpec } from '@kubernetes/client-node';
import { readConfig } from '../src/config.js';
import type { ArmadaConfig } from '../src/config.js';
import { AGENT_DIR, AGENT_TOKEN_HASH_ENV, AGENT_VOLUME, buildPodSpec } from '../src/podspec.js';
import type { AgentSpec } from '../src/podspec.js';

const baseEnv: Record<string, string> = {
	ARMADA_URL: 'http://armada.example.com',
	ARMADA_QUEUE: 'marimohub',
	MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
	ARMADA_AGENT_IMAGE: 'ghcr.io/example/kernel-agent:1',
	ARMADA_AGENT_TOKEN_SECRET: 'test-secret-of-at-least-32-characters',
};
const agent: AgentSpec = { tokenSha256: 'ab'.repeat(32) };

function templateFile(contents: string): string {
	const path: string = join(mkdtempSync(join(tmpdir(), 'armada-pod-template-')), 'kernel-pod.yaml');
	writeFileSync(path, contents);
	return path;
}

function configWith(contents: string): ArmadaConfig {
	return readConfig({ ...baseEnv, ARMADA_POD_TEMPLATE_FILE: templateFile(contents) });
}

function specWith(contents: string): V1PodSpec {
	return buildPodSpec(configWith(contents), agent);
}

function kernel(spec: V1PodSpec): V1Container | undefined {
	return spec.containers[0];
}

/** Shares through a CSI driver, authenticated with a Kerberos credential cache from a Secret. */
const SHARES: string = `
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: marimo
      env:
        - name: KRB5CCNAME
          value: FILE:/var/run/krb5/ccache
        - name: KRB5_CONFIG
          value: /etc/krb5/krb5.conf
      volumeMounts:
        - name: shares
          mountPath: /mnt/shares
          readOnly: true
          mountPropagation: HostToContainer
        - name: krb5-config
          mountPath: /etc/krb5/krb5.conf
          subPath: krb5.conf
          readOnly: true
        - name: krb5-ccache
          mountPath: /var/run/krb5
          readOnly: true
  volumes:
    - name: shares
      csi:
        driver: pes
        readOnly: true
        volumeAttributes:
          shares: research
        nodePublishSecretRef:
          name: kernel-krb5-ccache
    - name: krb5-config
      secret:
        secretName: kernel-krb5-config
        defaultMode: 0444
    - name: krb5-ccache
      secret:
        secretName: kernel-krb5-ccache
`;

describe('ARMADA_POD_TEMPLATE_FILE', () => {
	it('leaves the pod exactly as it was when unset', () => {
		const spec: V1PodSpec = buildPodSpec(readConfig(baseEnv), agent);
		expect(Object.keys(spec)).not.toContain('serviceAccountName');
		expect(Object.keys(spec)).not.toContain('automountServiceAccountToken');
		expect(Object.keys(spec)).not.toContain('enableServiceLinks');
		expect(spec.volumes).toEqual([{ name: AGENT_VOLUME, emptyDir: {} }]);
		expect(kernel(spec)?.env).toEqual([{ name: AGENT_TOKEN_HASH_ENV, value: agent.tokenSha256 }]);
		expect(Object.keys(kernel(spec) ?? {})).not.toContain('envFrom');
		expect(kernel(spec)?.volumeMounts).toEqual([{ name: AGENT_VOLUME, mountPath: AGENT_DIR }]);
	});

	it('adds volumes, mounts and environment after the adapter own entries', () => {
		const spec: V1PodSpec = specWith(SHARES);

		expect(spec.volumes?.map((volume: { name: string }) => volume.name)).toEqual([
			AGENT_VOLUME,
			'shares',
			'krb5-config',
			'krb5-ccache',
		]);
		expect(spec.volumes?.[1]).toEqual({
			name: 'shares',
			csi: {
				driver: 'pes',
				readOnly: true,
				volumeAttributes: { shares: 'research' },
				nodePublishSecretRef: { name: 'kernel-krb5-ccache' },
			},
		});
		// YAML 1.1, as Kubernetes manifests are written: 0444 is octal.
		expect(spec.volumes?.[2]?.secret?.defaultMode).toBe(0o444);

		expect(kernel(spec)?.volumeMounts).toEqual([
			{ name: AGENT_VOLUME, mountPath: AGENT_DIR },
			{
				name: 'shares',
				mountPath: '/mnt/shares',
				readOnly: true,
				mountPropagation: 'HostToContainer',
			},
			{
				name: 'krb5-config',
				mountPath: '/etc/krb5/krb5.conf',
				subPath: 'krb5.conf',
				readOnly: true,
			},
			{ name: 'krb5-ccache', mountPath: '/var/run/krb5', readOnly: true },
		]);
		expect(kernel(spec)?.env).toEqual([
			{ name: AGENT_TOKEN_HASH_ENV, value: agent.tokenSha256 },
			{ name: 'KRB5CCNAME', value: 'FILE:/var/run/krb5/ccache' },
			{ name: 'KRB5_CONFIG', value: '/etc/krb5/krb5.conf' },
		]);
	});

	it('leaves the agent install alone', () => {
		const plain: V1PodSpec = buildPodSpec(readConfig(baseEnv), agent);
		const spec: V1PodSpec = specWith(SHARES);
		expect(spec.initContainers).toEqual(plain.initContainers ?? []);
		expect(kernel(spec)?.command).toEqual(kernel(plain)?.command ?? []);
		expect(kernel(spec)?.ports).toEqual(kernel(plain)?.ports ?? []);
		expect(kernel(spec)?.resources).toEqual(kernel(plain)?.resources ?? {});
	});

	it('turns the service account token off and names the service account', () => {
		const spec: V1PodSpec = specWith(`
spec:
  serviceAccountName: marimohub-kernel
  automountServiceAccountToken: false
  enableServiceLinks: false
`);
		expect(spec.serviceAccountName).toBe('marimohub-kernel');
		expect(spec.automountServiceAccountToken).toBe(false);
		expect(spec.enableServiceLinks).toBe(false);
		// A template that names no container leaves the kernel container as it was.
		expect(kernel(spec)?.env).toEqual([{ name: AGENT_TOKEN_HASH_ENV, value: agent.tokenSha256 }]);
	});

	it('takes environment from Secrets and ConfigMaps by reference', () => {
		const spec: V1PodSpec = specWith(
			JSON.stringify({
				spec: {
					containers: [
						{
							name: 'kernel',
							env: [
								{
									name: 'SHARE_USER',
									valueFrom: { secretKeyRef: { name: 'kernel-identity', key: 'user' } },
								},
								{ name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
							],
							envFrom: [{ configMapRef: { name: 'kernel-settings' }, prefix: 'KERNEL_' }],
						},
					],
				},
			}),
		);
		expect(kernel(spec)?.env?.slice(1)).toEqual([
			{ name: 'SHARE_USER', valueFrom: { secretKeyRef: { name: 'kernel-identity', key: 'user' } } },
			{ name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
		]);
		// A Secret behind envFrom may hold any key, MH_AGENT_TOKEN_SHA256 too; Kubernetes
		// gives env precedence over envFrom, so the hash has to stay in env.
		expect(kernel(spec)?.env?.[0]).toEqual({
			name: AGENT_TOKEN_HASH_ENV,
			value: agent.tokenSha256,
		});
		expect(kernel(spec)?.envFrom).toEqual([
			{ prefix: 'KERNEL_', configMapRef: { name: 'kernel-settings' } },
		]);
	});

	describe('refuses at startup, naming the setting and the field', () => {
		const cases: [string, string, string][] = [
			[
				'the agent volume name',
				'spec: {volumes: [{name: mh-agent, emptyDir: {}}]}',
				'spec.volumes[0].name',
			],
			[
				'a mount of the agent volume',
				'spec: {containers: [{name: kernel, volumeMounts: [{name: mh-agent, mountPath: /x}]}]}',
				'spec.containers[0].volumeMounts[0].name',
			],
			[
				'a mount over the agent directory',
				'spec: {volumes: [{name: a, emptyDir: {}}], containers: [{name: kernel, volumeMounts: [{name: a, mountPath: /mh-agent/}]}]}',
				'spec.containers[0].volumeMounts[0].mountPath',
			],
			[
				'a mount inside the agent directory',
				'spec: {volumes: [{name: a, emptyDir: {}}], containers: [{name: kernel, volumeMounts: [{name: a, mountPath: /mh-agent/bin}]}]}',
				'spec.containers[0].volumeMounts[0].mountPath',
			],
			...['/tmp/../mh-agent', '/./mh-agent', '//mh-agent', '/', '//', '/tmp/..'].map(
				(path: string): [string, string, string] => [
					`a mount at ${path}, which is or covers the agent directory`,
					`spec: {volumes: [{name: a, emptyDir: {}}], containers: [{name: kernel, volumeMounts: [{name: a, mountPath: "${path}"}]}]}`,
					'spec.containers[0].volumeMounts[0].mountPath',
				],
			),
			[
				'the agent token variable',
				'spec: {containers: [{name: kernel, env: [{name: MH_AGENT_TOKEN_SHA256, value: x}]}]}',
				'spec.containers[0].env[0].name',
			],
			[
				'the kernel image',
				'spec: {containers: [{name: kernel, image: x}]}',
				'spec.containers[0].image',
			],
			[
				'the kernel command',
				'spec: {containers: [{name: kernel, command: [sh]}]}',
				'spec.containers[0].command',
			],
			[
				'the kernel ports',
				'spec: {containers: [{name: kernel, ports: [{containerPort: 1}]}]}',
				'spec.containers[0].ports',
			],
			[
				'the kernel resources',
				'spec: {containers: [{name: kernel, resources: {}}]}',
				'spec.containers[0].resources',
			],
			['an init container', 'spec: {initContainers: []}', 'spec.initContainers'],
			['the restart policy', 'spec: {restartPolicy: Never}', 'spec.restartPolicy'],
			['the deadline', 'spec: {activeDeadlineSeconds: 1}', 'spec.activeDeadlineSeconds'],
			[
				'a second container',
				'spec: {containers: [{name: kernel}, {name: kernel}]}',
				'spec.containers',
			],
			['another container', 'spec: {containers: [{name: sidecar}]}', 'spec.containers[0].name'],
			[
				'a mount of a volume the template does not define',
				'spec: {containers: [{name: kernel, volumeMounts: [{name: nope, mountPath: /x}]}]}',
				'spec.containers[0].volumeMounts[0].name',
			],
			[
				'a relative mount path',
				'spec: {volumes: [{name: a, emptyDir: {}}], containers: [{name: kernel, volumeMounts: [{name: a, mountPath: x}]}]}',
				'spec.containers[0].volumeMounts[0].mountPath',
			],
			[
				'two mounts at one path',
				'spec: {volumes: [{name: a, emptyDir: {}}], containers: [{name: kernel, volumeMounts: [{name: a, mountPath: /x}, {name: a, mountPath: /x/}]}]}',
				'spec.containers[0].volumeMounts',
			],
			[
				'two mounts at paths that resolve to one place',
				'spec: {volumes: [{name: a, emptyDir: {}}], containers: [{name: kernel, volumeMounts: [{name: a, mountPath: /x}, {name: a, mountPath: //y/../x}]}]}',
				'spec.containers[0].volumeMounts[0] and spec.containers[0].volumeMounts[1] have the same mount target: /x',
			],
			[
				'an unknown mount propagation',
				'spec: {volumes: [{name: a, emptyDir: {}}], containers: [{name: kernel, volumeMounts: [{name: a, mountPath: /x, mountPropagation: Sideways}]}]}',
				'spec.containers[0].volumeMounts[0].mountPropagation',
			],
			[
				'two volumes with one name',
				'spec: {volumes: [{name: a, emptyDir: {}}, {name: a, emptyDir: {}}]}',
				'spec.volumes',
			],
			['a volume without a source', 'spec: {volumes: [{name: a}]}', 'spec.volumes[0]'],
			[
				'a volume with two sources',
				'spec: {volumes: [{name: a, emptyDir: {}, secret: {secretName: s}}]}',
				'spec.volumes[0]',
			],
			[
				'two variables with one name',
				'spec: {containers: [{name: kernel, env: [{name: A, value: x}, {name: A, value: y}]}]}',
				'spec.containers[0].env',
			],
			[
				'an unquoted number as a value',
				'spec: {containers: [{name: kernel, env: [{name: A, value: 1}]}]}',
				'spec.containers[0].env[0].value',
			],
			[
				'a non-boolean token switch',
				'spec: {automountServiceAccountToken: "no"}',
				'spec.automountServiceAccountToken',
			],
			[
				'an invalid service account',
				'spec: {serviceAccountName: Not_Valid}',
				'spec.serviceAccountName',
			],
			['the deprecated service account alias', 'spec: {serviceAccount: x}', 'spec.serviceAccount'],
			['pod metadata', 'metadata: {labels: {a: b}}', 'ARMADA_POD_LABELS'],
			['pull secrets', 'spec: {imagePullSecrets: [{name: x}]}', 'ARMADA_IMAGE_PULL_SECRETS'],
			['a security context', 'spec: {securityContext: {runAsUser: 1}}', 'ARMADA_RUN_AS_USER'],
			['a node selector', 'spec: {nodeSelector: {a: b}}', 'ARMADA_GPU_NODE_SELECTORS'],
			['a field the adapter does not support', 'spec: {hostNetwork: true}', 'spec.hostNetwork'],
			['another kind', 'kind: Deployment', 'kind'],
			['a list at the top', '- a', '<root>'],
		];
		for (const [what, template, mention] of cases) {
			it(what, () => {
				expect(() => configWith(template)).toThrow('ARMADA_POD_TEMPLATE_FILE');
				expect(() => configWith(template)).toThrow(mention);
			});
		}
	});

	it('names the field and never the value it holds', () => {
		const secret: string = 'hunter2-do-not-print';
		let message: string = '';
		try {
			configWith(
				JSON.stringify({
					spec: {
						containers: [
							{
								name: 'kernel',
								env: [
									{
										name: 'TOKEN',
										value: secret,
										valueFrom: { secretKeyRef: { name: 's', key: 'k' } },
									},
								],
							},
						],
					},
				}),
			);
		} catch (error: unknown) {
			message = String(error);
		}
		expect(message).toContain('spec.containers[0].env[0]');
		expect(message).not.toContain(secret);
	});

	it('refuses a file that is not one valid document, by line', () => {
		expect(() => configWith('spec: [unclosed')).toThrow('one valid YAML or JSON document');
		expect(() => configWith('spec:\n  volumes: []\n  volumes: []\n')).toThrow(
			'DUPLICATE_KEY at line 3',
		);
		// An unclosed quote is placed at the end of the input, wherever it opened.
		expect(() =>
			configWith(
				'spec:\n  containers:\n    - name: kernel\n      env: [{name: A, value: "x}]\n  volumes: []\n  serviceAccountName: x\n',
			),
		).toThrow('MISSING_CHAR at the end of the file');
	});

	it('never quotes the file in a syntax error', () => {
		// A bad escape is the case the parser's own message copies from the value.
		for (const value of ['"hunter2', '"hu\\xZZnter2"', '"hu\\uq7k9nter2"']) {
			let message: string = '';
			try {
				configWith(
					`spec:\n  containers:\n    - name: kernel\n      env: [{name: A, value: ${value}}]\n`,
				);
			} catch (error: unknown) {
				message = String(error);
			}
			expect(message).toContain('one valid YAML or JSON document');
			for (const fragment of ['hu', 'nter2', 'xZZ', 'q7k9']) {
				expect(message).not.toContain(fragment);
			}
		}
	});

	it('keeps a date-like value the string it was written as', () => {
		const spec: V1PodSpec = specWith(`
spec:
  volumes:
    - name: dated
      secret:
        secretName: 2024-01-01
`);
		expect(spec.volumes?.[1]?.secret?.secretName).toBe('2024-01-01');
	});

	it('refuses a file it cannot read', () => {
		expect(() =>
			readConfig({ ...baseEnv, ARMADA_POD_TEMPLATE_FILE: '/nonexistent/kernel-pod.yaml' }),
		).toThrow('ARMADA_POD_TEMPLATE_FILE cannot be read');
	});

	it('refuses an empty setting rather than silently submitting without the template', () => {
		expect(() => readConfig({ ...baseEnv, ARMADA_POD_TEMPLATE_FILE: ' ' })).toThrow(
			'ARMADA_POD_TEMPLATE_FILE is empty',
		);
	});
});
