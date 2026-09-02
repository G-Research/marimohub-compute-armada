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
	/**
	 * Called when the timeout fires, before this rejects.
	 *
	 * Closing the websocket does not stop the command (see
	 * {@link PodExecStreamOptions.onStop}), so without this a timed-out command
	 * keeps running in the pod for the rest of the session while its caller has
	 * been told it failed. Only the caller knows how to address the process, so
	 * the kill is theirs to perform.
	 */
	onStop?: () => Promise<void>;
}

export interface PodExecStreamOptions {
	/**
	 * How long to keep listening. Unlike {@link PodExecOptions.timeoutMs} this
	 * ends the stream rather than failing it: the caller has already been handed
	 * the bytes that arrived, and bounding an endless command (`tail -f`) is what
	 * the option is for.
	 */
	timeoutMs?: number;
	container?: string;
	/**
	 * Called when we stop listening on purpose, through a cancel or the timeout,
	 * but never when the command ends by itself.
	 *
	 * Closing the websocket does not stop the command. Verified against a real
	 * pod: a loop kept running after the socket closed, whether or not it was
	 * still writing to stdout. So stopping the work is arranged by the caller,
	 * which is the layer that knows how to address the process. Failures are
	 * swallowed, since the stream is already ending and there is nobody to tell.
	 */
	onStop?: () => Promise<void>;
	/**
	 * Called once the command is over, however it ended: on its own, cancelled or
	 * timed out. The caller uses it to stop counting the command as running.
	 */
	onFinished?: () => void;
}

/** The stream, plus the three things the exec's output does to it. */
export interface PodOutputStream {
	stream: ReadableStream<Uint8Array>;
	/** Enqueue a chunk; `ack` releases the producer, possibly after a read. */
	write: (chunk: Uint8Array, ack: () => void) => void;
	end: () => void;
	fail: (error: Error) => void;
}

/**
 * Bridge an exec's stdout writes into a web `ReadableStream`.
 *
 * Separate from the websocket so the awkward part, backpressure, can be tested
 * without one. A command that outpaces its reader is held rather than buffered:
 * `write` keeps the producer's `ack` until the consumer pulls, so `execStream`
 * of a large file cannot pull the whole thing into memory, which is the failure
 * that makes a "streaming" API worth no more than a buffered one.
 */
export function podOutputStream(onCancel: () => void): PodOutputStream {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	/** The held `ack` of a write that filled the queue, released by `pull`. */
	let paused: (() => void) | undefined;
	let finished = false;

	const release: () => void = () => {
		const resume: (() => void) | undefined = paused;
		paused = undefined;
		resume?.();
	};

	const stream: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
		start(active: ReadableStreamDefaultController<Uint8Array>) {
			controller = active;
		},
		pull: release,
		cancel() {
			finished = true;
			// Let the producer go before closing, or its write callback is stranded
			// and the socket never unwinds.
			release();
			onCancel();
		},
	});

	return {
		stream,
		write(chunk: Uint8Array, ack: () => void) {
			if (finished || controller === undefined) {
				ack();
				return;
			}
			controller.enqueue(chunk);
			if ((controller.desiredSize ?? 1) > 0) ack();
			else paused = ack;
		},
		end() {
			if (finished) return;
			finished = true;
			controller?.close();
		},
		fail(error: Error) {
			if (finished) return;
			finished = true;
			controller?.error(error);
		},
	};
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
							// Best effort and not awaited: the caller is already being
							// told the command timed out.
							options.onStop?.().catch(() => {});
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

	/**
	 * Run a command and hand back its stdout as it arrives.
	 *
	 * The same websocket as {@link run}, read differently: `run` collects every
	 * chunk and resolves at close, this one forwards each chunk as the command
	 * produces it. marimohub's kubernetes adapter cannot do this because its
	 * internal exec seam is request/response, so it buffers and emits once; ours
	 * is this method, so a `tail -f` behaves like one.
	 *
	 * stdout only, as marimohub's local backend does: the stream carries no
	 * framing, so interleaving stderr would corrupt output the caller parses.
	 * stderr is still drained, because an unread pipe eventually blocks the
	 * command that is writing to it. The exit code is unreachable through a
	 * `ReadableStream`, so a command that fails is a stream that ends.
	 */
	async stream(
		pod: PodLocation,
		command: readonly string[],
		options: PodExecStreamOptions = {},
	): Promise<ReadableStream<Uint8Array>> {
		const [{ Exec }, { Writable }] = await Promise.all([
			import('@kubernetes/client-node'),
			import('node:stream'),
		]);

		// Cancelling the stream stops listening and, through `onStop`, the command
		// itself; marimohub's local backend kills its process group for the same
		// reason. The handler is installed before the socket exists, so it reaches
		// it through this indirection.
		let stop: (() => void) | undefined;
		const output: PodOutputStream = podOutputStream(() => stop?.());

		const stdout: InstanceType<typeof Writable> = new Writable({
			write(chunk: Buffer, _encoding: string, ack: () => void) {
				output.write(new Uint8Array(chunk), ack);
			},
		});
		const drain: InstanceType<typeof Writable> = new Writable({
			write(_chunk: Buffer, _encoding: string, ack: () => void) {
				ack();
			},
		});

		const exec: InstanceType<typeof Exec> = new Exec(await this.clusters.configFor(pod.clusterId));
		let socket: WebSocket.WebSocket;
		try {
			socket = await exec.exec(
				pod.podNamespace,
				pod.podName,
				options.container ?? KERNEL_CONTAINER,
				[...command],
				stdout,
				drain,
				null,
				false,
			);
		} catch (cause) {
			throw execFailure(pod, command, cause);
		}
		// Closing the socket ends the stream through the `close` listener below, so
		// the timeout truncates the output rather than discarding it.
		const timer: ReturnType<typeof setTimeout> | undefined =
			options.timeoutMs === undefined ? undefined : setTimeout(() => stop?.(), options.timeoutMs);

		stop = () => {
			clearTimeout(timer);
			socket.close();
			options.onStop?.().catch(() => {});
		};

		socket.addEventListener('close', () => {
			clearTimeout(timer);
			output.end();
			options.onFinished?.();
		});
		socket.addEventListener('error', (event: unknown) => {
			clearTimeout(timer);
			output.fail(execFailure(pod, command, event));
			options.onFinished?.();
		});

		return output.stream;
	}
}
