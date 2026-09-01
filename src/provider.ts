import { ArmadaClient } from './armada.js';
import { ClusterAccess } from './clusters.js';
import type { ArmadaConfig } from './config.js';
import { PodExec } from './exec.js';
import { ArmadaSandbox } from './sandbox.js';
import type { CreateSandboxOptions, SandboxId, SandboxProvider } from './types.js';

/**
 * `listActive` is deliberately absent: marimohub treats the optional members of
 * `SandboxProvider` as capability flags, so declaring one we cannot answer is
 * worse than not having it. Add it back with the reconciler that needs it.
 */
export class ArmadaCompute implements SandboxProvider {
	private readonly armada: ArmadaClient;
	private readonly podExec: PodExec;

	constructor(private readonly config: ArmadaConfig) {
		this.armada = new ArmadaClient(config);
		this.podExec = new PodExec(new ClusterAccess(config.kubeconfigPattern));
	}

	create(id: SandboxId, options?: CreateSandboxOptions): ArmadaSandbox {
		return new ArmadaSandbox(id, this.config, this.armada, this.podExec, options);
	}

	/** Kernels are reached directly at their Armada ingress, so nothing is proxied. */
	async proxy(_request: Request): Promise<Response | null> {
		return null;
	}
}
