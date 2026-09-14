import { ArmadaClient } from './armada.js';
import type { ActiveJob } from './armada.js';
import { AgentChannel } from './channel.js';
import type { AgentEndpoint, ControlChannel } from './channel.js';
import type { ArmadaConfig } from './config.js';
import { QueueDirectory } from './queues.js';
import { ArmadaSandbox } from './sandbox.js';
import type { ActiveSandbox, CreateSandboxOptions, SandboxId, SandboxProvider } from './types.js';

export class ArmadaCompute implements SandboxProvider {
	private readonly armada: ArmadaClient;
	/** Which queue each sandbox is in, shared by every sandbox this provider makes. */
	private readonly queues: QueueDirectory;

	/**
	 * Present only when `ARMADA_LOOKOUT_URL` is configured, because marimohub
	 * treats the optional members of `SandboxProvider` as capability flags:
	 * declaring a `listActive` we cannot answer would make every reconciliation
	 * sweep fail, where its absence makes reconciliation a clean no-op.
	 */
	readonly listActive?: () => Promise<ActiveSandbox[]>;

	/**
	 * Every pod declares the enabled surfaces' ports next to the kernel's and
	 * Armada exposes them all, so a second port has an address exactly when a
	 * surface is configured. marimohub refuses to start a surface otherwise.
	 */
	readonly capabilities: { multiPort: boolean };

	constructor(private readonly config: ArmadaConfig) {
		this.armada = new ArmadaClient(config);
		this.capabilities = { multiPort: config.surfacePorts.length > 0 };
		// `findQueue` answers `undefined` by itself when Lookout is not configured.
		this.queues = new QueueDirectory(config, async (id: SandboxId): Promise<string | undefined> =>
			this.armada.findQueue(id),
		);
		if (config.lookoutUrl !== undefined) {
			// The reconciler destroys what this returns, addressing each sandbox by
			// id alone, so the queue each job was found in is remembered here for
			// that later `destroy` to cancel in.
			this.listActive = async (): Promise<ActiveSandbox[]> => {
				const jobs: ActiveJob[] = await this.armada.listActive();
				for (const job of jobs) this.queues.remember(job.id, job.queue);
				return jobs.map(({ queue: _queue, ...sandbox }: ActiveJob): ActiveSandbox => sandbox);
			};
		}
	}

	create(id: SandboxId, options?: CreateSandboxOptions): ArmadaSandbox {
		return new ArmadaSandbox(id, this.config, this.armada, openAgent, this.queues, options);
	}

	/** Kernels are reached directly at their Armada ingress, so nothing is proxied. */
	async proxy(_request: Request): Promise<Response | null> {
		return null;
	}
}

/** Each sandbox reaches its own pod's agent, at the address Armada reported for it. */
function openAgent(endpoint: AgentEndpoint): ControlChannel {
	return new AgentChannel(endpoint);
}
