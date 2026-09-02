import type { ArmadaClient, PodLocation, SubmittedJob } from './armada.js';
import type { ArmadaConfig } from './config.js';
import type { PodExec, PodExecOptions, PodExecResult } from './exec.js';
import { buildPodSpec } from './podspec.js';
import {
	assertEnvName,
	listFilesCommand,
	NOT_A_DIRECTORY_EXIT,
	parseListFilesOutput,
	portWaitCommand,
	READ_FILE_NOT_FOUND_EXIT,
	readFileCommand,
	shellQuote,
	withEnvPrefix,
} from './shell.js';
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

const todo: (method: string) => never = (method: string) => {
	throw new Error(`ArmadaSandbox.${method} is not implemented`);
};

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

/** Each write is one exec, so one websocket; cap how many are in flight. */
const WRITE_CONCURRENCY = 8;

/** Port waits run in-pod in chunks; each boundary is where a dead kernel gets noticed. */
const PORT_WAIT_CHUNK_MS = 30_000;
/** First chunk, kept short so a launch that fails outright reports fast. */
const PORT_WAIT_FIRST_CHUNK_MS = 2_000;

/** Distinguishes the log files of processes started in the same pod. */
let processSequence = 0;

/** A non-zero exit is the command's business; marimohub wants it as a result. */
export function toExecResult(result: PodExecResult): ExecResult {
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
		private readonly podExec: PodExec,
		private readonly options?: CreateSandboxOptions,
	) {}

	/**
	 * Submit the job and block until its pod is running.
	 *
	 * Idempotent: marimohub calls this before each use, and the submission dedupes
	 * on `clientId` anyway, so a second call on a started sandbox does nothing.
	 */
	async ready(): Promise<void> {
		if (this.pod !== undefined) return;
		this.job ??= await this.armada.submit(this.id, buildPodSpec(this.config, this.options));
		this.pod = await this.armada.waitForRunning(this.job);
	}

	/**
	 * Everything above this method is built out of `exec`, so this is the one that
	 * has to be right. A command that fails is a normal result, not an exception;
	 * only the channel itself failing is a `BACKEND_ERROR`.
	 */
	async exec(cmd: string, options?: ExecOptions): Promise<ExecResult> {
		const execOptions: PodExecOptions =
			options?.timeout === undefined ? {} : { timeoutMs: options.timeout };

		const command: string = withEnvPrefix(cmd, this.env, this.envDefaults);

		let result: PodExecResult;
		try {
			result = await this.podExec.run(await this.location(), ['sh', '-c', command], execOptions);
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

	/** The pod, submitting and waiting for it first if nobody has yet. */
	private async location(): Promise<PodLocation> {
		if (this.pod === undefined) await this.ready();
		if (this.pod === undefined) throw new Error(`Sandbox ${this.id} has no pod after ready()`);
		return this.pod;
	}

	async execStream(_cmd: string, _options?: ExecStreamOptions): Promise<ReadableStream> {
		return todo('execStream');
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
		let result: PodExecResult;
		try {
			// No login shell and no env prefix: this stdout is a protocol value we
			// parse, and profile scripts print to stdout.
			result = await this.podExec.run(await this.location(), ['sh', '-c', readFileCommand(path)]);
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
		let result: PodExecResult;
		try {
			result = await this.podExec.run(await this.location(), [
				'sh',
				'-c',
				listFilesCommand(path, options),
			]);
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
	 * Pod exec has no multi-file write, so this is one exec per file. Content
	 * goes over stdin, never into the command line, so bytes arrive verbatim
	 * and nothing needs escaping beyond the path.
	 */
	async writeFiles(files: readonly SandboxFileWrite[]): Promise<void> {
		if (files.length === 0) return;
		const pod: PodLocation = await this.location();

		const write: (file: SandboxFileWrite) => Promise<void> = async (
			file: SandboxFileWrite,
		): Promise<void> => {
			// No slash means the pod's working directory; a slash at 0 means `/`,
			// which exists. Only a real parent needs creating.
			const slash: number = file.path.lastIndexOf('/');
			const mkdir: string =
				slash > 0 ? `mkdir -p -- ${shellQuote(file.path.slice(0, slash))} && ` : '';
			const result: PodExecResult = await this.podExec.run(
				pod,
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

	async gitCheckout(_repo: string, _options?: GitCheckoutOptions): Promise<void> {
		return todo('gitCheckout');
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
	 * Launch a long-lived process (the kernel) detached, so it outlives the exec
	 * session that started it: setsid, output to a log file, stdin closed, PID
	 * echoed back. The outer shell is non-login because its stdout is the PID we
	 * parse; the detached inner shell is a login shell so profile-provided env
	 * (a PATH with uv and python on it) reaches the kernel, its output going to
	 * the log file where profile noise is harmless.
	 */
	async startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess> {
		const pod: PodLocation = await this.location();
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
		const started: PodExecResult = await this.podExec.run(pod, ['sh', '-c', launch]);
		if (started.exitCode !== 0) {
			throw new Error(`Starting "${cmd}" failed: ${started.stderr}`);
		}

		const pid: string = started.stdout.trim();
		return new ArmadaProcess(
			options?.processId ?? `armada-proc-${pid === '' ? String(processSequence) : pid}`,
			cmd,
			this.podExec,
			pod,
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

	/** Cancelling the job deletes the pod and every object Armada created with it. */
	async destroy(): Promise<void> {
		if (this.job === undefined) return;
		await this.armada.cancel(this.job);
		this.pod = undefined;
	}
}

/** A detached process in the pod, addressed by the PID its launch echoed back. */
class ArmadaProcess implements SandboxProcess {
	constructor(
		readonly id: string,
		readonly command: string,
		private readonly podExec: PodExec,
		private readonly pod: PodLocation,
		private readonly pid: string,
		private readonly logFile: string,
	) {}

	private async run(cmd: string): Promise<PodExecResult> {
		return this.podExec.run(this.pod, ['sh', '-c', cmd]);
	}

	private async log(): Promise<string> {
		return (await this.run(`cat ${this.logFile} 2>/dev/null || true`)).stdout;
	}

	/**
	 * Exit 0 if the process is alive. Not `kill -0`: this pod's PID 1 is
	 * `sleep infinity`, which never reaps orphans, so a crashed process stays a
	 * zombie that `kill -0` still counts as alive and every crash would read as
	 * a timeout. The state field sits after the last `)` because the comm field
	 * before it may itself contain spaces.
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
		// The waiter loops in-pod rather than being probed from here: every exec
		// is a fresh websocket through the API server, so an external poll would
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
			const waited: PodExecResult = await this.podExec.run(this.pod, [
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
			`timed out waiting for port ${String(port)} in ${this.pod.podNamespace}/${this.pod.podName} after ${String(timeout)}ms.\n${await this.log()}`,
		);
	}

	async getLogs(): Promise<{ stdout: string; stderr: string }> {
		return { stdout: await this.log(), stderr: '' };
	}
}
