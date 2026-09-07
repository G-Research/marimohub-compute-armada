import { ArmadaClient } from './armada.js';
import { AgentChannel } from './channel.js';
import type { AgentEndpoint, ControlChannel } from './channel.js';
import type { ArmadaConfig } from './config.js';
import { ArmadaSandbox } from './sandbox.js';
import { GhostSweeper } from './sweeper.js';
import type { ActiveSandbox, CreateSandboxOptions, SandboxId, SandboxProvider } from './types.js';

export class ArmadaCompute implements SandboxProvider {
	private readonly armada: ArmadaClient;
	/**
	 * One sweeper for every sandbox this provider makes, rather than a timer
	 * each: see `src/sweeper.ts`. Sandboxes join it once they have a pod and
	 * leave on destroy, so it runs only while there is something to sweep.
	 */
	private readonly sweeper: GhostSweeper;

	/**
	 * Present only when `ARMADA_LOOKOUT_URL` is configured, because marimohub
	 * treats the optional members of `SandboxProvider` as capability flags:
	 * declaring a `listActive` we cannot answer would make every reconciliation
	 * sweep fail, where its absence makes reconciliation a clean no-op.
	 */
	readonly listActive?: () => Promise<ActiveSandbox[]>;

	constructor(private readonly config: ArmadaConfig) {
		this.armada = new ArmadaClient(config);
		this.sweeper = new GhostSweeper(config.ghostSweepSeconds * 1000);
		if (config.lookoutUrl !== undefined) {
			this.listActive = async (): Promise<ActiveSandbox[]> => this.armada.listActive();
		}
	}

	create(id: SandboxId, options?: CreateSandboxOptions): ArmadaSandbox {
		return new ArmadaSandbox(id, this.config, this.armada, openAgent, options, this.sweeper);
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
