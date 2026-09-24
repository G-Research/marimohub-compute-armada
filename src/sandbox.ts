import { createHash, createHmac } from 'node:crypto';
import type { ArmadaClient, PodLocation, SubmittedJob } from './armada.js';
import type { ArmadaConfig } from './config.js';
import type {
	AgentEndpoint,
	AgentFileEntry,
	CommandResult,
	ControlChannel,
	ListFilesOutcome,
	PortProbe,
	PortWait,
	ReadBudget,
	ReadFileOutcome,
} from './channel.js';
import { CommandTimeoutError } from './channel.js';
import { buildPodSpec } from './podspec.js';
import type { QueueDirectory } from './queues.js';
import { assertEnvName, gitCloneCommand, withEnvPrefix } from './shell.js';
import type {
	BoundedReadOptions,
	CreateSandboxOptions,
	ExecOptions,
	ExecResult,
	ExecStreamOptions,
	ExposePortOptions,
	ExposePortResult,
	FileInfo,
	GitCheckoutOptions,
	ListFilesOptions,
	ListFilesResult,
	MountBucketOptions,
	ReadFileResult,
	SandboxFileWrite,
	SandboxId,
	SandboxInstance,
	SandboxProcess,
	SetEnvVarsOptions,
	StartProcessOptions,
	WaitForPortOptions,
} from './types.js';

/**
 * The bytes as text, or undefined when they are not valid UTF-8, which is how
 * `readFile` chooses what encoding to report. `ignoreBOM` keeps a leading BOM in
 * the string (the flag means "do not treat it specially"), so a file that has
 * one round-trips byte for byte.
 */
function decodeUtf8(bytes: Uint8Array): string | undefined {
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

/** Control characters escaped as JSON would, so a value cannot break a log line. */
function oneLine(text: string): string {
	// oxlint-disable-next-line no-control-regex -- matching control characters is the point
	return text.replace(/[\u0000-\u001f\u007f]/g, (char: string): string =>
		JSON.stringify(char).slice(1, -1),
	);
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a bounded read's budget is one marimohub's port allows
 * (`BoundedReadOptions`), checked as its reference reader checks it
 * (`packages/compute-commons/src/boundedRead.ts`): a nonnegative safe integer
 * of bytes whose base64 size is safe too, and a positive deadline a timer can
 * hold.
 */
export function isValidBudget(options: BoundedReadOptions): boolean {
	return (
		Number.isSafeInteger(options.maxBytes) &&
		options.maxBytes >= 0 &&
		Number.isSafeInteger(4 * Math.ceil(options.maxBytes / 3)) &&
		Number.isFinite(options.timeoutMs) &&
		options.timeoutMs > 0 &&
		options.timeoutMs <= 2 ** 31 - 1
	);
}

/**
 * The bearer token a sandbox's agent expects: an HMAC of the sandbox id under
 * `ARMADA_AGENT_TOKEN_SECRET`. Derived rather than minted, because marimohub
 * reaches a sandbox through a fresh `create(id)` on every path after the
 * first, teardown and the snapshot sweep included, and in another process after
 * a restart; each of them has to arrive at the token the pod was started with.
 */
export function agentToken(secret: string, id: SandboxId): string {
	return createHmac('sha256', secret).update(id).digest('hex');
}

/**
 * Where a sandbox this process has reached lives: its job, its pod, and the
 * channel to its agent. marimohub builds a new instance for every call after
 * provisioning (each snapshot, the teardown, a surface check), and without this
 * each would resubmit the job, wait for its running event and poll the agent
 * again before doing anything. The provider holds one map for all of them.
 */
export interface Placement {
	job: SubmittedJob;
	pod: PodLocation;
	channel: ControlChannel;
}

export type Placements = Map<SandboxId, Placement>;

/** Each write is one request to the agent; cap how many are in flight. */
const WRITE_CONCURRENCY = 8;

/** How long a running pod gets to answer on the agent port before `ready` gives up. */
const AGENT_READY_TIMEOUT_MS = 30_000;

/**
 * `isPortReady` is one look, not a wait: a zero timeout makes the agent probe
 * once and answer, the probe itself bounded to the 2s marimohub's local
 * adapter allows (`agent/process.go`).
 */
const PORT_READY_TIMEOUT_MS = 0;

/** A non-zero exit is the command's business; marimohub wants it as a result. */
export function toExecResult(result: CommandResult): ExecResult {
	if (result.exitCode === 0) {
		return { success: true, stdout: result.stdout, stderr: result.stderr };
	}
	return {
		success: false,
		stdout: result.stdout,
		stderr: result.stderr,
		error: { code: 'COMMAND_FAILED' },
	};
}

/**
 * The agent's listing as marimohub's `FileInfo` records.
 *
 * Hiding is done here rather than in the agent's walk, so a recursive listing
 * still descends into a dot directory and reports its non-dot children, which
 * is what upstream does and what `readSessionArtifacts` needs for `__marimo__`
 * trees: each entry is judged on its own name alone.
 */
export function toFileInfos(
	entries: readonly AgentFileEntry[],
	rootPath: string,
	options?: ListFilesOptions,
): FileInfo[] {
	const files: FileInfo[] = [];
	for (const entry of entries) {
		const name: string = entry.path.slice(entry.path.lastIndexOf('/') + 1);
		if (options?.includeHidden !== true && name.startsWith('.')) continue;
		files.push({
			name,
			absolutePath: entry.path,
			relativePath: entry.path.startsWith(rootPath)
				? entry.path.slice(rootPath.length).replace(/^\//, '')
				: entry.path,
			type: entry.type,
			size: entry.size,
		});
	}
	return files;
}

/**
 * One kernel session, backed by one Armada job.
 *
 * Resolution is lazy: `create()` is synchronous and id-addressed, so the job is
 * submitted on first use. Commands run through the agent's `/exec`; detached
 * processes and files go through its own endpoints, so nothing here builds a
 * shell command beyond the env prefix and the quoted `git clone`.
 */
export class ArmadaSandbox implements SandboxInstance {
	/** Armada cannot mount a bucket; the provisioner falls back to copying files. */
	readonly supportsBucketMount = false;

	private job?: SubmittedJob;
	private pod?: PodLocation | undefined;
	/** The agent in the pod, once `ready` has reached it. */
	private channel?: ControlChannel | undefined;
	/** The bearer token this sandbox's agent expects. The pod carries only its hash. */
	private readonly token: string;
	/** Settled by `queue()`, and fixed for the life of the sandbox once it is. */

	/**
	 * The pod's environment is fixed at submission, so `setEnvVars` accumulates
	 * here and is replayed as an `export` prefix on every later command, the way
	 * marimohub's kubernetes adapter does it. `envDefaults` holds the
	 * `onlyIfUnset` vars, exported behind a guard so any existing value wins.
	 */
	private env: Record<string, string> = {};
	private envDefaults: Record<string, string> = {};

	constructor(
		private readonly id: SandboxId,
		private readonly config: ArmadaConfig,
		private readonly armada: ArmadaClient,
		private readonly openChannel: (endpoint: AgentEndpoint) => ControlChannel,
		private readonly queues: QueueDirectory,
		private readonly placements: Placements,
		private readonly options?: CreateSandboxOptions,
	) {
		this.token = agentToken(config.agentTokenSecret, id);
	}

	/**
	 * Submit the job, block until its pod is running, and reach the agent in it.
	 *
	 * Idempotent: marimohub calls this before each use, and the submission dedupes
	 * on `clientId` anyway, so a second call on a started sandbox does nothing.
	 *
	 * The token ({@link agentToken}) never leaves this process except in request
	 * headers to the one pod that knows its hash. The pod spec, which anyone with
	 * read access to the job can fetch, carries the hash alone. A resubmit that
	 * Armada dedupes to the running job carries the same hash, since the token
	 * depends on the id alone.
	 *
	 * A sandbox another instance in this process already reached is taken from
	 * {@link Placements} after one look at the agent's health, which is what
	 * tells a live pod from one that has since gone; a gone one is resolved
	 * again from the start.
	 */
	async ready(): Promise<void> {
		if (this.channel !== undefined) return;
		const known: Placement | undefined = this.placements.get(this.id);
		if (known !== undefined) {
			try {
				await known.channel.ready(0);
				this.job = known.job;
				this.pod = known.pod;
				this.channel = known.channel;
				return;
			} catch {
				this.placements.delete(this.id);
			}
		}
		const tokenSha256: string = createHash('sha256').update(this.token).digest('hex');
		this.job ??= await this.armada.submit(
			this.id,
			buildPodSpec(this.config, { tokenSha256 }, this.options),
			await this.queue(),
		);
		this.pod = await this.armada.waitForRunning(this.job);
		// The agent's address comes from the same event as the kernel's.
		const url: string = await this.armada.portUrl(this.job, this.config.agentPort);
		const channel: ControlChannel = this.openChannel({ url, token: this.token, pod: this.pod });
		await channel.ready(AGENT_READY_TIMEOUT_MS);
		this.channel = channel;
		this.placements.set(this.id, { job: this.job, pod: this.pod, channel });
	}

	/** Where the pod landed, once it has. For reporting, not for reaching it. */
	get placement(): PodLocation | undefined {
		return this.pod;
	}

	/**
	 * The queue this sandbox's job is in, or will be submitted to: the job's own
	 * once submitted here, else what this process or Lookout knows of the
	 * sandbox, else where the owner marimohub named maps to (`src/queues.ts`).
	 */
	async queue(): Promise<string> {
		return this.job?.queue ?? this.queues.resolve(this.id, this.options?.owner);
	}

	/**
	 * One probe of a port, for marimohub's surface manager checking whether a
	 * surface it started earlier still answers. Without this it runs a
	 * `python3` one-liner in the pod; the agent answers the same question from
	 * inside without needing an interpreter. Anything but a clean answer is
	 * "not ready", as marimohub's own adapters treat it, since the caller's
	 * remedy is the same either way: start the surface again. Only the probe is
	 * treated that way: a sandbox this process has not reached cannot have a
	 * surface listening, and is not submitted or waited for to find that out.
	 * One another instance reached counts as reached, since marimohub asks
	 * through a fresh instance.
	 */
	async isPortReady(port: number, options?: Omit<WaitForPortOptions, 'timeout'>): Promise<boolean> {
		const channel: ControlChannel | undefined =
			this.channel ?? this.placements.get(this.id)?.channel;
		if (channel === undefined) return false;
		try {
			const wait: PortWait = await channel.waitForPort(
				port,
				PORT_READY_TIMEOUT_MS,
				undefined,
				probeOf({ ...options, mode: options?.mode ?? 'http' }),
			);
			return wait.open;
		} catch {
			return false;
		}
	}

	/**
	 * Everything above this method is built on the channel, so this is the one
	 * that has to be right. A command that fails is a normal result, not an
	 * exception; only the channel itself failing is a `BACKEND_ERROR`.
	 *
	 * A login shell, matching marimohub's kubernetes adapter: what arrives here is
	 * user and provisioner code, and an image that puts `uv` or `python3` on the
	 * PATH through a profile script has to keep working.
	 *
	 * The caller's timeout goes to the agent, which kills the command's process
	 * group at the deadline. A command with no timeout gets
	 * `ARMADA_COMMAND_MAX_SECONDS` instead: most of marimohub's exec calls carry
	 * none because the work legitimately takes minutes, and this is the
	 * hours-later answer to "nobody expected this to still be running", which
	 * would otherwise hold a request and a process for the rest of the session.
	 */
	async exec(cmd: string, options?: ExecOptions): Promise<ExecResult> {
		const command: string = withEnvPrefix(cmd, this.env, this.envDefaults);
		const timeout: number | undefined = options?.timeout;
		const backstopMs: number | undefined =
			timeout === undefined && this.config.commandMaxSeconds > 0
				? this.config.commandMaxSeconds * 1000
				: undefined;
		const deadline: number | undefined = timeout ?? backstopMs;
		try {
			const channel: ControlChannel = await this.open();
			const result: CommandResult = await channel.run(
				['sh', '-lc', command],
				deadline === undefined ? {} : { timeoutMs: deadline },
			);
			return toExecResult(result);
		} catch (error) {
			const stderr: string =
				error instanceof CommandTimeoutError && backstopMs !== undefined
					? `Command ran past ARMADA_COMMAND_MAX_SECONDS (${String(this.config.commandMaxSeconds)}s) and was killed: ${cmd}`
					: reason(error);
			return {
				success: false,
				stdout: '',
				stderr,
				error: { code: 'BACKEND_ERROR' },
			};
		}
	}

	/** The agent, submitting the job and waiting for its pod first if nobody has yet. */
	private async open(): Promise<ControlChannel> {
		if (this.channel === undefined) await this.ready();
		if (this.channel === undefined)
			throw new Error(`Sandbox ${this.id} has no agent after ready()`);
		return this.channel;
	}

	/**
	 * The same command as `exec`, with its stdout arriving as it is produced.
	 *
	 * A login shell, like `exec`: this runs whatever the caller asked for. Unlike
	 * `exec` there is no typed failure to return, so a control channel that
	 * cannot be reached throws here rather than resolving to a `BACKEND_ERROR`
	 * stream. Cancelling, or the timeout passing, closes the request, and the
	 * agent kills the command's process group when it sees that.
	 */
	async execStream(cmd: string, options?: ExecStreamOptions): Promise<ReadableStream> {
		const channel: ControlChannel = await this.open();
		const command: string = withEnvPrefix(cmd, this.env, this.envDefaults);
		return channel.stream(
			['sh', '-lc', command],
			options?.timeout === undefined ? {} : { timeoutMs: options.timeout },
		);
	}

	/**
	 * Read one file back out of the pod.
	 *
	 * The bytes cross raw, and the encoding we report is decided from them: text
	 * is returned decoded, because marimohub's `readSessionArtifacts` takes
	 * `content` and never looks at `encoding`, and anything that is not valid
	 * UTF-8 is returned as base64, which is what `proposalCapture` decodes.
	 * Reporting base64 unconditionally would store base64 as the notebook
	 * source; reporting UTF-8 unconditionally would corrupt an image the user
	 * changed.
	 *
	 * Unlike upstream, an absent path is `NOT_FOUND` rather than `READ_FAILED`.
	 * Session capture reads four fixed paths of which some routinely do not
	 * exist, so "never written" is the common answer and worth distinguishing
	 * from "could not be read". The agent's `not_found` carries it.
	 */
	async readFile(path: string): Promise<ReadFileResult> {
		return this.readThrough(
			path,
			async (channel: ControlChannel): Promise<ReadFileOutcome> => channel.readFile(path),
			(bytes: Uint8Array): ReadFileResult => {
				const text: string | undefined = decodeUtf8(bytes);
				return text === undefined
					? { success: true, content: Buffer.from(bytes).toString('base64'), encoding: 'base64' }
					: { success: true, content: text, encoding: 'utf-8' };
			},
		);
	}

	/**
	 * The read marimohub's session capture makes from `main` f4e5ef8 on, and
	 * without which it captures nothing at all. The agent does the refusing
	 * where the file is (`agent/files.go`): no symlink anywhere in the path,
	 * regular files only, at most `maxBytes`, answered by the deadline. A
	 * budget marimohub's port does not allow is refused here, before the job is
	 * submitted or the agent asked, as upstream's contract test requires.
	 *
	 * Always base64, as upstream's reference reader answers. The guess
	 * `readFile` makes from the bytes is there for a consumer that ignores
	 * `encoding`; the bounded read's consumer (`readBoundedBytes`) decodes by
	 * it and then re-checks the size, so base64 is exact and never wrong.
	 *
	 * The deadline bounds the read, not reaching the pod: a sandbox this
	 * process has not reached yet is resolved first, as for every other call.
	 */
	async readFileBounded(path: string, options: BoundedReadOptions): Promise<ReadFileResult> {
		if (!isValidBudget(options)) {
			return this.readFailed(
				path,
				'READ_FAILED',
				`maxBytes ${String(options.maxBytes)} and timeoutMs ${String(options.timeoutMs)} are not a valid budget`,
			);
		}
		const budget: ReadBudget = {
			maxBytes: options.maxBytes,
			timeoutMs: Math.ceil(options.timeoutMs),
		};
		return this.readThrough(
			path,
			async (channel: ControlChannel): Promise<ReadFileOutcome> =>
				channel.readFileBounded(path, budget),
			(bytes: Uint8Array): ReadFileResult => ({
				success: true,
				content: Buffer.from(bytes).toString('base64'),
				encoding: 'base64',
			}),
		);
	}

	/**
	 * One read through the agent, as marimohub's result: the bytes as `encode`
	 * words them, `NOT_FOUND` quietly, and any other failure through
	 * {@link readFailed}, with a channel that cannot be reached a `BACKEND_ERROR`.
	 */
	private async readThrough(
		path: string,
		read: (channel: ControlChannel) => Promise<ReadFileOutcome>,
		encode: (bytes: Uint8Array) => ReadFileResult,
	): Promise<ReadFileResult> {
		let outcome: ReadFileOutcome;
		try {
			outcome = await read(await this.open());
		} catch (error) {
			return this.readFailed(path, 'BACKEND_ERROR', reason(error));
		}
		if (outcome.outcome === 'not-found') {
			return { success: false, content: '', error: { code: 'NOT_FOUND' } };
		}
		if (outcome.outcome === 'failed') {
			return this.readFailed(path, 'READ_FAILED', outcome.message);
		}
		return encode(outcome.bytes);
	}

	/**
	 * A failed read, reported as marimohub expects and said once on stderr. A
	 * file marimohub cannot read back it leaves out without a word, and a
	 * session whose notebook is left out commits nothing and is then destroyed,
	 * so this line is the only trace of edits lost that way. `NOT_FOUND` never
	 * comes here: capture reads paths that routinely do not exist. The token is
	 * masked anywhere in the line, in case a transport error ever quotes a
	 * header or a path happens to hold it, and control
	 * characters are escaped, since a workspace file name may hold a newline.
	 */
	private readFailed(
		path: string,
		code: 'READ_FAILED' | 'BACKEND_ERROR',
		why: string,
	): ReadFileResult {
		const line: string = `marimohub-compute-armada: sandbox ${this.id} could not read ${oneLine(path)} (${code}): ${oneLine(why)}`;
		console.warn(line.replaceAll(this.token, '<token>'));
		return { success: false, content: '', error: { code } };
	}

	/**
	 * List a directory, which session capture uses to size the files it is about
	 * to read and to enumerate a workspace. The agent walks the tree itself and
	 * answers structured records; only the hidden-file filter and the relative
	 * paths are decided here ({@link toFileInfos}).
	 */
	async listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult> {
		let listed: ListFilesOutcome;
		try {
			listed = await (await this.open()).listFiles(path, options?.recursive === true);
		} catch {
			return { success: false, files: [], error: { code: 'BACKEND_ERROR' } };
		}
		if (listed.outcome === 'not-a-directory') {
			return { success: false, files: [], error: { code: 'NOT_A_DIRECTORY' } };
		}
		if (listed.outcome === 'failed') {
			return { success: false, files: [], error: { code: 'LIST_FAILED' } };
		}
		return { success: true, files: toFileInfos(listed.entries, path, options) };
	}

	/**
	 * One request per file, bytes in the body: nothing is quoted, nothing passes
	 * through a shell, and `Uint8Array` content arrives verbatim.
	 */
	async writeFiles(files: readonly SandboxFileWrite[]): Promise<void> {
		if (files.length === 0) return;
		const channel: ControlChannel = await this.open();

		const write: (file: SandboxFileWrite) => Promise<void> = async (
			file: SandboxFileWrite,
		): Promise<void> => {
			try {
				await channel.writeFile(file.path, file.content);
			} catch (error) {
				throw new Error(`Writing ${file.path} failed: ${reason(error)}`, { cause: error });
			}
		};

		for (let start = 0; start < files.length; start += WRITE_CONCURRENCY) {
			// oxlint-disable-next-line no-await-in-loop -- each chunk is parallel; the loop is the cap
			await Promise.all(files.slice(start, start + WRITE_CONCURRENCY).map(write));
		}
	}

	/**
	 * Clone a repository, upstream's one-liner: build a quoted `git clone` and
	 * run it through the ordinary `exec` path. That path is what gives it a login
	 * shell (a `git` a profile script put on PATH is found) and the accumulated
	 * env (credential helpers read variables), and the agent kills the clone if
	 * it is abandoned mid-transfer.
	 */
	async gitCheckout(repo: string, options?: GitCheckoutOptions): Promise<void> {
		const result: ExecResult = await this.exec(gitCloneCommand(repo, options));
		if (!result.success) throw new Error(`git checkout failed: ${result.stderr}`);
	}

	/** Remembered, not sent anywhere: the pod sees these on the next command. */
	async setEnvVars(vars: Record<string, string>, options?: SetEnvVarsOptions): Promise<void> {
		// Failing here names the bad key at its source; failing at the next exec
		// would blame an unrelated command.
		for (const name of Object.keys(vars)) assertEnvName(name);
		if (options?.onlyIfUnset) {
			this.envDefaults = { ...this.envDefaults, ...vars };
		} else {
			this.env = { ...this.env, ...vars };
		}
	}

	/** Never supported here — the throw is what triggers the file-copy fallback. */
	async mountBucket(_options: MountBucketOptions): Promise<void> {
		throw new Error('mountBucket is not supported on the armada backend; using file copy fallback');
	}

	async unmountBucket(_mountPath: string): Promise<void> {
		// Nothing was ever mounted.
	}

	/**
	 * Launch a long-lived process (the kernel) through the agent, which parents
	 * it: it survives this request because the agent lives for the pod's life,
	 * its exit status is collected by a real `wait`, and its output goes to a
	 * log the agent owns. A login shell, so profile-provided env (a PATH with
	 * uv and python on it) reaches the kernel; its stdout is a log, not a
	 * protocol value, so profile noise is harmless.
	 */
	async startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess> {
		const channel: ControlChannel = await this.open();

		const processEnv: Record<string, string> = {};
		for (const [name, value] of Object.entries(options?.env ?? {})) {
			if (value !== undefined) processEnv[name] = value;
		}
		// Per-process env is exported after the sandbox-wide vars, so it wins.
		const command: string = withEnvPrefix(
			withEnvPrefix(cmd, processEnv),
			this.env,
			this.envDefaults,
		);

		let pid: number;
		try {
			pid = await channel.startProcess(['sh', '-lc', command], options?.cwd);
		} catch (error) {
			throw new Error(`Starting "${cmd}" failed: ${reason(error)}`, { cause: error });
		}
		return new ArmadaProcess(
			options?.processId ?? `armada-proc-${String(pid)}`,
			cmd,
			channel,
			this.pod === undefined ? this.id : `${this.pod.podNamespace}/${this.pod.podName}`,
			pid,
		);
	}

	/**
	 * The URL is the address Armada assigned, never a hostname we template, so
	 * `options.hostname` is deliberately ignored (Armada names the
	 * host, we read it from the event stream). The scheme follows the submit:
	 * plain http to a NodePort on the cluster network, https to an Ingress
	 * hostname when its TLS is on (`ARMADA_EXPOSE`).
	 */
	async exposePort(port: number, _options: ExposePortOptions): Promise<ExposePortResult> {
		await this.ready();
		if (this.job === undefined) throw new Error(`Sandbox ${this.id} has no job after ready()`);
		return { url: await this.armada.portUrl(this.job, port) };
	}

	/**
	 * Cancelling the job deletes the pod and every object Armada created with it.
	 *
	 * A sandbox the reconciler addresses by id alone has no `job` in this
	 * process, but the job set id is the sandbox id, so cancelling the set
	 * reaches the job without a lookup. That also covers a sandbox that was
	 * never submitted at all: cancelling an empty set is a no-op.
	 */
	async destroy(): Promise<void> {
		if (this.job === undefined) await this.armada.cancelSet(this.id, await this.queue());
		else await this.armada.cancel(this.job);
		this.queues.forget(this.id);
		this.placements.delete(this.id);
		this.pod = undefined;
		this.channel = undefined;
	}
}

/**
 * marimohub's wait options as the agent's probe. `http` with a path is what a
 * surface's readiness means; the kernel's own wait passes no mode and gets tcp.
 */
function probeOf(options: Omit<WaitForPortOptions, 'timeout'> | undefined): PortProbe | undefined {
	if (options?.mode === undefined && options?.path === undefined) return undefined;
	return {
		...(options.mode === undefined ? {} : { mode: options.mode }),
		...(options.path === undefined ? {} : { path: options.path }),
	};
}

/** A detached process in the pod, addressed by the pid the agent returned. */
class ArmadaProcess implements SandboxProcess {
	constructor(
		readonly id: string,
		readonly command: string,
		private readonly channel: ControlChannel,
		/** The pod, for messages. */
		private readonly where: string,
		private readonly pid: number,
	) {}

	async kill(signal?: string): Promise<void> {
		try {
			await this.channel.signalProcess(this.pid, signal ?? 'TERM');
		} catch {
			// Killing is best effort; a process already gone is the goal reached.
		}
	}

	/**
	 * `mode` and `path` go to the agent as they are: `http` with a path is open
	 * on any HTTP answer from that path, which is what a surface's readiness
	 * means; no mode is a TCP accept, which is all the kernel's wait needs.
	 *
	 * One request: the agent loops in-pod against `127.0.0.1` and watches this
	 * process at the same time, so a kernel that dies is reported the moment it
	 * does, worded so the provisioner classifies it as a crash, not a timeout.
	 */
	async waitForPort(port: number, options?: WaitForPortOptions): Promise<void> {
		const timeout: number = options?.timeout ?? 30_000;
		const wait: PortWait = await this.channel.waitForPort(
			port,
			timeout,
			this.pid,
			probeOf(options),
		);
		if (wait.open) return;
		const log: string = await this.logsQuietly();
		if (wait.exited === true) {
			throw new Error(`process exited before port ${String(port)} opened.\n${log}`.trim());
		}
		throw new Error(
			`timed out waiting for port ${String(port)} in ${this.where} after ${String(timeout)}ms.\n${log}`,
		);
	}

	async getLogs(): Promise<{ stdout: string; stderr: string }> {
		return { stdout: await this.channel.processLogs(this.pid), stderr: '' };
	}

	/** The log, for a failure message that is already being thrown. */
	private async logsQuietly(): Promise<string> {
		try {
			return await this.channel.processLogs(this.pid);
		} catch {
			return '';
		}
	}
}
