/**
 * Hand-written mirror of the marimohub port surface we implement.
 *
 * `@marimo-hub/core` is not published to npm yet, so these are transcribed from
 * `packages/core/src/ports/sandbox.ts` and `ports/externalAdapter.ts` at
 * marimohub v0.4.2 (d58bb8a, 2026-09-12; both files are unchanged since `main`
 * 2495463, the earlier transcription point). Every member added since 0.3.12
 * is optional, so the file serves 0.3.12 as well. Branded ids
 * (`ProjectId`, `UserId`, `Millis`) are plain `string` and `number` here.
 * Replace this file with `import type { … } from '@marimo-hub/core'` once the
 * packages ship (or pin a git sha): the shapes are frozen under `apiVersion: 1`.
 */

export type SandboxId = string;

export interface ExecSuccess {
	success: true;
	stdout: string;
	stderr: string;
}

export interface ExecFailure {
	success: false;
	stdout: string;
	stderr: string;
	error: { code: 'COMMAND_FAILED' | 'SPAWN_FAILED' | 'BACKEND_ERROR' };
}

export type ExecResult = ExecSuccess | ExecFailure;

export interface ReadFileSuccess {
	success: true;
	content: string;
	encoding?: 'utf-8' | 'base64';
}

export interface ReadFileFailure {
	success: false;
	content: '';
	error: { code: 'NOT_FOUND' | 'READ_FAILED' | 'BACKEND_ERROR' };
}

export type ReadFileResult = ReadFileSuccess | ReadFileFailure;

export interface FileInfo {
	name: string;
	absolutePath: string;
	relativePath: string;
	type: 'file' | 'directory' | 'symlink' | 'other';
	size: number;
}

export interface ListFilesSuccess {
	success: true;
	files: FileInfo[];
}

export interface ListFilesFailure {
	success: false;
	files: [];
	error: { code: 'NOT_A_DIRECTORY' | 'LIST_FAILED' | 'BACKEND_ERROR' };
}

export type ListFilesResult = ListFilesSuccess | ListFilesFailure;

export interface ListFilesOptions {
	recursive?: boolean;
	includeHidden?: boolean;
}

export interface GitCheckoutOptions {
	targetDir?: string;
	branch?: string;
}

export interface MountBucketOptions {
	bucketName: string;
	mountPath: string;
	prefix: string;
	endpoint?: string;
	credentials?: { accessKeyId: string; secretAccessKey: string };
}

export interface SetEnvVarsOptions {
	onlyIfUnset?: boolean;
}

export interface StartProcessOptions {
	processId?: string;
	cwd?: string;
	env?: Record<string, string | undefined>;
	timeout?: number;
}

export interface WaitForPortOptions {
	mode?: 'http' | 'tcp';
	path?: string;
	timeout?: number;
}

export interface SandboxProcess {
	readonly id: string;
	readonly command: string;
	kill(signal?: string): Promise<void>;
	waitForPort(port: number, options?: WaitForPortOptions): Promise<void>;
	getLogs(): Promise<{ stdout: string; stderr: string }>;
}

export interface ExecOptions {
	timeout?: number;
}

export interface ExecStreamOptions {
	timeout?: number;
}

export interface ExposePortOptions {
	hostname: string;
	token?: string;
	name?: string;
}

export interface ExposePortResult {
	url: string;
}

/** One file to write into a sandbox. `Uint8Array` content is written verbatim. */
export interface SandboxFileWrite {
	path: string;
	content: string | Uint8Array;
}

export interface SandboxInstance {
	readonly supportsBucketMount?: boolean;
	/** A hub-side workspace path as the sandbox's processes see it; identity when absent. */
	resolveProcessPath?(path: string): string;
	/** One look at a port, for a surface started earlier; a wait is `SandboxProcess.waitForPort`. */
	isPortReady?(port: number, options?: Omit<WaitForPortOptions, 'timeout'>): Promise<boolean>;
	ready?(): Promise<void>;
	exec(cmd: string, options?: ExecOptions): Promise<ExecResult>;
	execStream(cmd: string, options?: ExecStreamOptions): Promise<ReadableStream>;
	readFile(path: string): Promise<ReadFileResult>;
	listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult>;
	writeFiles(files: readonly SandboxFileWrite[]): Promise<void>;
	gitCheckout(repo: string, options?: GitCheckoutOptions): Promise<void>;
	setEnvVars(vars: Record<string, string>, options?: SetEnvVarsOptions): Promise<void>;
	mountBucket(options: MountBucketOptions): Promise<void>;
	unmountBucket(mountPath: string): Promise<void>;
	startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess>;
	exposePort(port: number, options: ExposePortOptions): Promise<ExposePortResult>;
	destroy(): Promise<void>;
	drainTimings?(): Record<string, number>;
	drainCounters?(): Record<string, number>;
}

export interface ActiveSandbox {
	id: SandboxId;
	createdAt?: string;
}

/** Backend-neutral resources requested for one sandbox. Empty means provider defaults. */
export interface ComputeResources {
	cpu?: number;
	memoryBytes?: number;
	/** Provider GPU type, optionally suffixed with a count (for example, `A100:2`). */
	gpu?: string;
}

export interface SandboxUserHome {
	key: string;
	path: string;
}

/**
 * Who a sandbox is for. Adapters that partition compute per tenant (an Armada
 * queue, a Kubernetes namespace) key on it; the rest ignore it.
 *
 * Merged upstream in marimo-team/marimohub#301 (2026-09-09) and released in 0.4.0,
 * so a 0.3.x marimohub never sets it.
 */
export interface SandboxOwner {
	projectId: string;
	userId?: string;
}

export interface CreateSandboxOptions {
	reuse?: boolean;
	image?: string;
	resources?: ComputeResources;
	userHome?: SandboxUserHome;
	/**
	 * The control plane's idle deadline for the session, for a provider that can
	 * set a later backstop of its own. Not the lifecycle enforcement itself.
	 */
	sessionIdleTimeoutMs?: number;
	/**
	 * Who the sandbox is for, on every call where the caller holds a session
	 * record. Absent where it holds only an id (orphan reconciliation), so an
	 * adapter that keys on it must remember what it learned or look it up.
	 */
	owner?: SandboxOwner;
}

export interface SandboxProvider {
	/**
	 * `multiPort`: every sandbox exposes the ports of the enabled surfaces next
	 * to the kernel's. marimohub refuses to start a surface without it.
	 */
	readonly capabilities?: {
		multiPort: boolean;
	};
	create(id: SandboxId, options?: CreateSandboxOptions): SandboxInstance;
	proxy(request: Request): Promise<Response | null>;
	listActive?(): Promise<ActiveSandbox[]>;
	[Symbol.asyncDispose]?(): PromiseLike<void>;
}

export interface AdapterFactoryContext {
	env: Record<string, string | undefined>;
	errors: { preconditionFailed(message?: string): Error };
	compute?: {
		sessionMaxLifetimeSeconds?: number;
		sessionIdleTimeoutMs?: number;
	};
}

export interface ComputeAdapterModule {
	apiVersion: number;
	kind: 'compute';
	create(context: AdapterFactoryContext): SandboxProvider | Promise<SandboxProvider>;
}
