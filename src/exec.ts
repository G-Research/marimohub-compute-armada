/**
 * Control-channel half of the adapter.
 *
 * Armada exposes no exec/attach/port-forward: its API is submit, cancel,
 * preempt, query status and read logs. But `JobRunningEvent` tells us the
 * cluster, pod and namespace, so we exec against that cluster directly through
 * the Pod exec subresource — the same mechanism marimohub's own kubernetes
 * adapter uses.
 *
 * `@kubernetes/client-node` is loaded lazily so importing this module stays cheap.
 */
import type { PodLocation } from './armada.js';

export interface PodExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export class PodExec {
	/**
	 * Run a command in a located pod. `stdin` is piped to the process when given.
	 *
	 * The location can go stale — Armada may rerun or relocate a job — so callers
	 * should re-resolve from the event stream rather than caching indefinitely.
	 */
	async run(
		_pod: PodLocation,
		_command: string[],
		_stdin?: string | Uint8Array,
	): Promise<PodExecResult> {
		throw new Error('PodExec.run is not implemented');
	}
}
