/**
 * Placement half of the adapter: submit a job, follow its event stream, and
 * resolve where it landed.
 *
 * There is no official JS/TS Armada client (Go, Java, Scala, Python and .NET
 * only), so this talks to the grpc-gateway REST endpoints. The protos carry
 * `google.api.http` annotations, so every RPC has an HTTP form.
 */
import { authorizationHeader } from './auth.js';
import type { ArmadaConfig } from './config.js';

/** Where a running job's pod lives, from `JobRunningEvent`. */
export interface PodLocation {
	clusterId: string;
	podName: string;
	podNamespace: string;
	nodeName?: string;
}

export interface SubmittedJob {
	jobId: string;
	jobSetId: string;
}

export class ArmadaClient {
	constructor(private readonly config: ArmadaConfig) {}

	/**
	 * Headers for every call to the gateway.
	 *
	 * Authorization is resolved per request rather than at construction, so a
	 * token file that is rotated under us is picked up without a restart.
	 */
	async requestHeaders(): Promise<Record<string, string>> {
		const authorization: string | undefined = await authorizationHeader(this.config.auth);
		return {
			'content-type': 'application/json',
			...(authorization === undefined ? {} : { authorization }),
		};
	}

	/**
	 * Submit one job: podspec + ingress config, keyed by `clientId` so a resubmit
	 * for the same sandbox id dedupes rather than starting a second kernel.
	 */
	async submit(_clientId: string, _options: { image: string }): Promise<SubmittedJob> {
		throw new Error('ArmadaClient.submit is not implemented');
	}

	/** Block until the job reaches Running, returning where its pod landed. */
	async waitForRunning(_job: SubmittedJob): Promise<PodLocation> {
		throw new Error('ArmadaClient.waitForRunning is not implemented');
	}

	/**
	 * Ingress address Armada assigned for a port, from `JobIngressInfoEvent`
	 * (`ingress_addresses` maps port to address).
	 */
	async ingressAddress(_job: SubmittedJob, _port: number): Promise<string> {
		throw new Error('ArmadaClient.ingressAddress is not implemented');
	}

	async cancel(_job: SubmittedJob): Promise<void> {
		throw new Error('ArmadaClient.cancel is not implemented');
	}

	/** Jobs this deployment owns, for the reconciler. */
	async listActive(): Promise<SubmittedJob[]> {
		throw new Error('ArmadaClient.listActive is not implemented');
	}
}
