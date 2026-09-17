/**
 * The podspec we submit for one kernel session.
 *
 * Armada validates submissions strictly, and the rules that shape this file are
 * documented in ARMADA-REVIEW.md with citations. The ones that bite:
 *
 * - Resource requests must equal limits, and every container must set both,
 *   init containers included. A server may insist an init container's CPU is
 *   fractional, so the agent's is `100m` and never `1`.
 * - A pod that does not set `activeDeadlineSeconds` inherits the server default,
 *   which ships at 72 hours. A kernel must never inherit that.
 * - The grace period must sit inside the server's bounds, 1s to 5m by default.
 * - A port is only exposable through a service or ingress if the container
 *   declares it as a `containerPort`.
 *
 * The container does not run marimo. marimohub starts the kernel itself through
 * `startProcess` once the sandbox is reachable. What the container runs as
 * PID 1 is the agent (`agent/`): it keeps the container alive, runs the
 * commands marimohub sends on a second port, and reaps what the kernel leaves
 * behind. An init container copies it from its own image into a volume, so the
 * operator's kernel image is used unchanged.
 */
import type { V1PodSpec } from '@kubernetes/client-node';
import type { ArmadaConfig } from './config.js';
import type { ComputeResources, CreateSandboxOptions } from './types.js';

/** Name of the kernel container in the pod. Also the prefix of its service port. */
export const KERNEL_CONTAINER = 'kernel';

/** Where the kernel container finds the agent: a volume the init container fills. */
export const AGENT_DIR = '/mh-agent';
export const AGENT_PATH = `${AGENT_DIR}/agent`;
const AGENT_VOLUME = 'mh-agent';

/** The agent reads the hex SHA-256 of its bearer token from this variable. */
export const AGENT_TOKEN_HASH_ENV = 'MH_AGENT_TOKEN_SHA256';

/** What the pod spec carries for the agent: never the token, only its hash. */
export interface AgentSpec {
	tokenSha256: string;
}

const DEFAULT_CPU = '1';
const DEFAULT_MEMORY = '2Gi';

/** Long enough for marimo to shut down cleanly, inside Armada's default 5m cap. */
const TERMINATION_GRACE_SECONDS = 30;

/** Copying one small binary needs next to nothing, but Armada insists it be stated. */
const AGENT_INSTALL_RESOURCES: Record<string, string> = { cpu: '100m', memory: '64Mi' };

function quantities(resources: ComputeResources | undefined): Record<string, string> {
	const requested: Record<string, string> = {
		cpu: resources?.cpu === undefined ? DEFAULT_CPU : String(resources.cpu),
		memory: resources?.memoryBytes === undefined ? DEFAULT_MEMORY : String(resources.memoryBytes),
	};

	if (resources?.gpu !== undefined && resources.gpu !== '') {
		// `A100:2` means two of that type. Armada schedules the count as an ordinary
		// resource; the type would need a cluster-specific node label, so it is not
		// mapped yet.
		const [, count = '1'] = resources.gpu.split(':');
		requested['nvidia.com/gpu'] = count;
	}

	return requested;
}

export function buildPodSpec(
	config: ArmadaConfig,
	agent: AgentSpec,
	options?: CreateSandboxOptions,
): V1PodSpec {
	const resources: Record<string, string> = quantities(options?.resources);

	return {
		restartPolicy: 'Never',
		terminationGracePeriodSeconds: TERMINATION_GRACE_SECONDS,
		activeDeadlineSeconds: config.maxLifetimeSeconds,
		...(config.priorityClassName === undefined
			? {}
			: { priorityClassName: config.priorityClassName }),
		volumes: [{ name: AGENT_VOLUME, emptyDir: {} }],
		initContainers: [
			{
				name: 'agent-install',
				image: config.agentImage,
				// The agent copies itself, so its image holds nothing but the agent.
				command: ['/agent', 'install', AGENT_PATH],
				resources: { requests: AGENT_INSTALL_RESOURCES, limits: AGENT_INSTALL_RESOURCES },
				volumeMounts: [{ name: AGENT_VOLUME, mountPath: AGENT_DIR }],
			},
		],
		containers: [
			{
				name: KERNEL_CONTAINER,
				image: options?.image ?? config.image,
				// The agent is PID 1: it idles until marimohub sends a command,
				// and it reaps what a detached kernel leaves behind.
				command: [AGENT_PATH, '--port', String(config.agentPort)],
				env: [{ name: AGENT_TOKEN_HASH_ENV, value: agent.tokenSha256 }],
				// The kernel, the agent, then each surface marimohub may start
				// (`config.surfacePorts`): all of them earn an address this way.
				ports: [config.port, config.agentPort, ...config.surfacePorts].map(
					(port: number): { containerPort: number; protocol: string } => ({
						containerPort: port,
						protocol: 'TCP',
					}),
				),
				resources: { requests: resources, limits: resources },
				volumeMounts: [{ name: AGENT_VOLUME, mountPath: AGENT_DIR }],
			},
		],
	};
}

/**
 * Every port the pod declares, which is every port the job's service exposes.
 *
 * Armada only exposes a port the pod declares as a `containerPort`, and the
 * address event carries one entry per exposed port. So declaring a port here is
 * what earns it an address in that event: the kernel's, and the agent's.
 */
export function exposedPorts(spec: V1PodSpec): number[] {
	const ports: number[] = [];
	for (const container of spec.containers) {
		for (const port of container.ports ?? []) ports.push(port.containerPort);
	}
	return ports;
}
