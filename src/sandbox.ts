import type { ArmadaClient, PodLocation, SubmittedJob } from './armada.js';
import type { ArmadaConfig } from './config.js';
import type { PodExec, PodExecOptions, PodExecResult } from './exec.js';
import { buildPodSpec } from './podspec.js';
import { assertEnvName, shellQuote, withEnvPrefix } from './shell.js';
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
} from './types.js';

const todo: (method: string) => never = (method: string) => {
	throw new Error(`ArmadaSandbox.${method} is not implemented`);
};

/** Each write is one exec, so one websocket; cap how many are in flight. */
const WRITE_CONCURRENCY = 8;

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

	async readFile(_path: string): Promise<ReadFileResult> {
		return todo('readFile');
	}

	async listFiles(_path: string, _options?: ListFilesOptions): Promise<ListFilesResult> {
		return todo('listFiles');
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

	async startProcess(_cmd: string, _options?: StartProcessOptions): Promise<SandboxProcess> {
		return todo('startProcess');
	}

	/** Returns the ingress address Armada assigned, not a templated hostname. */
	async exposePort(_port: number, _options: ExposePortOptions): Promise<ExposePortResult> {
		return todo('exposePort');
	}

	/** Cancelling the job deletes the pod and every object Armada created with it. */
	async destroy(): Promise<void> {
		if (this.job === undefined) return;
		await this.armada.cancel(this.job);
		this.pod = undefined;
	}
}
