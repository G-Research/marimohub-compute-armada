/**
 * The podspec we submit for one kernel session.
 *
 * Armada validates submissions strictly, and the rules that shape this file are
 * documented in ARMADA-REVIEW.md with citations. The ones that bite:
 *
 * - Resource requests must equal limits, and every container must set both.
 * - A pod that does not set `activeDeadlineSeconds` inherits the server default,
 *   which ships at 72 hours. A kernel must never inherit that.
 * - The grace period must sit inside the server's bounds, 1s to 5m by default.
 * - A port is only exposable through a service or ingress if the container
 *   declares it as a `containerPort`.
 *
 * The container does not run marimo. marimohub starts the kernel itself through
 * `startProcess` once the sandbox is reachable, so the container's job is to stay
 * alive and do nothing until then.
 */
import type { V1PodSpec } from '@kubernetes/client-node';
import type { ArmadaConfig } from './config.js';
import type { ComputeResources, CreateSandboxOptions } from './types.js';

/** Name of the one container in the pod. Also the prefix of its service port. */
export const KERNEL_CONTAINER = 'kernel';

const DEFAULT_CPU = '1';
const DEFAULT_MEMORY = '2Gi';

/** Long enough for marimo to shut down cleanly, inside Armada's default 5m cap. */
const TERMINATION_GRACE_SECONDS = 30;

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

export function buildPodSpec(config: ArmadaConfig, options?: CreateSandboxOptions): V1PodSpec {
	const resources: Record<string, string> = quantities(options?.resources);

	return {
		restartPolicy: 'Never',
		terminationGracePeriodSeconds: TERMINATION_GRACE_SECONDS,
		activeDeadlineSeconds: config.maxLifetimeSeconds,
		...(config.priorityClassName === undefined
			? {}
			: { priorityClassName: config.priorityClassName }),
		containers: [
			{
				name: KERNEL_CONTAINER,
				image: options?.image ?? config.image,
				// marimohub launches the kernel over exec, so idle until it does.
				command: ['sleep', 'infinity'],
				ports: [{ containerPort: config.port, protocol: 'TCP' }],
				resources: { requests: resources, limits: resources },
			},
		],
	};
}
