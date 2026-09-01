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
import type { V1Status } from '@kubernetes/client-node';
import type WebSocket from 'isomorphic-ws';
import type { PodLocation } from './armada.js';
import type { ClusterAccess } from './clusters.js';
import { KERNEL_CONTAINER } from './podspec.js';

export interface PodExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface PodExecOptions {
	/** Piped to the process when given. */
	stdin?: string | Uint8Array;
	/** Kills the connection rather than letting a wedged command hang a session. */
	timeoutMs?: number;
	container?: string;
}

/**
 * Kubernetes reports a non-zero exit as a `Failure` status carrying an
 * `ExitCode` cause. A failure without one is the exec itself going wrong, not
 * the command, so it becomes 1 rather than pretending to be a clean run.
 */
export function exitCodeOf(status: V1Status | undefined): number {
	if (status === undefined) return 0;
	if (status.status === 'Success') return 0;
	const cause: string | undefined = status.details?.causes?.find(
		(candidate: { reason?: string }) => candidate.reason === 'ExitCode',
	)?.message;
	const code: number = cause === undefined ? Number.NaN : Number(cause);
	return Number.isInteger(code) ? code : 1;
}

/**
 * Websocket failures arrive as an `ErrorEvent`, not an `Error`, so interpolating
 * one gives `[object ErrorEvent]` and hides what actually went wrong.
 */
export function describeFailure(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (typeof value === 'object' && value !== null) {
		if ('message' in value && typeof value.message === 'string' && value.message !== '') {
			return value.message;
		}
		if ('error' in value) return describeFailure(value.error);
		if ('type' in value && typeof value.type === 'string') return `websocket ${value.type}`;
	}
	return typeof value === 'string' ? value : (JSON.stringify(value) ?? 'unknown error');
}

function execFailure(pod: PodLocation, command: readonly string[], cause: unknown): Error {
	return new Error(
		`Exec failed in ${pod.podNamespace}/${pod.podName} on ${pod.clusterId} (${command.join(' ')}): ${describeFailure(cause)}`,
		{ cause },
	);
}

export class PodExec {
	constructor(private readonly clusters: ClusterAccess) {}

	/**
	 * Run a command in a located pod.
	 *
	 * The location can go stale — Armada may rerun a job, and a retry lands on a
	 * new run with the same pod name, possibly on another cluster — so callers
	 * should re-resolve from the event stream rather than caching indefinitely.
	 */
	async run(
		pod: PodLocation,
		command: readonly string[],
		options: PodExecOptions = {},
	): Promise<PodExecResult> {
		const [{ Exec }, { Readable, Writable }] = await Promise.all([
			import('@kubernetes/client-node'),
			import('node:stream'),
		]);

		const out: Buffer[] = [];
		const err: Buffer[] = [];
		const collect: (into: Buffer[]) => InstanceType<typeof Writable> = (into: Buffer[]) =>
			new Writable({
				write(chunk: Buffer, _encoding: string, done: () => void) {
					into.push(Buffer.from(chunk));
					done();
				},
			});

		const stdin: InstanceType<typeof Readable> | null =
			options.stdin === undefined ? null : Readable.from([Buffer.from(options.stdin)]);

		let status: V1Status | undefined;
		const exec: InstanceType<typeof Exec> = new Exec(await this.clusters.configFor(pod.clusterId));

		// A pod that is gone, or credentials that cannot reach it, fail here rather
		// than on the socket.
		let socket: WebSocket.WebSocket;
		try {
			socket = await exec.exec(
				pod.podNamespace,
				pod.podName,
				options.container ?? KERNEL_CONTAINER,
				[...command],
				collect(out),
				collect(err),
				stdin,
				false,
				(received: V1Status) => {
					status = received;
				},
			);
		} catch (cause) {
			throw execFailure(pod, command, cause);
		}

		await new Promise<void>((resolve: () => void, reject: (reason: Error) => void) => {
			const timer: ReturnType<typeof setTimeout> | undefined =
				options.timeoutMs === undefined
					? undefined
					: setTimeout(() => {
							socket.close();
							reject(
								new Error(
									`Command timed out after ${String(options.timeoutMs)}ms in ${pod.podNamespace}/${pod.podName}: ${command.join(' ')}`,
								),
							);
						}, options.timeoutMs);

			socket.addEventListener('close', () => {
				clearTimeout(timer);
				resolve();
			});
			socket.addEventListener('error', (event: unknown) => {
				clearTimeout(timer);
				reject(execFailure(pod, command, event));
			});
		});

		return {
			stdout: Buffer.concat(out).toString('utf8'),
			stderr: Buffer.concat(err).toString('utf8'),
			exitCode: exitCodeOf(status),
		};
	}
}
