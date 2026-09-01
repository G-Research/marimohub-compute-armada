import type { ArmadaClient, PodLocation, SubmittedJob } from './armada.js';
import type { ArmadaConfig } from './config.js';
import type { PodExec, PodExecOptions, PodExecResult } from './exec.js';
import { buildPodSpec } from './podspec.js';
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

		let result: PodExecResult;
		try {
			result = await this.podExec.run(await this.location(), ['sh', '-c', cmd], execOptions);
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

	async writeFiles(_files: readonly SandboxFileWrite[]): Promise<void> {
		return todo('writeFiles');
	}

	async gitCheckout(_repo: string, _options?: GitCheckoutOptions): Promise<void> {
		return todo('gitCheckout');
	}

	async setEnvVars(_vars: Record<string, string>, _options?: SetEnvVarsOptions): Promise<void> {
		return todo('setEnvVars');
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
