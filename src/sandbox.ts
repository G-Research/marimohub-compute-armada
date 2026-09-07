import { createHash, randomBytes } from 'node:crypto';
import type { ArmadaClient, PodLocation, SubmittedJob } from './armada.js';
import type { ArmadaConfig } from './config.js';
import type { AgentEndpoint, CommandResult, ControlChannel } from './channel.js';
import { buildPodSpec } from './podspec.js';
import type { GhostSweeper } from './sweeper.js';
import {
	assertEnvName,
	gitCloneCommand,
	killGroupCommand,
	listFilesCommand,
	parseSweptGroups,
	processGroupCommand,
	NOT_A_DIRECTORY_EXIT,
	parseListFilesOutput,
	portWaitCommand,
	READ_FILE_NOT_FOUND_EXIT,
	readFileCommand,
	shellQuote,
	sweepGroupsCommand,
	withEnvPrefix,
} from './shell.js';
import type { SweptGroup } from './shell.js';
import type {
	CreateSandboxOptions,
	ExecOptions,
	ExecResult,
	ExecStreamOptions,
	ExposePortOptions,
	ExposePortResult,
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

/** Each write is one request to the agent; cap how many are in flight. */
const WRITE_CONCURRENCY = 8;

/** How long a running pod gets to answer on the agent port before `ready` gives up. */
const AGENT_READY_TIMEOUT_MS = 30_000;

/** Port waits run in-pod in chunks; each boundary is where a dead kernel gets noticed. */
const PORT_WAIT_CHUNK_MS = 30_000;
/** First chunk, kept short so a launch that fails outright reports fast. */
const PORT_WAIT_FIRST_CHUNK_MS = 2_000;

/** Distinguishes the log files of processes started in the same pod. */
let processSequence = 0;

/** Distinguishes the process-group files of execs and streams in the same pod. */
let groupSequence = 0;

/** A command started in its own process group, and whether anyone still wants it. */
interface TrackedCommand {
	/** Only an `exec` is subject to the backstop; a stream's life is its reader's. */
	kind: 'exec' | 'stream';
	command: string;
	startedAt: number;
	awaiting: boolean;
}

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
 * One kernel session, backed by one Armada job.
 *
 * Resolution is lazy: `create()` is synchronous and id-addressed, so the job is
 * submitted on first use. Everything below `exec` is built out of ordinary shell
 * commands, so implementing `exec` well is most of the work.
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

	/**
	 * Every command this sandbox started in a process group, by group file.
	 *
	 * Registered before the command is sent, so the record is never missing
	 * something the pod has already started, and `awaiting` says whether anyone is
	 * still waiting for it. {@link sweep} leaves the awaited ones alone and kills
	 * the rest; a command that finished normally is dropped outright, since its
	 * own trap removed the file.
	 */
	private readonly groups: Map<string, TrackedCommand> = new Map();

	private sweeping = false;
	private ghostsKilled = 0;

	constructor(
		private readonly id: SandboxId,
		private readonly config: ArmadaConfig,
		private readonly armada: ArmadaClient,
		private readonly openChannel: (endpoint: AgentEndpoint) => ControlChannel,
		private readonly options?: CreateSandboxOptions,
		private readonly sweeper?: GhostSweeper,
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
		// Swept from here until `destroy`, by the provider's one sweeper rather
		// than a timer of our own: see `src/sweeper.ts` for why that matters.
		this.sweeper?.add(this);
	}

	/** Where the pod landed, once it has. For reporting, not for reaching it. */
	get placement(): PodLocation | undefined {
		return this.pod;
	}

	/**
	 * Kill the process groups this sandbox started and is no longer waiting on.
	 *
	 * Every abandonable command records its group id in a file and removes it on
	 * the way out, so a file that survives a command nobody is waiting on is a
	 * ghost by construction. That is what makes an automatic kill safe here: the
	 * kernel and whatever the user's notebook spawned have no such file, so they
	 * are never candidates. A sweep that guessed from process state could not
	 * tell them apart.
	 *
	 * The kill in `onStop` is what normally stops an abandoned command; this
	 * repairs the cases where it could not. A cancel can beat the command to
	 * recording its group, the `onStop` exec can fail on a channel having a bad
	 * minute, and a marimohub restart abandons every stream it had open without
	 * running one at all.
	 *
	 * Best effort throughout: a sweep that cannot reach the pod is a sweep that
	 * happens a minute later instead.
	 */
	async sweep(): Promise<number> {
		// Nothing to sweep before there is a pod, and never two at once: the second
		// would see the first's work as unowned.
		const channel: ControlChannel | undefined = this.channel;
		if (channel === undefined || this.sweeping) return 0;
		this.sweeping = true;
		try {
			this.expireLongRunning();
			const awaited: string[] = [...this.groups]
				.filter(([, tracked]: [string, TrackedCommand]) => tracked.awaiting)
				.map(([groupFile]: [string, TrackedCommand]) => groupFile);
			const result: CommandResult = await channel.run(['sh', '-c', sweepGroupsCommand(awaited)]);

			const swept: SweptGroup[] = parseSweptGroups(result.stdout);
			const killed: SweptGroup[] = swept.filter((group: SweptGroup) => group.outcome === 'killed');
			for (const group of killed) {
				// Naming the command is the difference between a report you can act on
				// and a bare process id. A file we have no record of is a leftover from
				// a previous marimohub, which is exactly the case nothing else repairs.
				const tracked: TrackedCommand | undefined = this.groups.get(group.groupFile);
				const what: string =
					tracked === undefined
						? 'from a previous marimohub process'
						: `${JSON.stringify(tracked.command)}, started ${String(Math.round((Date.now() - tracked.startedAt) / 1000))}s ago`;
				// The one place this is visible while a session runs, and it means a
				// kill that should have happened earlier did not.
				console.warn(
					`[armada] sandbox ${this.id}: killed abandoned process group ${group.group} in ${this.pod?.podName ?? 'its pod'} (${what})`,
				);
			}
			this.ghostsKilled += killed.length;
			// Every file it reported is gone from the pod, and the rest were never
			// there, so nothing not still awaited is worth remembering.
			for (const [groupFile, tracked] of this.groups) {
				if (!tracked.awaiting) this.groups.delete(groupFile);
			}
			return killed.length;
		} catch {
			return 0;
		} finally {
			this.sweeping = false;
		}
	}

	/** Ghosts found since marimohub last asked, which it logs per session. */
	drainCounters(): Record<string, number> {
		const counters: Record<string, number> = { ghosts_killed: this.ghostsKilled };
		this.ghostsKilled = 0;
		return counters;
	}

	/**
	 * Everything above this method is built out of `exec`, so this is the one that
	 * has to be right. A command that fails is a normal result, not an exception;
	 * only the channel itself failing is a `BACKEND_ERROR`.
	 *
	 * A login shell, matching marimohub's kubernetes adapter: what arrives here is
	 * user and provisioner code, and an image that puts `uv` or `python3` on the
	 * PATH through a profile script has to keep working. Our own protocol commands
	 * never come through here; they run non-login so nothing a profile prints can
	 * reach output we parse.
	 */
	async exec(cmd: string, options?: ExecOptions): Promise<ExecResult> {
		const command: string = withEnvPrefix(cmd, this.env, this.envDefaults);

		let result: CommandResult;
		try {
			const channel: ControlChannel = await this.open();
			// Every exec runs in its own process group and records it in a file.
			// The agent kills the group itself when a deadline passes or the
			// request drops, so the file is the sweep's handle for what that could
			// not reach: a kill that raced the prologue, or a marimohub that
			// restarted and left the pod's commands behind (decisions 24 and 25).
			const timeout: number | undefined = options?.timeout;
			const groupFile: string = this.track('exec', cmd);
			try {
				result = await channel.run(
					processGroupCommand(groupFile, command),
					timeout === undefined
						? {}
						: { timeoutMs: timeout, onStop: async () => this.killGroup(channel, groupFile) },
				);
				// It returned, so its trap has run and there is no file to sweep.
				this.groups.delete(groupFile);
			} catch (failure) {
				// It did not return, so the command may well still be running: keep the
				// record, and let the sweep deal with what the timeout kill could not.
				this.abandon(groupFile);
				throw failure;
			}
		} catch (error) {
			return {
				success: false,
				stdout: '',
				stderr: error instanceof Error ? error.message : String(error),
				error: { code: 'BACKEND_ERROR' },
			};
		}
		return toExecResult(result);
	}

	/**
	 * Start tracking a command, returning the group file it should record itself
	 * in. The record exists before the command does, so a sweep can never mistake
	 * a command being started for one nobody wants.
	 */
	private track(kind: TrackedCommand['kind'], command: string): string {
		const groupFile = `/tmp/mh-${kind}-${String(++groupSequence)}.pgid`;
		this.groups.set(groupFile, { kind, command, startedAt: Date.now(), awaiting: true });
		return groupFile;
	}

	/**
	 * Give up on an `exec` that has run past `ARMADA_COMMAND_MAX_SECONDS`.
	 *
	 * This is the backstop, not a timeout: the caller's `ExecOptions.timeout` is
	 * the timeout, and most of marimohub's exec calls carry none because the work
	 * legitimately takes minutes. Hours is the point at which nobody expected it
	 * to still be running, and the alternative is a websocket and a process held
	 * for the rest of the session while its caller waits forever.
	 *
	 * It only marks the command as no longer awaited; the sweep it runs inside
	 * then kills it like any other abandoned group, and the caller's `exec` sees
	 * the command die rather than hanging on.
	 *
	 * Streams are exempt. A `tail -f` open for hours is a consumer's decision, not
	 * a stuck command.
	 */
	private expireLongRunning(): void {
		const cap: number = this.config.commandMaxSeconds;
		if (cap === 0) return;
		for (const tracked of this.groups.values()) {
			if (!tracked.awaiting || tracked.kind !== 'exec') continue;
			const seconds: number = Math.round((Date.now() - tracked.startedAt) / 1000);
			if (seconds < cap) continue;
			tracked.awaiting = false;
			console.warn(
				`[armada] sandbox ${this.id}: ${JSON.stringify(tracked.command)} has run for ${String(seconds)}s, past ARMADA_COMMAND_MAX_SECONDS (${String(cap)}s); killing it`,
			);
		}
	}

	/** Stop waiting for a command, without forgetting that we started it. */
	private abandon(groupFile: string): void {
		const tracked: TrackedCommand | undefined = this.groups.get(groupFile);
		if (tracked !== undefined) tracked.awaiting = false;
	}

	/** Kill the process group `groupFile` names, for a command we abandoned. */
	private async killGroup(channel: ControlChannel, groupFile: string): Promise<void> {
		await channel.run(['sh', '-c', killGroupCommand(groupFile)]);
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
	 * A login shell, like `exec`: this runs whatever the caller asked for, not a
	 * protocol command whose output we parse. Unlike `exec` there is no typed
	 * failure to return, so a control channel that cannot be reached throws here
	 * rather than resolving to a `BACKEND_ERROR` stream.
	 *
	 * The command runs under `setsid` in its own process group, and the shell
	 * writes that group's id to a file before starting it. Cancelling closes the
	 * request and the agent kills the group; the file is what the sweep uses for
	 * the cases that kill could not reach (decision 25).
	 */
	async execStream(cmd: string, options?: ExecStreamOptions): Promise<ReadableStream> {
		const channel: ControlChannel = await this.open();
		const command: string = withEnvPrefix(cmd, this.env, this.envDefaults);
		const groupFile: string = this.track('stream', cmd);

		return channel.stream(processGroupCommand(groupFile, command), {
			...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout }),
			// Best effort: a cancel in the instant before the prologue wrote the file
			// finds nothing to kill. The sweep is what repairs that.
			onStop: async () => {
				this.abandon(groupFile);
				await this.killGroup(channel, groupFile);
			},
			// Reached however the command ended, so an abandoned one keeps its record
			// and one that ended on its own drops it.
			onFinished: () => {
				if (this.groups.get(groupFile)?.awaiting === true) this.groups.delete(groupFile);
			},
		});
	}

	/**
	 * Read one file back out of the pod.
	 *
	 * The bytes cross as base64 ({@link readFileCommand} says why) and the
	 * encoding we report is decided from them: text is returned decoded, because
	 * marimohub's `readSessionArtifacts` takes `content` and never looks at
	 * `encoding`, and anything that is not valid UTF-8 is returned as base64,
	 * which is what `proposalCapture` decodes. Reporting base64 unconditionally
	 * would store base64 as the notebook source; reporting UTF-8 unconditionally
	 * would corrupt an image the user changed.
	 *
	 * Unlike upstream, an absent path is `NOT_FOUND` rather than `READ_FAILED`.
	 * Session capture reads four fixed paths of which some routinely do not
	 * exist, so "never written" is the common answer and worth distinguishing
	 * from "could not be read".
	 */
	async readFile(path: string): Promise<ReadFileResult> {
		let result: CommandResult;
		try {
			// No login shell and no env prefix: this stdout is a protocol value we
			// parse, and profile scripts print to stdout.
			result = await (await this.open()).run(['sh', '-c', readFileCommand(path)]);
		} catch {
			return { success: false, content: '', error: { code: 'BACKEND_ERROR' } };
		}
		if (result.exitCode === READ_FILE_NOT_FOUND_EXIT) {
			return { success: false, content: '', error: { code: 'NOT_FOUND' } };
		}
		if (result.exitCode !== 0) {
			return { success: false, content: '', error: { code: 'READ_FAILED' } };
		}
		// Re-encoded rather than passed through, because GNU base64 wraps its
		// output at 76 columns and the decoders downstream take one line.
		const bytes: Buffer = Buffer.from(result.stdout, 'base64');
		const text: string | undefined = decodeUtf8(bytes);
		return text === undefined
			? { success: true, content: bytes.toString('base64'), encoding: 'base64' }
			: { success: true, content: text, encoding: 'utf-8' };
	}

	/**
	 * List a directory, which session capture uses to size the files it is about
	 * to read and to enumerate a workspace.
	 *
	 * Also a non-login shell without the env prefix, for the reason `readFile`
	 * has: the records are NUL-separated protocol output. This is where upstream
	 * diverges from its own rule, running its `find` through the ordinary `exec`
	 * path, where a profile script that prints anything corrupts the listing.
	 */
	async listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult> {
		let result: CommandResult;
		try {
			result = await (await this.open()).run(['sh', '-c', listFilesCommand(path, options)]);
		} catch {
			return { success: false, files: [], error: { code: 'BACKEND_ERROR' } };
		}
		if (result.exitCode === NOT_A_DIRECTORY_EXIT) {
			return { success: false, files: [], error: { code: 'NOT_A_DIRECTORY' } };
		}
		if (result.exitCode !== 0) {
			return { success: false, files: [], error: { code: 'LIST_FAILED' } };
		}
		return { success: true, files: parseListFilesOutput(result.stdout, path, options) };
	}

	/**
	 * One command per file. Content goes over stdin, never into the command
	 * line, so bytes arrive verbatim and nothing needs escaping beyond the path.
	 */
	async writeFiles(files: readonly SandboxFileWrite[]): Promise<void> {
		if (files.length === 0) return;
		const channel: ControlChannel = await this.open();

		const write: (file: SandboxFileWrite) => Promise<void> = async (
			file: SandboxFileWrite,
		): Promise<void> => {
			// No slash means the pod's working directory; a slash at 0 means `/`,
			// which exists. Only a real parent needs creating.
			const slash: number = file.path.lastIndexOf('/');
			const mkdir: string =
				slash > 0 ? `mkdir -p -- ${shellQuote(file.path.slice(0, slash))} && ` : '';
			const result: CommandResult = await channel.run(
				['sh', '-c', `${mkdir}cat > ${shellQuote(file.path)}`],
				{ stdin: file.content },
			);
			if (result.exitCode !== 0) {
				throw new Error(`Writing ${file.path} failed: ${result.stderr}`);
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
	 * shell (a `git` a profile script put on PATH is found), the accumulated env
	 * (credential helpers read variables), and a process group the sweep can kill
	 * if the clone is abandoned mid-transfer.
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
	 * Launch a long-lived process (the kernel) detached, so it outlives the
	 * request that started it: setsid, output to a log file, stdin closed, PID
	 * echoed back. The outer shell is non-login because its stdout is the PID we
	 * parse; the detached inner shell is a login shell so profile-provided env
	 * (a PATH with uv and python on it) reaches the kernel, its output going to
	 * the log file where profile noise is harmless.
	 */
	async startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess> {
		const channel: ControlChannel = await this.open();
		const logFile = `/tmp/mh-proc-${String(++processSequence)}.log`;
		const cd: string = options?.cwd === undefined ? '' : `cd ${shellQuote(options.cwd)}; `;

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

		const launch = `${cd}setsid sh -lc ${shellQuote(command)} >${logFile} 2>&1 </dev/null & echo $!`;
		const started: CommandResult = await channel.run(['sh', '-c', launch]);
		if (started.exitCode !== 0) {
			throw new Error(`Starting "${cmd}" failed: ${started.stderr}`);
		}

		const pid: string = started.stdout.trim();
		return new ArmadaProcess(
			options?.processId ?? `armada-proc-${pid === '' ? String(processSequence) : pid}`,
			cmd,
			channel,
			this.pod === undefined ? this.id : `${this.pod.podNamespace}/${this.pod.podName}`,
			pid,
			logFile,
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
		this.sweeper?.remove(this);
		if (this.job === undefined) await this.armada.cancelSet(this.id);
		else await this.armada.cancel(this.job);
		this.pod = undefined;
		this.channel = undefined;
	}
}

/** A detached process in the pod, addressed by the PID its launch echoed back. */
class ArmadaProcess implements SandboxProcess {
	constructor(
		readonly id: string,
		readonly command: string,
		private readonly channel: ControlChannel,
		/** The pod, for messages. */
		private readonly where: string,
		private readonly pid: string,
		private readonly logFile: string,
	) {}

	private async run(cmd: string): Promise<CommandResult> {
		return this.channel.run(['sh', '-c', cmd]);
	}

	private async log(): Promise<string> {
		return (await this.run(`cat ${this.logFile} 2>/dev/null || true`)).stdout;
	}

	/**
	 * Exit 0 if the process is alive. Not `kill -0`: a process that has exited
	 * but not been collected is a zombie that `kill -0` still counts as alive.
	 * The agent, as PID 1, collects orphans, so today the two agree, but the
	 * probe reads the state field and is right either way. The field sits after
	 * the last `)` because the comm field before it may itself contain spaces.
	 */
	private aliveCommand(): string {
		return `state=$(sed 's/^.*) //' /proc/${this.pid}/stat 2>/dev/null | cut -d' ' -f1); [ -n "$state" ] && [ "$state" != Z ]`;
	}

	async kill(signal?: string): Promise<void> {
		if (this.pid === '') return;
		try {
			await this.run(`kill -${signal ?? 'TERM'} ${this.pid} 2>/dev/null || true`);
		} catch {
			// Already gone; killing is best effort.
		}
	}

	/**
	 * `mode`/`path` are accepted but a TCP accept is all that is checked, the
	 * same as marimohub's kubernetes adapter.
	 */
	async waitForPort(port: number, options?: WaitForPortOptions): Promise<void> {
		const timeout: number = options?.timeout ?? 30_000;
		// The waiter loops in-pod rather than being probed from here: every probe
		// would be a fresh request to the agent, so an external poll would
		// quantize the wait to that round-trip grid. Chunked so each boundary is
		// where a dead kernel gets noticed, with the first chunk short so a launch
		// that fails outright reports fast. `attempts` bounds the loop if the
		// in-pod waiter itself returns instantly (say, python3 missing).
		const deadline: number = Date.now() + timeout;
		const attempts: number = 1 + Math.ceil(timeout / PORT_WAIT_CHUNK_MS);
		let chunkMs: number = PORT_WAIT_FIRST_CHUNK_MS;
		// oxlint-disable no-await-in-loop -- each chunk must finish before the next is sized
		for (let attempt = 0; attempt < attempts; attempt++) {
			const remainingMs: number = deadline - Date.now();
			if (remainingMs <= 0) break;
			// Fractional seconds: the waiter runs a monotonic ms-precision deadline,
			// so the chunks sum to the full timeout without whole-second rounding.
			const seconds: number = Number((Math.min(chunkMs, remainingMs) / 1000).toFixed(2));
			chunkMs = PORT_WAIT_CHUNK_MS;
			// A login shell, so a python3 that a profile script put on PATH is found.
			const waited: CommandResult = await this.channel.run([
				'sh',
				'-lc',
				portWaitCommand(port, seconds),
			]);
			if (waited.exitCode === 0) return;
			// The chunk elapsed with the port closed. A dead kernel never opens it,
			// so check liveness before spending another chunk, and word the error so
			// the provisioner classifies it as a crash, not a timeout.
			if (this.pid !== '' && (await this.run(this.aliveCommand())).exitCode !== 0) {
				throw new Error(
					`process exited before port ${String(port)} opened.\n${await this.log()}`.trim(),
				);
			}
		}
		// oxlint-enable no-await-in-loop
		throw new Error(
			`timed out waiting for port ${String(port)} in ${this.where} after ${String(timeout)}ms.\n${await this.log()}`,
		);
	}

	async getLogs(): Promise<{ stdout: string; stderr: string }> {
		return { stdout: await this.log(), stderr: '' };
	}
}
