import { createHash, randomBytes } from 'node:crypto';
import type { ArmadaClient, PodLocation, SubmittedJob } from './armada.js';
import type { ArmadaConfig } from './config.js';
import type {
	AgentEndpoint,
	AgentFileEntry,
	CommandResult,
	ControlChannel,
	ListFilesOutcome,
	PortWait,
	ReadFileOutcome,
} from './channel.js';
import { CommandTimeoutError } from './channel.js';
import { buildPodSpec } from './podspec.js';
import { assertEnvName, gitCloneCommand, withEnvPrefix } from './shell.js';
import type {
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

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Each write is one request to the agent; cap how many are in flight. */
const WRITE_CONCURRENCY = 8;

/** How long a running pod gets to answer on the agent port before `ready` gives up. */
const AGENT_READY_TIMEOUT_MS = 30_000;

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
	private token?: string;

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
		private readonly options?: CreateSandboxOptions,
	) {}

	/**
	 * Submit the job, block until its pod is running, and reach the agent in it.
	 *
	 * Idempotent: marimohub calls this before each use, and the submission dedupes
	 * on `clientId` anyway, so a second call on a started sandbox does nothing.
	 *
	 * The token is minted here and never leaves this process except in request
	 * headers to the one pod that knows its hash. The pod spec, which anyone with
	 * read access to the job can fetch, carries the hash alone.
	 */
	async ready(): Promise<void> {
		if (this.channel !== undefined) return;
		this.token ??= randomBytes(32).toString('hex');
		const tokenSha256: string = createHash('sha256').update(this.token).digest('hex');
		this.job ??= await this.armada.submit(
			this.id,
			buildPodSpec(this.config, { tokenSha256 }, this.options),
		);
		this.pod = await this.armada.waitForRunning(this.job);
		// The agent's address comes from the same event as the kernel's.
		const address: string = await this.armada.ingressAddress(this.job, this.config.agentPort);
		const channel: ControlChannel = this.openChannel({ address, token: this.token, pod: this.pod });
		await channel.ready(AGENT_READY_TIMEOUT_MS);
		this.channel = channel;
	}

	/** Where the pod landed, once it has. For reporting, not for reaching it. */
	get placement(): PodLocation | undefined {
		return this.pod;
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
		let read: ReadFileOutcome;
		try {
			read = await (await this.open()).readFile(path);
		} catch {
			return { success: false, content: '', error: { code: 'BACKEND_ERROR' } };
		}
		if (read.outcome === 'not-found') {
			return { success: false, content: '', error: { code: 'NOT_FOUND' } };
		}
		if (read.outcome === 'failed') {
			return { success: false, content: '', error: { code: 'READ_FAILED' } };
		}
		const text: string | undefined = decodeUtf8(read.bytes);
		return text === undefined
			? { success: true, content: Buffer.from(read.bytes).toString('base64'), encoding: 'base64' }
			: { success: true, content: text, encoding: 'utf-8' };
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
	 * `options.hostname` is deliberately ignored (decision 13: Armada names the
	 * host, we read it from the event stream). Today the submit creates a
	 * NodePort service, so the address is `hostIP:nodePort` and plain http; the
	 * scheme choice revisits when an Ingress config with TLS lands.
	 */
	async exposePort(port: number, _options: ExposePortOptions): Promise<ExposePortResult> {
		await this.ready();
		if (this.job === undefined) throw new Error(`Sandbox ${this.id} has no job after ready()`);
		const address: string = await this.armada.ingressAddress(this.job, port);
		return { url: address.includes('://') ? address : `http://${address}` };
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
		if (this.job === undefined) await this.armada.cancelSet(this.id);
		else await this.armada.cancel(this.job);
		this.pod = undefined;
		this.channel = undefined;
	}
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
	 * `mode`/`path` are accepted but a TCP accept is all that is checked, the
	 * same as marimohub's kubernetes adapter.
	 *
	 * One request: the agent loops in-pod against `127.0.0.1` and watches this
	 * process at the same time, so a kernel that dies is reported the moment it
	 * does, worded so the provisioner classifies it as a crash, not a timeout.
	 */
	async waitForPort(port: number, options?: WaitForPortOptions): Promise<void> {
		const timeout: number = options?.timeout ?? 30_000;
		const wait: PortWait = await this.channel.waitForPort(port, timeout, this.pid);
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
