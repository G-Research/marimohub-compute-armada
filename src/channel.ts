/**
 * Control channel: the agent inside the kernel container.
 *
 * Armada exposes no exec, so the container runs a small agent as PID 1
 * (`agent/`, designed in `AGENT-DESIGN.md`) that listens on a second port next
 * to marimo's. The job asks Armada to expose both ports and the address event
 * reports both, so this is the one place the adapter reaches into a pod, and it
 * does so with an address Armada handed it and a token minted for that one pod.
 * No Kubernetes credential is involved.
 *
 * One request type, `POST /exec`, streams the command's output as NDJSON:
 * `{"pid"}`, then `{"stdout"}` and `{"stderr"}` chunks as base64, then
 * `{"exit","timedOut"}`. Closing the request kills the command's process group
 * in the pod, which is what makes a cancel or a timeout mean something.
 */
import type { PodLocation } from './armada.js';
import { readNdjson } from './ndjson.js';

export interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface RunOptions {
	/** Piped to the process when given. */
	stdin?: string | Uint8Array;
	/** Deadline the agent enforces by killing the process group; the call rejects. */
	timeoutMs?: number;
	/**
	 * Called when the timeout fires, before this rejects. The agent has killed
	 * the command's group by then; this is for whatever the caller detached from
	 * it, and for the caller's own records.
	 */
	onStop?: () => Promise<void>;
}

export interface StreamOptions {
	/** Ends the stream rather than failing it: it bounds a `tail -f`. */
	timeoutMs?: number;
	/** Called when we stop listening on purpose, through a cancel or the timeout. */
	onStop?: () => Promise<void>;
	/** Called once the command is over, however it ended. */
	onFinished?: () => void;
}

/** What a sandbox needs of its pod: run a command, stream one, know it answers. */
export interface ControlChannel {
	/** Resolves once the pod answers, or rejects with the last reason it did not. */
	ready(timeoutMs: number): Promise<void>;
	run(command: readonly string[], options?: RunOptions): Promise<CommandResult>;
	stream(command: readonly string[], options?: StreamOptions): Promise<ReadableStream<Uint8Array>>;
}

/** Where one pod's agent is, and what it will accept. */
export interface AgentEndpoint {
	/** As Armada reported it: `host:port` for a NodePort, a hostname for an ingress. */
	address: string;
	token: string;
	pod: PodLocation;
}

/** One line of the agent's response. */
interface AgentEvent {
	pid?: number;
	stdout?: string;
	stderr?: string;
	exit?: number;
	timedOut?: boolean;
	error?: string;
}

const READY_POLL_MS = 250;
/** Past the agent's own deadline, the client gives up on its own. */
const TIMEOUT_SLACK_MS = 10_000;

function asEvent(value: unknown): AgentEvent {
	if (typeof value !== 'object' || value === null) {
		throw new Error(`the agent sent something that is not an event: ${JSON.stringify(value)}`);
	}
	// Every field is optional, so any object is an event; each field is checked where it is read.
	return value;
}

function describe(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** The agent's own message from an error response, or the body as it came. */
function errorIn(text: string): string {
	try {
		const parsed: unknown = JSON.parse(text);
		const message: unknown =
			typeof parsed === 'object' && parsed !== null && 'error' in parsed ? parsed.error : undefined;
		if (typeof message === 'string') return message;
	} catch {
		// Not JSON; the text itself is the message.
	}
	return text.trim();
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve: (value: void) => void) => setTimeout(resolve, ms));
}

export class AgentChannel implements ControlChannel {
	private readonly base: string;
	private readonly where: string;

	constructor(private readonly endpoint: AgentEndpoint) {
		this.base = endpoint.address.includes('://') ? endpoint.address : `http://${endpoint.address}`;
		this.where = `${endpoint.pod.podNamespace}/${endpoint.pod.podName}`;
	}

	/**
	 * The agent is up the instant the pod runs; what takes a moment is the route
	 * to it. A wrong agent image, or one built for the wrong architecture, shows
	 * up here as a pod that runs but never answers.
	 */
	async ready(timeoutMs: number): Promise<void> {
		const deadline: number = Date.now() + timeoutMs;
		let last = 'no answer';
		// oxlint-disable no-await-in-loop -- a poll: each probe waits on the last
		for (;;) {
			try {
				const response: Response = await fetch(`${this.base}/healthz`, {
					signal: AbortSignal.timeout(READY_POLL_MS * 4),
				});
				if (response.ok) return;
				last = `HTTP ${String(response.status)}`;
			} catch (cause) {
				last = describe(cause);
			}
			if (Date.now() >= deadline) break;
			await sleep(READY_POLL_MS);
		}
		// oxlint-enable no-await-in-loop
		throw new Error(
			`The agent in ${this.where} at ${this.base} did not answer within ${String(timeoutMs)}ms: ${last}`,
		);
	}

	async run(command: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
		const controller: AbortController = new AbortController();
		const guard: ReturnType<typeof setTimeout> | undefined =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => controller.abort(), options.timeoutMs + TIMEOUT_SLACK_MS);
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let exit: AgentEvent | undefined;
		try {
			const response: Response = await this.post(
				{
					cmd: [...command],
					...(options.stdin === undefined
						? {}
						: { stdin: Buffer.from(options.stdin).toString('base64') }),
					...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
				},
				controller.signal,
			);
			for await (const value of readNdjson(bodyOf(response))) {
				const event: AgentEvent = asEvent(value);
				if (event.stdout !== undefined) out.push(Buffer.from(event.stdout, 'base64'));
				if (event.stderr !== undefined) err.push(Buffer.from(event.stderr, 'base64'));
				if (event.error !== undefined) throw new Error(event.error);
				if (event.exit !== undefined) exit = event;
			}
		} catch (cause) {
			throw this.failure(command, cause);
		} finally {
			clearTimeout(guard);
		}
		if (exit?.exit === undefined) {
			throw this.failure(command, new Error('the response ended without an exit status'));
		}
		if (exit.timedOut === true) {
			// Best effort and not awaited: the caller is already being told.
			options.onStop?.().catch(() => {});
			throw new Error(
				`Command timed out after ${String(options.timeoutMs)}ms in ${this.where}: ${command.join(' ')}`,
			);
		}
		return {
			stdout: Buffer.concat(out).toString('utf8'),
			stderr: Buffer.concat(err).toString('utf8'),
			exitCode: exit.exit,
		};
	}

	/**
	 * Run a command and hand back its stdout as it arrives.
	 *
	 * stdout only, as marimohub's local backend does: the stream carries no
	 * framing, so interleaving stderr would corrupt output the caller parses.
	 * The exit code is unreachable through a `ReadableStream`, so a command that
	 * fails is a stream that ends. Cancelling the stream closes the request, and
	 * the agent kills the command's process group when it sees that.
	 */
	async stream(
		command: readonly string[],
		options: StreamOptions = {},
	): Promise<ReadableStream<Uint8Array>> {
		const controller: AbortController = new AbortController();
		let response: Response;
		try {
			response = await this.post({ cmd: [...command] }, controller.signal);
		} catch (cause) {
			throw this.failure(command, cause);
		}
		const events: AsyncGenerator = readNdjson(bodyOf(response));
		const failure: (cause: unknown) => Error = (cause: unknown): Error =>
			this.failure(command, cause);

		let finished = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish: () => void = (): void => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			options.onFinished?.();
		};
		const stop: () => void = (): void => {
			finish();
			controller.abort();
			options.onStop?.().catch(() => {});
		};
		// The timeout truncates the output rather than discarding it: the abort
		// makes the next read end the stream where the output stopped.
		timer = options.timeoutMs === undefined ? undefined : setTimeout(stop, options.timeoutMs);

		return new ReadableStream<Uint8Array>({
			async pull(output: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
				// oxlint-disable no-await-in-loop -- lines that carry no stdout are skipped in place
				for (;;) {
					let next: IteratorResult<unknown>;
					try {
						next = await events.next();
					} catch (cause) {
						if (!controller.signal.aborted) {
							finish();
							output.error(failure(cause));
							return;
						}
						// The abort was ours, so this is an ending, not a failure.
						next = { done: true, value: undefined };
					}
					if (next.done) {
						finish();
						closeQuietly(output);
						return;
					}
					const event: AgentEvent = asEvent(next.value);
					if (event.error !== undefined) {
						finish();
						output.error(failure(new Error(event.error)));
						return;
					}
					if (event.stdout !== undefined) {
						output.enqueue(new Uint8Array(Buffer.from(event.stdout, 'base64')));
						return;
					}
				}
				// oxlint-enable no-await-in-loop
			},
			cancel(): void {
				stop();
			},
		});
	}

	private async post(body: object, signal: AbortSignal): Promise<Response> {
		const response: Response = await fetch(`${this.base}/exec`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${this.endpoint.token}`,
			},
			body: JSON.stringify(body),
			signal,
		});
		if (!response.ok) {
			throw new Error(`HTTP ${String(response.status)}: ${errorIn(await response.text())}`);
		}
		return response;
	}

	private failure(command: readonly string[], cause: unknown): Error {
		return new Error(
			`The agent in ${this.where} could not run ${JSON.stringify(command.join(' '))}: ${describe(cause)}`,
			{ cause },
		);
	}
}

function bodyOf(response: Response): ReadableStream<Uint8Array> {
	if (response.body === null) throw new Error('the response had no body');
	return response.body;
}

/** Closing a stream that a cancel already closed throws, and means nothing. */
function closeQuietly(output: ReadableStreamDefaultController<Uint8Array>): void {
	try {
		output.close();
	} catch {
		// Already closed or cancelled.
	}
}
