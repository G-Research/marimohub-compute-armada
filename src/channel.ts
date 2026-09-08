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
 * `POST /exec` runs a shell command and streams its output as NDJSON:
 * `{"pid"}`, then `{"stdout"}` and `{"stderr"}` chunks as base64, then
 * `{"exit","timedOut"}`. Closing the request kills the command's process group
 * in the pod, which is what makes a cancel or a timeout mean something.
 *
 * The rest of the surface answers what a shell answered badly. `/process/*`
 * starts a detached process as the agent's own child, so liveness and the exit
 * status are exact, and waits for its port in-pod. `/files` carries bytes raw
 * in request and response bodies, so no path is quoted for a shell and no
 * content is wrapped in base64.
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
}

export interface StreamOptions {
	/** Ends the stream rather than failing it: it bounds a `tail -f`. */
	timeoutMs?: number;
}

/** What the agent reports of a process it started. */
export interface ProcessStatus {
	running: boolean;
	/** Set once it has exited; `-1` means it died to a signal. */
	exitCode?: number;
}

/** How an in-pod port wait ended. */
export interface PortWait {
	open: boolean;
	/** The watched process exited before the port opened. */
	exited?: boolean;
	exitCode?: number;
}

export type AgentFileType = 'file' | 'directory' | 'symlink' | 'other';

/** One entry of a directory listing, as the agent walked it. */
export interface AgentFileEntry {
	path: string;
	type: AgentFileType;
	size: number;
}

/**
 * How a read ended. A channel that cannot be reached throws instead, so a
 * caller can tell "the pod said no" from "the pod said nothing".
 */
export type ReadFileOutcome =
	| { outcome: 'ok'; bytes: Uint8Array }
	| { outcome: 'not-found' }
	| { outcome: 'failed'; message: string };

/** How a listing ended, on the same terms as {@link ReadFileOutcome}. */
export type ListFilesOutcome =
	| { outcome: 'ok'; entries: AgentFileEntry[] }
	| { outcome: 'not-a-directory' }
	| { outcome: 'failed'; message: string };

/** Thrown by {@link AgentChannel.run} when the agent killed the command at its deadline. */
export class CommandTimeoutError extends Error {}

/** What a sandbox needs of its pod: commands, detached processes, and files. */
export interface ControlChannel {
	/** Resolves once the pod answers, or rejects with the last reason it did not. */
	ready(timeoutMs: number): Promise<void>;
	run(command: readonly string[], options?: RunOptions): Promise<CommandResult>;
	stream(command: readonly string[], options?: StreamOptions): Promise<ReadableStream<Uint8Array>>;
	/** Write bytes to a path, creating parent directories. */
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	readFile(path: string): Promise<ReadFileOutcome>;
	listFiles(path: string, recursive: boolean): Promise<ListFilesOutcome>;
	/** Start a detached process the agent parents, returning its pid. */
	startProcess(command: readonly string[], cwd?: string): Promise<number>;
	processStatus(pid: number): Promise<ProcessStatus>;
	/** Best effort by contract: a process that is already gone is a success. */
	signalProcess(pid: number, signal: string): Promise<void>;
	/** Everything the process printed, both streams in order. */
	processLogs(pid: number): Promise<string>;
	/** Wait in-pod until the port answers, `timeoutMs` passes, or `pid` exits. */
	waitForPort(port: number, timeoutMs: number, pid?: number): Promise<PortWait>;
}

/** Where one pod's agent is, and what it will accept. */
export interface AgentEndpoint {
	/**
	 * Where the agent answers: the address Armada reported for its port, with the
	 * scheme the exposure implies. `http://host:port` for a NodePort, `https://host`
	 * for an Ingress with TLS.
	 */
	url: string;
	token: string;
	pod: PodLocation;
}

/** One line of the agent's `/exec` response. */
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

/** A refused request, as the agent's `{error, code}` body describes it. */
interface AgentRefusal {
	code: string | undefined;
	message: string;
}

async function refusalOf(response: Response): Promise<AgentRefusal> {
	const text: string = await response.text();
	let code: string | undefined;
	let message: string = text.trim();
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === 'object' && parsed !== null) {
			if ('error' in parsed && typeof parsed.error === 'string') message = parsed.error;
			if ('code' in parsed && typeof parsed.code === 'string') code = parsed.code;
		}
	} catch {
		// Not JSON; the text itself is the message.
	}
	return { code, message: `HTTP ${String(response.status)}: ${message}` };
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve: (value: void) => void) => setTimeout(resolve, ms));
}

function pidOf(value: unknown): number | undefined {
	return typeof value === 'object' &&
		value !== null &&
		'pid' in value &&
		typeof value.pid === 'number'
		? value.pid
		: undefined;
}

function statusOf(value: unknown): ProcessStatus | undefined {
	if (
		typeof value !== 'object' ||
		value === null ||
		!('running' in value) ||
		typeof value.running !== 'boolean'
	) {
		return undefined;
	}
	const exitCode: number | undefined =
		'exitCode' in value && typeof value.exitCode === 'number' ? value.exitCode : undefined;
	return { running: value.running, ...(exitCode === undefined ? {} : { exitCode }) };
}

function portWaitOf(value: unknown): PortWait | undefined {
	if (
		typeof value !== 'object' ||
		value === null ||
		!('open' in value) ||
		typeof value.open !== 'boolean'
	) {
		return undefined;
	}
	const exited: boolean = 'exited' in value && value.exited === true;
	const exitCode: number | undefined =
		'exitCode' in value && typeof value.exitCode === 'number' ? value.exitCode : undefined;
	return {
		open: value.open,
		...(exited ? { exited } : {}),
		...(exitCode === undefined ? {} : { exitCode }),
	};
}

function isFileType(value: string): value is AgentFileType {
	return value === 'file' || value === 'directory' || value === 'symlink' || value === 'other';
}

function entryOf(value: unknown): AgentFileEntry | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	if (!('path' in value) || typeof value.path !== 'string') return undefined;
	const type: AgentFileType =
		'type' in value && typeof value.type === 'string' && isFileType(value.type)
			? value.type
			: 'other';
	const size: number = 'size' in value && typeof value.size === 'number' ? value.size : 0;
	return { path: value.path, type, size };
}

function entriesOf(value: unknown): AgentFileEntry[] | undefined {
	if (
		typeof value !== 'object' ||
		value === null ||
		!('entries' in value) ||
		!Array.isArray(value.entries)
	) {
		return undefined;
	}
	const entries: AgentFileEntry[] = [];
	for (const raw of value.entries as unknown[]) {
		const entry: AgentFileEntry | undefined = entryOf(raw);
		if (entry === undefined) return undefined;
		entries.push(entry);
	}
	return entries;
}

export class AgentChannel implements ControlChannel {
	private readonly base: string;
	private readonly where: string;

	constructor(private readonly endpoint: AgentEndpoint) {
		this.base = endpoint.url;
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
			const response: Response = await this.exec(
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
			throw this.failure(runWhat(command), cause);
		} finally {
			clearTimeout(guard);
		}
		if (exit?.exit === undefined) {
			throw this.failure(runWhat(command), new Error('the response ended without an exit status'));
		}
		if (exit.timedOut === true) {
			// The agent has killed the command's process group by now.
			throw new CommandTimeoutError(
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
	 * the agent kills the command's process group when it sees that; the
	 * timeout does the same, truncating the output rather than discarding it.
	 */
	async stream(
		command: readonly string[],
		options: StreamOptions = {},
	): Promise<ReadableStream<Uint8Array>> {
		const controller: AbortController = new AbortController();
		let response: Response;
		try {
			response = await this.exec({ cmd: [...command] }, controller.signal);
		} catch (cause) {
			throw this.failure(runWhat(command), cause);
		}
		const events: AsyncGenerator = readNdjson(bodyOf(response));
		const failure: (cause: unknown) => Error = (cause: unknown): Error =>
			this.failure(runWhat(command), cause);

		const stop: () => void = (): void => {
			controller.abort();
		};
		const timer: ReturnType<typeof setTimeout> | undefined =
			options.timeoutMs === undefined ? undefined : setTimeout(stop, options.timeoutMs);

		return new ReadableStream<Uint8Array>({
			async pull(output: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
				// oxlint-disable no-await-in-loop -- lines that carry no stdout are skipped in place
				for (;;) {
					let next: IteratorResult<unknown>;
					try {
						next = await events.next();
					} catch (cause) {
						if (!controller.signal.aborted) {
							clearTimeout(timer);
							output.error(failure(cause));
							return;
						}
						// The abort was ours, so this is an ending, not a failure.
						next = { done: true, value: undefined };
					}
					if (next.done) {
						clearTimeout(timer);
						closeQuietly(output);
						return;
					}
					const event: AgentEvent = asEvent(next.value);
					if (event.error !== undefined) {
						clearTimeout(timer);
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
				clearTimeout(timer);
				stop();
			},
		});
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const what = `write ${path}`;
		// Copied into a fresh array because `fetch` wants a view over a plain
		// ArrayBuffer, which a caller's slice of a shared one is not typed as.
		const body: string | Uint8Array<ArrayBuffer> =
			typeof content === 'string' ? content : new Uint8Array(content);
		const response: Response = await this.request(what, 'PUT', filePath('/files', path), {
			body,
		});
		if (!response.ok) {
			throw this.failure(what, new Error((await refusalOf(response)).message));
		}
	}

	async readFile(path: string): Promise<ReadFileOutcome> {
		const what = `read ${path}`;
		const response: Response = await this.request(what, 'GET', filePath('/files', path));
		if (response.ok) {
			return { outcome: 'ok', bytes: new Uint8Array(await response.arrayBuffer()) };
		}
		const refusal: AgentRefusal = await refusalOf(response);
		if (refusal.code === 'not_found') return { outcome: 'not-found' };
		if (refusal.code === 'read_failed') return { outcome: 'failed', message: refusal.message };
		throw this.failure(what, new Error(refusal.message));
	}

	async listFiles(path: string, recursive: boolean): Promise<ListFilesOutcome> {
		const what = `list ${path}`;
		const response: Response = await this.request(
			what,
			'GET',
			`${filePath('/files/list', path)}${recursive ? '&recursive=true' : ''}`,
		);
		if (!response.ok) {
			const refusal: AgentRefusal = await refusalOf(response);
			if (refusal.code === 'not_a_directory') return { outcome: 'not-a-directory' };
			if (refusal.code === 'not_found' || refusal.code === 'list_failed') {
				return { outcome: 'failed', message: refusal.message };
			}
			throw this.failure(what, new Error(refusal.message));
		}
		const entries: AgentFileEntry[] | undefined = entriesOf(await response.json());
		if (entries === undefined) {
			throw this.failure(what, new Error('the agent sent a listing with no entries'));
		}
		return { outcome: 'ok', entries };
	}

	async startProcess(command: readonly string[], cwd?: string): Promise<number> {
		const what = `start ${JSON.stringify(command.join(' '))}`;
		const response: Response = await this.request(what, 'POST', '/process/start', {
			json: { cmd: [...command], ...(cwd === undefined ? {} : { cwd }) },
		});
		if (!response.ok) {
			throw this.failure(what, new Error((await refusalOf(response)).message));
		}
		const pid: number | undefined = pidOf(await response.json());
		if (pid === undefined) {
			throw this.failure(what, new Error('the agent named no pid'));
		}
		return pid;
	}

	async processStatus(pid: number): Promise<ProcessStatus> {
		const what = `check process ${String(pid)}`;
		const response: Response = await this.request(
			what,
			'GET',
			`/process/status?pid=${String(pid)}`,
		);
		if (!response.ok) {
			throw this.failure(what, new Error((await refusalOf(response)).message));
		}
		const status: ProcessStatus | undefined = statusOf(await response.json());
		if (status === undefined) {
			throw this.failure(what, new Error('the agent sent no status'));
		}
		return status;
	}

	async signalProcess(pid: number, signal: string): Promise<void> {
		const what = `signal process ${String(pid)}`;
		const response: Response = await this.request(what, 'POST', '/process/signal', {
			json: { pid, signal },
		});
		if (!response.ok) {
			throw this.failure(what, new Error((await refusalOf(response)).message));
		}
	}

	async processLogs(pid: number): Promise<string> {
		const what = `read the log of process ${String(pid)}`;
		const response: Response = await this.request(what, 'GET', `/process/logs?pid=${String(pid)}`);
		if (!response.ok) {
			throw this.failure(what, new Error((await refusalOf(response)).message));
		}
		return response.text();
	}

	async waitForPort(port: number, timeoutMs: number, pid?: number): Promise<PortWait> {
		const what = `wait for port ${String(port)}`;
		// The agent holds the request for up to the timeout; past that plus
		// slack, the wait itself has gone missing.
		const response: Response = await this.request(what, 'POST', '/process/waitport', {
			json: { port, timeoutMs, ...(pid === undefined ? {} : { pid }) },
			signal: AbortSignal.timeout(timeoutMs + TIMEOUT_SLACK_MS),
		});
		if (!response.ok) {
			throw this.failure(what, new Error((await refusalOf(response)).message));
		}
		const wait: PortWait | undefined = portWaitOf(await response.json());
		if (wait === undefined) {
			throw this.failure(what, new Error('the agent sent no answer for the wait'));
		}
		return wait;
	}

	/** `POST /exec`, whose refusals are read before the NDJSON stream begins. */
	private async exec(body: object, signal: AbortSignal): Promise<Response> {
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
			throw new Error((await refusalOf(response)).message);
		}
		return response;
	}

	/** One request to the agent, with network failures wrapped and named. */
	private async request(
		what: string,
		method: string,
		path: string,
		options: { body?: string | Uint8Array<ArrayBuffer>; json?: object; signal?: AbortSignal } = {},
	): Promise<Response> {
		const headers: Record<string, string> = { authorization: `Bearer ${this.endpoint.token}` };
		if (options.json !== undefined) headers['content-type'] = 'application/json';
		const body: string | Uint8Array<ArrayBuffer> | undefined =
			options.json === undefined ? options.body : JSON.stringify(options.json);
		try {
			return await fetch(`${this.base}${path}`, {
				method,
				headers,
				...(body === undefined ? {} : { body }),
				...(options.signal === undefined ? {} : { signal: options.signal }),
			});
		} catch (cause) {
			throw this.failure(what, cause);
		}
	}

	private failure(what: string, cause: unknown): Error {
		return new Error(`The agent in ${this.where} could not ${what}: ${describe(cause)}`, { cause });
	}
}

function runWhat(command: readonly string[]): string {
	return `run ${JSON.stringify(command.join(' '))}`;
}

/** The path travels as a query parameter, so it needs no quoting of any kind. */
function filePath(endpoint: string, path: string): string {
	return `${endpoint}?path=${encodeURIComponent(path)}`;
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
