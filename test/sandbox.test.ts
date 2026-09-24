import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Mock } from 'bun:test';
import type { ArmadaClient, PodLocation } from '../src/armada.js';
import type { V1Container, V1EnvVar, V1PodSpec } from '@kubernetes/client-node';
import { createHash } from 'node:crypto';
import { readConfig } from '../src/config.js';
import type { ArmadaConfig } from '../src/config.js';
import { CommandTimeoutError } from '../src/channel.js';
import type {
	AgentEndpoint,
	CommandResult,
	ControlChannel,
	PortProbe,
	ReadBudget,
	ReadFileOutcome,
	RunOptions,
	StreamOptions,
} from '../src/channel.js';
import { QueueDirectory } from '../src/queues.js';
import { AGENT_TOKEN_HASH_ENV } from '../src/podspec.js';
import { ArmadaSandbox, agentToken } from '../src/sandbox.js';
import type { Placements } from '../src/sandbox.js';
import type {
	ExecResult,
	FileInfo,
	ListFilesResult,
	ReadFileResult,
	SandboxOwner,
	SandboxProcess,
} from '../src/types.js';

const baseEnv: Record<string, string> = {
	ARMADA_URL: 'http://armada.example.com/',
	ARMADA_QUEUE: 'marimohub',
	MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
	ARMADA_AGENT_IMAGE: 'ghcr.io/example/kernel-agent:1',
	ARMADA_AGENT_TOKEN_SECRET: 'test-secret-of-at-least-32-characters',
};

const pod: PodLocation = {
	clusterId: 'Cluster1',
	podName: 'armada-job-0',
	podNamespace: 'default',
};

/** A failed read logs a line; caught here, so every test stays quiet and the log tests can read it. */
let warn: Mock<typeof console.warn>;

beforeEach(() => {
	warn = spyOn(console, 'warn').mockImplementation((): void => {});
});

afterEach(() => {
	warn.mockRestore();
});

/** Every line logged in this test. */
function logged(): string[] {
	return warn.mock.calls.map((args: unknown[]): string => args.map(String).join(' '));
}

/** The rejection reason as a string, so failures assert on the message plainly. */
async function rejection(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return String(error);
	}
	throw new Error('expected the call to reject, it resolved');
}

interface ExecCall {
	command: readonly string[];
	stdin: string | Uint8Array | undefined;
	timeoutMs?: number | undefined;
}

const ok: CommandResult = { stdout: '', stderr: '', exitCode: 0 };

/** The script of a recorded exec, which is always the argv's last entry. */
function scriptOf(call: ExecCall | undefined): string {
	return call?.command.at(-1) ?? '';
}

/** Everything the stub channel recorded, one array per capability. */
interface Recorded {
	calls: ExecCall[];
	submitted: string[];
	/** The agent token hash each submitted pod spec carried. */
	tokenHashes: string[];
	/** The timeout of every agent readiness check. */
	readies: number[];
	cancelled: string[];
	writes: { path: string; content: string | Uint8Array }[];
	reads: string[];
	boundedReads: { path: string; budget: ReadBudget }[];
	/** Every endpoint a channel was opened to, which carries the minted token. */
	endpoints: AgentEndpoint[];
	lists: { path: string; recursive: boolean }[];
	starts: { command: readonly string[]; cwd: string | undefined }[];
	signals: { pid: number; signal: string }[];
	waits: {
		port: number;
		timeoutMs: number;
		pid: number | undefined;
		probe: PortProbe | undefined;
	}[];
}

/** A sandbox whose job is "already placed" and whose channel calls are recorded. */
function stubSandbox(
	respond:
		| CommandResult
		| ((call: ExecCall) => CommandResult)
		| ((call: ExecCall) => Promise<CommandResult>) = ok,
	options: {
		env?: Record<string, string>;
		channel?: Partial<ControlChannel>;
		queues?: QueueDirectory;
		placements?: Placements;
		owner?: SandboxOwner;
	} = {},
): Recorded & { sandbox: ArmadaSandbox } {
	const settings: ArmadaConfig = readConfig({ ...baseEnv, ...options.env });
	const recorded: Recorded = {
		calls: [],
		submitted: [],
		tokenHashes: [],
		readies: [],
		cancelled: [],
		writes: [],
		reads: [],
		boundedReads: [],
		endpoints: [],
		lists: [],
		starts: [],
		signals: [],
		waits: [],
	};
	// oxlint-disable-next-line no-unsafe-type-assertion -- a stub of a class with private fields; structural typing cannot satisfy it
	const armada: ArmadaClient = {
		submit: async (_id: string, spec: V1PodSpec, queue: string) => {
			recorded.submitted.push(queue);
			recorded.tokenHashes.push(
				spec.containers
					.flatMap((container: V1Container): V1EnvVar[] => container.env ?? [])
					.find((env: V1EnvVar): boolean => env.name === AGENT_TOKEN_HASH_ENV)?.value ?? '',
			);
			return { jobId: 'job-1', jobSetId: 'set-1', queue };
		},
		waitForRunning: async () => pod,
		portUrl: async (_job: unknown, port: number) => `http://172.18.0.3:${String(30000 + port)}`,
		cancel: async (job: { jobId: string }) => {
			recorded.cancelled.push(`job:${job.jobId}`);
		},
		cancelSet: async (jobSetId: string, queue: string) => {
			recorded.cancelled.push(`set:${jobSetId}@${queue}`);
		},
	} as unknown as ArmadaClient;
	const channel: ControlChannel = {
		ready: async (timeoutMs: number): Promise<void> => {
			recorded.readies.push(timeoutMs);
		},
		run: async (command: readonly string[], runOptions?: RunOptions): Promise<CommandResult> => {
			const call: ExecCall = {
				command,
				stdin: runOptions?.stdin,
				timeoutMs: runOptions?.timeoutMs,
			};
			recorded.calls.push(call);
			return typeof respond === 'function' ? respond(call) : respond;
		},
		stream: async (
			command: readonly string[],
			streamOptions?: StreamOptions,
		): Promise<ReadableStream<Uint8Array>> => {
			recorded.calls.push({ command, stdin: undefined, timeoutMs: streamOptions?.timeoutMs });
			return new ReadableStream<Uint8Array>({
				start(controller: ReadableStreamDefaultController<Uint8Array>) {
					controller.enqueue(new TextEncoder().encode('streamed'));
					controller.close();
				},
			});
		},
		writeFile: async (path: string, content: string | Uint8Array): Promise<void> => {
			recorded.writes.push({ path, content });
		},
		readFile: async (path: string) => {
			recorded.reads.push(path);
			return { outcome: 'ok', bytes: new Uint8Array() };
		},
		readFileBounded: async (path: string, budget: ReadBudget): Promise<ReadFileOutcome> => {
			recorded.boundedReads.push({ path, budget });
			return { outcome: 'ok', bytes: new Uint8Array() };
		},
		listFiles: async (path: string, recursive: boolean) => {
			recorded.lists.push({ path, recursive });
			return { outcome: 'ok', entries: [] };
		},
		startProcess: async (command: readonly string[], cwd?: string): Promise<number> => {
			recorded.starts.push({ command, cwd });
			return 4242;
		},
		processStatus: async () => ({ running: true }),
		signalProcess: async (pid: number, signal: string): Promise<void> => {
			recorded.signals.push({ pid, signal });
		},
		processLogs: async () => '',
		waitForPort: async (port: number, timeoutMs: number, pid?: number, probe?: PortProbe) => {
			recorded.waits.push({ port, timeoutMs, pid, probe });
			return { open: true };
		},
		...options.channel,
	};
	return {
		sandbox: new ArmadaSandbox(
			'sandbox-1',
			settings,
			armada,
			(endpoint: AgentEndpoint): ControlChannel => {
				recorded.endpoints.push(endpoint);
				return channel;
			},
			options.queues ?? new QueueDirectory(settings, undefined),
			options.placements ?? new Map(),
			options.owner === undefined ? undefined : { owner: options.owner },
		),
		...recorded,
	};
}

describe('the agent token', () => {
	it('is the same for every instance of a sandbox, as marimohub makes a new one per call', async () => {
		const first: Recorded & { sandbox: ArmadaSandbox } = stubSandbox();
		const second: Recorded & { sandbox: ArmadaSandbox } = stubSandbox();
		await first.sandbox.ready();
		await second.sandbox.ready();

		const token: string | undefined = first.endpoints[0]?.token;
		expect(token).toBe(agentToken('test-secret-of-at-least-32-characters', 'sandbox-1'));
		expect(second.endpoints[0]?.token).toBe(token);
		// The pod, submitted or deduped, carries the hash of that same token.
		const hash: string = createHash('sha256')
			.update(token ?? '')
			.digest('hex');
		expect([...first.tokenHashes, ...second.tokenHashes]).toEqual([hash, hash]);
	});

	it('differs between sandboxes and between secrets', () => {
		const secret = 'test-secret-of-at-least-32-characters';
		expect(agentToken(secret, 'sandbox-1')).not.toBe(agentToken(secret, 'sandbox-2'));
		expect(agentToken(secret, 'sandbox-1')).not.toBe(
			agentToken('another-secret-of-at-least-32-chars', 'sandbox-1'),
		);
	});
});

describe('placements', () => {
	it('lets a later instance reuse a reached sandbox after one health look, submitting nothing', async () => {
		const placements: Placements = new Map();
		const first: Recorded & { sandbox: ArmadaSandbox } = stubSandbox(ok, { placements });
		await first.sandbox.ready();
		const later: Recorded & { sandbox: ArmadaSandbox } = stubSandbox(ok, { placements });
		await later.sandbox.readFile('/work/notebook.py');

		expect(first.submitted).toHaveLength(1);
		expect(later.submitted).toEqual([]);
		expect(later.endpoints).toEqual([]);
		// The first instance's channel answered, with a single look at its health.
		expect(first.readies).toEqual([30_000, 0]);
		expect(first.reads).toEqual(['/work/notebook.py']);
	});

	it('resolves the sandbox again when the pod it knew no longer answers', async () => {
		const placements: Placements = new Map();
		const gone: Recorded & { sandbox: ArmadaSandbox } = stubSandbox(ok, {
			placements,
			channel: {
				ready: async (timeoutMs: number): Promise<void> => {
					if (timeoutMs === 0) throw new Error('no answer');
				},
			},
		});
		await gone.sandbox.ready();
		const later: Recorded & { sandbox: ArmadaSandbox } = stubSandbox(ok, { placements });
		await later.sandbox.ready();

		expect(later.submitted).toHaveLength(1);
		expect(later.endpoints).toHaveLength(1);
		expect(placements.size).toBe(1);
	});

	it('answers isPortReady for a sandbox another instance reached', async () => {
		const placements: Placements = new Map();
		const first: Recorded & { sandbox: ArmadaSandbox } = stubSandbox(ok, { placements });
		await first.sandbox.ready();

		expect(await stubSandbox(ok, { placements }).sandbox.isPortReady(8443)).toBe(true);
		expect(first.waits).toHaveLength(1);
	});

	it('forgets a sandbox once it is destroyed', async () => {
		const placements: Placements = new Map();
		const { sandbox } = stubSandbox(ok, { placements });
		await sandbox.ready();
		await sandbox.destroy();

		expect(placements.size).toBe(0);
	});
});

describe('destroy', () => {
	it('cancels the submitted job when this process submitted it', async () => {
		const { sandbox, cancelled } = stubSandbox();
		await sandbox.exec('echo hi'); // forces ready(), so a job exists
		await sandbox.destroy();

		expect(cancelled).toEqual(['job:job-1']);
	});

	it('cancels by job set when addressed by id alone, as the reconciler does', async () => {
		const { sandbox, cancelled } = stubSandbox();
		await sandbox.destroy();

		// The job set id is the sandbox id, so no job lookup is needed.
		expect(cancelled).toEqual(['set:sandbox-1@marimohub']);
	});
});

describe('writeFiles', () => {
	it('hands the path and the bytes to the agent, with no shell in between', async () => {
		const bytes: Uint8Array = new Uint8Array([0, 159, 146, 150]);
		const { sandbox, writes, calls } = stubSandbox();
		await sandbox.writeFiles([
			{ path: "/work/it's.py", content: 'print(1)\n' },
			{ path: '/work/blob.bin', content: bytes },
		]);

		// A quote in the path and raw bytes travel as-is: nothing to escape.
		expect(writes).toEqual([
			{ path: "/work/it's.py", content: 'print(1)\n' },
			{ path: '/work/blob.bin', content: bytes },
		]);
		expect(calls).toHaveLength(0);
	});

	it('does nothing for an empty set, not even submit the job', async () => {
		const { sandbox, writes } = stubSandbox();
		await sandbox.writeFiles([]);

		expect(writes).toHaveLength(0);
	});

	it('names the file and keeps the cause when a write fails', async () => {
		const { sandbox } = stubSandbox(ok, {
			channel: {
				writeFile: async () => {
					throw new Error('No space left');
				},
			},
		});
		expect(
			await rejection(sandbox.writeFiles([{ path: '/work/big.bin', content: 'x' }])),
		).toContain('Writing /work/big.bin failed: No space left');
	});
});

describe('setEnvVars', () => {
	it('replays vars as an export prefix on a later exec', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.setEnvVars({ API_KEY: 'secret' });
		await sandbox.setEnvVars({ HOME_DIR: '/work' }, { onlyIfUnset: true });
		await sandbox.exec('echo hi');

		expect(calls[0]?.command.slice(0, 2)).toEqual(['sh', '-lc']);
		expect(scriptOf(calls[0])).toBe(
			"export API_KEY='secret'; [ -n \"${HOME_DIR:-}\" ] || export HOME_DIR='/work'; echo hi",
		);
	});

	it('lets a forced value beat a later onlyIfUnset default for the same key', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.setEnvVars({ K: 'forced' });
		await sandbox.setEnvVars({ K: 'default' }, { onlyIfUnset: true });
		await sandbox.exec('run');

		expect(scriptOf(calls[0])).toBe(
			"export K='forced'; [ -n \"${K:-}\" ] || export K='default'; run",
		);
	});

	it('rejects a bad name at the set, not at the next exec', async () => {
		const { sandbox, calls } = stubSandbox();
		expect(await rejection(sandbox.setEnvVars({ 'A B': 'x' }))).toContain(
			'Invalid environment variable name',
		);

		await sandbox.exec('echo hi');
		expect(scriptOf(calls[0])).toBe('echo hi');
	});
});

describe('exposePort', () => {
	it('wraps the address Armada assigned in a URL, ignoring the hostname option', async () => {
		const { sandbox } = stubSandbox();
		const exposed: { url: string } = await sandbox.exposePort(2718, {
			hostname: 'ignored.example.com',
		});

		// 32718 proves the asked-for port reached portUrl.
		expect(exposed).toEqual({ url: 'http://172.18.0.3:32718' });
	});
});

describe('startProcess', () => {
	it('starts through the agent with cwd and layered env, in a login shell', async () => {
		const { sandbox, starts } = stubSandbox();
		await sandbox.setEnvVars({ SANDBOX_VAR: 'a' });
		const started: SandboxProcess = await sandbox.startProcess('marimo run', {
			cwd: '/work',
			env: { PROC_VAR: 'b', DROPPED: undefined },
		});

		// Sandbox-wide vars first, per-process vars after, so the process wins.
		expect(starts[0]).toEqual({
			command: ['sh', '-lc', "export SANDBOX_VAR='a'; export PROC_VAR='b'; marimo run"],
			cwd: '/work',
		});
		expect(started.id).toBe('armada-proc-4242');
		expect(started.command).toBe('marimo run');

		const named: SandboxProcess = await sandbox.startProcess('marimo run', {
			processId: 'kernel',
		});
		expect(named.id).toBe('kernel');
	});

	it('names the command when the agent cannot start it', async () => {
		const { sandbox } = stubSandbox(ok, {
			channel: {
				startProcess: async () => {
					throw new Error('cannot start sh: not found');
				},
			},
		});
		expect(await rejection(sandbox.startProcess('marimo run'))).toContain(
			'Starting "marimo run" failed: cannot start sh: not found',
		);
	});

	it('signals the pid the agent named, defaulting to TERM', async () => {
		const { sandbox, signals } = stubSandbox();
		const started: SandboxProcess = await sandbox.startProcess('sleep 1000');
		await started.kill();
		await started.kill('KILL');

		expect(signals).toEqual([
			{ pid: 4242, signal: 'TERM' },
			{ pid: 4242, signal: 'KILL' },
		]);
	});

	it('treats a kill the channel refused as done, since killing is best effort', async () => {
		const { sandbox } = stubSandbox(ok, {
			channel: {
				signalProcess: async () => {
					throw new Error('agent unreachable');
				},
			},
		});
		const started: SandboxProcess = await sandbox.startProcess('sleep 1000');
		await started.kill();
	});

	it('reads the process log back from the agent', async () => {
		const { sandbox } = stubSandbox(ok, {
			channel: { processLogs: async () => 'kernel output' },
		});
		const started: SandboxProcess = await sandbox.startProcess('marimo run');

		expect(await started.getLogs()).toEqual({ stdout: 'kernel output', stderr: '' });
	});

	it('waits for the port in one request that also watches the process', async () => {
		const { sandbox, waits } = stubSandbox();
		const started: SandboxProcess = await sandbox.startProcess('marimo run');
		await started.waitForPort(2718);
		await started.waitForPort(8080, { timeout: 5_000 });

		expect(waits).toEqual([
			{ port: 2718, timeoutMs: 30_000, pid: 4242, probe: undefined },
			{ port: 8080, timeoutMs: 5_000, pid: 4242, probe: undefined },
		]);
	});

	it('reports a dead process as a crash carrying its log, not a timeout', async () => {
		const { sandbox } = stubSandbox(ok, {
			channel: {
				waitForPort: async () => ({ open: false, exited: true, exitCode: 1 }),
				processLogs: async () => 'Traceback: boom',
			},
		});
		const started: SandboxProcess = await sandbox.startProcess('marimo run');

		const message: string = await rejection(started.waitForPort(2718, { timeout: 100 }));
		expect(message).toContain('process exited before port 2718 opened');
		expect(message).toContain('Traceback: boom');
	});

	it('times out with the log when the process lives but the port never opens', async () => {
		const { sandbox } = stubSandbox(ok, {
			channel: {
				waitForPort: async () => ({ open: false }),
				processLogs: async () => 'still starting',
			},
		});
		const started: SandboxProcess = await sandbox.startProcess('marimo run');

		const message: string = await rejection(started.waitForPort(2718, { timeout: 50 }));
		expect(message).toContain('timed out waiting for port 2718');
		expect(message).toContain('still starting');
	});
});

describe('readFile', () => {
	it('reports bytes that decode as text with the utf-8 encoding', async () => {
		const { sandbox } = stubSandbox(ok, {
			channel: {
				readFile: async () => ({
					outcome: 'ok',
					bytes: new TextEncoder().encode('print(1)\n'),
				}),
			},
		});
		const result: ReadFileResult = await sandbox.readFile("/work/it's.py");

		expect(result).toEqual({ success: true, content: 'print(1)\n', encoding: 'utf-8' });
	});

	it('returns bytes that are not UTF-8 as base64, so nothing is corrupted', async () => {
		const bytes: Uint8Array = new Uint8Array([0, 159, 146, 150]);
		const { sandbox } = stubSandbox(ok, {
			channel: { readFile: async () => ({ outcome: 'ok', bytes }) },
		});
		const result: ReadFileResult = await sandbox.readFile('/work/blob.bin');

		expect(result).toEqual({
			success: true,
			content: Buffer.from(bytes).toString('base64'),
			encoding: 'base64',
		});
		expect(result.success && Buffer.from(result.content, 'base64')).toEqual(Buffer.from(bytes));
	});

	it('keeps a byte order mark rather than swallowing it', async () => {
		const withBom: Uint8Array = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
		const { sandbox } = stubSandbox(ok, {
			channel: { readFile: async () => ({ outcome: 'ok', bytes: withBom }) },
		});
		const result: ReadFileResult = await sandbox.readFile('/work/bom.txt');

		expect(result.success && result.content).toBe('﻿a');
	});

	it('reads an empty file as empty text, and sends the path as-is', async () => {
		const { sandbox, reads } = stubSandbox();
		const result: ReadFileResult = await sandbox.readFile("/work/it's empty.py");

		expect(result).toEqual({ success: true, content: '', encoding: 'utf-8' });
		// The path went to the agent verbatim; there is no quoting to get wrong.
		expect(reads).toEqual(["/work/it's empty.py"]);
	});

	it('separates a path that is not there from one that cannot be read', async () => {
		const { sandbox: absent } = stubSandbox(ok, {
			channel: { readFile: async () => ({ outcome: 'not-found' }) },
		});
		expect(await absent.readFile('/work/missing.py')).toEqual({
			success: false,
			content: '',
			error: { code: 'NOT_FOUND' },
		});

		const { sandbox: unreadable } = stubSandbox(ok, {
			channel: { readFile: async () => ({ outcome: 'failed', message: 'is a directory' }) },
		});
		expect(await unreadable.readFile('/work')).toEqual({
			success: false,
			content: '',
			error: { code: 'READ_FAILED' },
		});
	});

	it('reports a broken control channel as a backend error, never a throw', async () => {
		const { sandbox } = stubSandbox(ok, {
			channel: {
				readFile: async () => {
					throw new Error('agent unreachable');
				},
			},
		});
		expect(await sandbox.readFile('/work/notebook.py')).toEqual({
			success: false,
			content: '',
			error: { code: 'BACKEND_ERROR' },
		});
	});
});

describe('readFileBounded', () => {
	const budget: { maxBytes: number; timeoutMs: number } = { maxBytes: 1024, timeoutMs: 10_000 };

	it('reports the bytes as base64 whatever they are, and sends the budget', async () => {
		const bytes: Uint8Array = new TextEncoder().encode('print(1)\n');
		const { sandbox, boundedReads } = stubSandbox(ok, {
			channel: {
				readFileBounded: async (path: string, sent: ReadBudget): Promise<ReadFileOutcome> => {
					boundedReads.push({ path, budget: sent });
					return { outcome: 'ok', bytes };
				},
			},
		});
		const result: ReadFileResult = await sandbox.readFileBounded("/work/it's.py", budget);

		expect(result).toEqual({
			success: true,
			content: Buffer.from(bytes).toString('base64'),
			encoding: 'base64',
		});
		expect(boundedReads).toEqual([{ path: "/work/it's.py", budget }]);
	});

	it('rounds a fractional deadline up, as the port says', async () => {
		const { sandbox, boundedReads } = stubSandbox();
		await sandbox.readFileBounded('/work/notebook.py', { maxBytes: 0, timeoutMs: 0.5 });

		expect(boundedReads[0]?.budget).toEqual({ maxBytes: 0, timeoutMs: 1 });
	});

	it('refuses an invalid budget with no request to the agent, nor a submit', async () => {
		const { sandbox, calls, reads, boundedReads, submitted } = stubSandbox();
		const legacyRead: Mock<typeof sandbox.readFile> = spyOn(sandbox, 'readFile');
		const exec: Mock<typeof sandbox.exec> = spyOn(sandbox, 'exec');
		// upstream's contract cases (computeContract.ts, "bounded reads reject invalid budgets"), then the rest of the port's bounds
		for (const options of [
			{ maxBytes: -1, timeoutMs: 100 },
			{ maxBytes: Number.NaN, timeoutMs: 100 },
			{ maxBytes: Infinity, timeoutMs: 100 },
			{ maxBytes: 10, timeoutMs: 0 },
			{ maxBytes: 1.5, timeoutMs: 100 },
			{ maxBytes: Number.MAX_SAFE_INTEGER, timeoutMs: 100 },
			{ maxBytes: 10, timeoutMs: -1 },
			{ maxBytes: 10, timeoutMs: Number.NaN },
			{ maxBytes: 10, timeoutMs: Infinity },
			{ maxBytes: 10, timeoutMs: 2 ** 31 },
		]) {
			// oxlint-disable-next-line no-await-in-loop -- one case at a time keeps a failure readable
			expect(await sandbox.readFileBounded('/work/notebook.py', options)).toEqual({
				success: false,
				content: '',
				error: { code: 'READ_FAILED' },
			});
		}
		expect(boundedReads).toEqual([]);
		expect(reads).toEqual([]);
		expect(calls).toEqual([]);
		expect(submitted).toEqual([]);
		expect(legacyRead).not.toHaveBeenCalled();
		expect(exec).not.toHaveBeenCalled();
	});

	it('accepts the edges of a valid budget', async () => {
		const { sandbox, boundedReads } = stubSandbox();
		await sandbox.readFileBounded('/work/a', { maxBytes: 0, timeoutMs: 2 ** 31 - 1 });

		expect(boundedReads).toHaveLength(1);
	});

	it('maps absent, refused and unreachable as readFile does', async () => {
		const { sandbox: absent } = stubSandbox(ok, {
			channel: { readFileBounded: async () => ({ outcome: 'not-found' }) },
		});
		expect(await absent.readFileBounded('/work/missing.py', budget)).toEqual({
			success: false,
			content: '',
			error: { code: 'NOT_FOUND' },
		});

		const { sandbox: refused } = stubSandbox(ok, {
			channel: {
				readFileBounded: async () => ({ outcome: 'failed', message: 'is a symlink' }),
			},
		});
		expect(await refused.readFileBounded('/work/link.py', budget)).toEqual({
			success: false,
			content: '',
			error: { code: 'READ_FAILED' },
		});

		const { sandbox: unreachable } = stubSandbox(ok, {
			channel: {
				readFileBounded: async () => {
					throw new Error('agent unreachable');
				},
			},
		});
		expect(await unreachable.readFileBounded('/work/notebook.py', budget)).toEqual({
			success: false,
			content: '',
			error: { code: 'BACKEND_ERROR' },
		});
	});
});

describe('failed reads', () => {
	const budget: { maxBytes: number; timeoutMs: number } = { maxBytes: 1024, timeoutMs: 10_000 };

	it('log one line naming the path and reason when the agent refuses', async () => {
		const { sandbox } = stubSandbox(ok, {
			channel: {
				readFile: async () => ({ outcome: 'failed', message: 'HTTP 500: permission denied' }),
				readFileBounded: async () => ({ outcome: 'failed', message: 'HTTP 500: is a symlink' }),
			},
		});
		await sandbox.readFile('/work/notebook.py');
		await sandbox.readFileBounded('/work/pyproject.toml', budget);

		expect(logged()).toEqual([
			'marimohub-compute-armada: sandbox sandbox-1 could not read /work/notebook.py (READ_FAILED): HTTP 500: permission denied',
			'marimohub-compute-armada: sandbox sandbox-1 could not read /work/pyproject.toml (READ_FAILED): HTTP 500: is a symlink',
		]);
	});

	it('log one line when the agent cannot be reached, without the token', async () => {
		const box: Recorded & { sandbox: ArmadaSandbox } = stubSandbox(ok, {
			channel: {
				readFileBounded: async () => {
					// A transport error that quoted the request's header.
					throw new Error(
						`connection reset (Authorization: Bearer ${box.endpoints[0]?.token ?? ''})`,
					);
				},
			},
		});
		await box.sandbox.readFileBounded('/work/notebook.py', budget);

		const token: string = box.endpoints[0]?.token ?? '';
		expect(token).not.toBe('');
		expect(logged()).toEqual([
			'marimohub-compute-armada: sandbox sandbox-1 could not read /work/notebook.py (BACKEND_ERROR): connection reset (Authorization: Bearer <token>)',
		]);
		expect(logged().join('\n')).not.toContain(token);
	});

	it('log one line for a budget refused before any request', async () => {
		const { sandbox } = stubSandbox();
		await sandbox.readFileBounded('/work/notebook.py', { maxBytes: -1, timeoutMs: 100 });

		expect(logged()).toHaveLength(1);
		expect(logged()[0]).toContain('could not read /work/notebook.py (READ_FAILED)');
	});

	it('stay quiet for a path that is not there, and for a read that worked', async () => {
		const { sandbox } = stubSandbox(ok, {
			channel: {
				readFile: async () => ({ outcome: 'not-found' }),
				readFileBounded: async () => ({ outcome: 'not-found' }),
			},
		});
		await sandbox.readFile('/work/__marimo__/notebook.html');
		await sandbox.readFileBounded('/work/__marimo__/notebook.html', budget);
		await stubSandbox().sandbox.readFileBounded('/work/notebook.py', budget);

		expect(logged()).toEqual([]);
	});
});

describe('listFiles', () => {
	it('maps the agent entries to FileInfo records', async () => {
		const { sandbox } = stubSandbox(ok, {
			channel: {
				listFiles: async () => ({
					outcome: 'ok',
					entries: [
						{ path: '/work/notebook.py', type: 'file', size: 12 },
						{ path: '/work/data', type: 'directory', size: 4096 },
						{ path: '/work/link', type: 'symlink', size: 7 },
					],
				}),
			},
		});
		const result: ListFilesResult = await sandbox.listFiles('/work');

		expect(result.success).toBe(true);
		expect(result.files[0]).toEqual({
			name: 'notebook.py',
			absolutePath: '/work/notebook.py',
			relativePath: 'notebook.py',
			type: 'file',
			size: 12,
		});
		expect(result.files.map((file: FileInfo) => file.type)).toEqual([
			'file',
			'directory',
			'symlink',
		]);
	});

	it('filters hidden entries by their own name alone', async () => {
		const { sandbox } = stubSandbox(ok, {
			channel: {
				listFiles: async () => ({
					outcome: 'ok',
					entries: [
						{ path: '/work/.env', type: 'file', size: 1 },
						{ path: '/work/notebook.py', type: 'file', size: 2 },
						// Inside a dot directory, but not itself hidden: reported, which
						// is what session capture needs for `__marimo__` trees.
						{ path: '/work/.marimo/session.json', type: 'file', size: 3 },
					],
				}),
			},
		});
		const hidden: ListFilesResult = await sandbox.listFiles('/work', { recursive: true });
		expect(hidden.files.map((file: FileInfo) => file.name)).toEqual([
			'notebook.py',
			'session.json',
		]);

		const shown: ListFilesResult = await sandbox.listFiles('/work', {
			recursive: true,
			includeHidden: true,
		});
		expect(shown.files.map((file: FileInfo) => file.name)).toEqual([
			'.env',
			'notebook.py',
			'session.json',
		]);
	});

	it('reports a path outside the root as its own relative path', async () => {
		const { sandbox } = stubSandbox(ok, {
			channel: {
				listFiles: async () => ({
					outcome: 'ok',
					entries: [{ path: '/elsewhere/x.py', type: 'file', size: 1 }],
				}),
			},
		});
		const result: ListFilesResult = await sandbox.listFiles('/work');
		expect(result.files[0]?.relativePath).toBe('/elsewhere/x.py');
	});

	it('reports a file as NOT_A_DIRECTORY, never as an empty directory', async () => {
		const { sandbox } = stubSandbox(ok, {
			channel: { listFiles: async () => ({ outcome: 'not-a-directory' }) },
		});
		expect(await sandbox.listFiles('/work/notebook.py')).toEqual({
			success: false,
			files: [],
			error: { code: 'NOT_A_DIRECTORY' },
		});
	});

	it('reports a listing the agent refused as a failed listing', async () => {
		const { sandbox } = stubSandbox(ok, {
			channel: { listFiles: async () => ({ outcome: 'failed', message: 'no such directory' }) },
		});
		expect(await sandbox.listFiles('/work/missing')).toEqual({
			success: false,
			files: [],
			error: { code: 'LIST_FAILED' },
		});
	});

	it('reports a broken control channel as a backend error, never a throw', async () => {
		const { sandbox } = stubSandbox(ok, {
			channel: {
				listFiles: async () => {
					throw new Error('agent unreachable');
				},
			},
		});
		expect(await sandbox.listFiles('/work')).toEqual({
			success: false,
			files: [],
			error: { code: 'BACKEND_ERROR' },
		});
	});

	it('reads an empty directory as a success, sending the path and recursion flag', async () => {
		const { sandbox, lists } = stubSandbox();
		expect(await sandbox.listFiles('/work')).toEqual({ success: true, files: [] });
		await sandbox.listFiles('/work', { recursive: true });

		expect(lists).toEqual([
			{ path: '/work', recursive: false },
			{ path: '/work', recursive: true },
		]);
	});
});

describe('exec', () => {
	it('runs in a login shell, so a profile-provided PATH reaches user code', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.exec('uv run marimo --version');

		expect(calls[0]?.command).toEqual(['sh', '-lc', 'uv run marimo --version']);
	});

	it('passes the caller timeout to the agent, which enforces it', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.exec('sleep 60', { timeout: 1_000 });

		expect(calls[0]?.timeoutMs).toBe(1_000);
	});

	it('reports a timed-out command as the channel words it', async () => {
		const { sandbox } = stubSandbox(() => {
			throw new CommandTimeoutError('Command timed out after 1000ms in default/armada-job-0: x');
		});
		const result: ExecResult = await sandbox.exec('sleep 60', { timeout: 1_000 });

		expect(result.success).toBe(false);
		expect(!result.success && result.error.code).toBe('BACKEND_ERROR');
		expect(result.stderr).toContain('Command timed out after 1000ms');
	});
});

describe('the exec backstop', () => {
	it('sends ARMADA_COMMAND_MAX_SECONDS as the deadline when the caller has none', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.exec('uv sync');

		// Most of marimohub's exec calls carry no timeout; without this, one of
		// them losing its caller would hold a process for the rest of the session.
		expect(calls[0]?.timeoutMs).toBe(21_600_000);
	});

	it('sends no deadline at all when the backstop is off', async () => {
		const { sandbox, calls } = stubSandbox(ok, {
			env: { ARMADA_COMMAND_MAX_SECONDS: '0' },
		});
		await sandbox.exec('uv sync');

		expect(calls[0]?.timeoutMs).toBeUndefined();
	});

	it('names the backstop, not a timeout nobody set, when it fires', async () => {
		const { sandbox } = stubSandbox(
			() => {
				throw new CommandTimeoutError('Command timed out after 1000ms in default/armada-job-0: x');
			},
			{ env: { ARMADA_COMMAND_MAX_SECONDS: '1' } },
		);
		const result: ExecResult = await sandbox.exec('uv sync');

		expect(result.success).toBe(false);
		expect(result.stderr).toContain('ARMADA_COMMAND_MAX_SECONDS (1s)');
		expect(result.stderr).toContain('uv sync');
	});
});

describe('gitCheckout', () => {
	it('runs the quoted clone through the ordinary exec path', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.setEnvVars({ GIT_TOKEN: 'secret' });
		await sandbox.gitCheckout('https://x/y', { branch: 'main', targetDir: 'w' });

		// A login shell with the env prefix: git and its credential helpers see
		// what any other user command sees.
		expect(calls[0]?.command.slice(0, 2)).toEqual(['sh', '-lc']);
		expect(scriptOf(calls[0])).toBe(
			"export GIT_TOKEN='secret'; git clone --branch 'main' 'https://x/y' 'w'",
		);
	});

	it('quotes a hostile repo and target, so nothing injects', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.gitCheckout('https://x/y; rm -rf /', { targetDir: '$(touch pwn)' });

		expect(scriptOf(calls[0])).toBe("git clone 'https://x/y; rm -rf /' '$(touch pwn)'");
	});

	it('throws with stderr when the clone fails', async () => {
		const { sandbox } = stubSandbox({
			stdout: '',
			stderr: "fatal: repository 'https://x/y' not found",
			exitCode: 128,
		});
		expect(await rejection(sandbox.gitCheckout('https://x/y'))).toContain(
			"git checkout failed: fatal: repository 'https://x/y' not found",
		);
	});
});

/** Everything a stream yields, decoded. */
async function collect(stream: ReadableStream): Promise<string> {
	return new Response(stream).text();
}

describe('execStream', () => {
	it('streams the command through a login shell with the env prefix', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.setEnvVars({ API_KEY: 'secret' });
		const stream: ReadableStream = await sandbox.execStream('tail -f /tmp/log');

		expect(calls[0]?.command).toEqual(['sh', '-lc', "export API_KEY='secret'; tail -f /tmp/log"]);
		expect(await collect(stream)).toBe('streamed');
	});

	it('passes a timeout down as the listening bound', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.execStream('tail -f /tmp/log', { timeout: 5_000 });

		expect(calls[0]?.timeoutMs).toBe(5_000);
	});

	it('sends no timeout when none was asked for', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.execStream('cat /tmp/log');

		expect(calls[0]?.timeoutMs).toBeUndefined();
	});
});

describe('queue', () => {
	const mapped: Record<string, string> = {
		ARMADA_LOOKOUT_URL: 'http://lookout.example.com',
		ARMADA_QUEUE_BY_USER: '{"user-a": "team-a"}',
		ARMADA_QUEUE_BY_PROJECT: '{"proj-b": "team-b"}',
	};

	it('submits to the queue the owner maps to', async () => {
		const { sandbox, submitted } = stubSandbox(ok, {
			env: mapped,
			owner: { projectId: 'proj-b', userId: 'user-x' },
		});
		await sandbox.exec('true');
		expect(submitted).toEqual(['team-b']);
	});

	it('submits to the default queue for an owner that maps nowhere', async () => {
		const { sandbox, submitted } = stubSandbox(ok, { env: mapped, owner: { projectId: 'proj-x' } });
		await sandbox.exec('true');
		expect(submitted).toEqual(['marimohub']);
	});

	it('cancels by id in the queue the directory remembers, as after listActive', async () => {
		const queues: QueueDirectory = new QueueDirectory(
			readConfig({ ...baseEnv, ...mapped }),
			undefined,
		);
		queues.remember('sandbox-1', 'team-a');
		const { sandbox, cancelled } = stubSandbox(ok, { env: mapped, queues });
		await sandbox.destroy();
		expect(cancelled).toEqual(['set:sandbox-1@team-a']);
	});

	it('asks Lookout for the queue of a sandbox nobody named, then cancels there', async () => {
		const asked: string[] = [];
		const queues: QueueDirectory = new QueueDirectory(
			readConfig({ ...baseEnv, ...mapped }),
			async (id: string) => {
				asked.push(id);
				return 'team-b';
			},
		);
		const { sandbox, cancelled } = stubSandbox(ok, { env: mapped, queues });
		await sandbox.destroy();
		expect(asked).toEqual(['sandbox-1']);
		expect(cancelled).toEqual(['set:sandbox-1@team-b']);
	});

	it('cancels where Lookout says the job is, not where the owner maps to now', async () => {
		const queues: QueueDirectory = new QueueDirectory(
			readConfig({ ...baseEnv, ...mapped }),
			async () => 'team-a',
		);
		const { sandbox, cancelled } = stubSandbox(ok, {
			env: mapped,
			queues,
			owner: { projectId: 'proj-b' },
		});
		await sandbox.destroy();
		expect(cancelled).toEqual(['set:sandbox-1@team-a']);
	});

	it('fails a destroy and a start rather than guess when Lookout cannot be asked', async () => {
		const queues: QueueDirectory = new QueueDirectory(
			readConfig({ ...baseEnv, ...mapped }),
			async () => {
				throw new Error('connect ECONNREFUSED');
			},
		);
		const { sandbox, cancelled, submitted } = stubSandbox(ok, { env: mapped, queues });
		expect(await rejection(sandbox.destroy())).toContain('Lookout did not answer');
		// `exec` reports a backend failure instead of throwing; a write throws.
		expect(await rejection(sandbox.writeFiles([{ path: '/w/a', content: 'x' }]))).toContain(
			'Lookout did not answer',
		);
		expect(cancelled).toEqual([]);
		expect(submitted).toEqual([]);
	});

	it('forgets the queue once the sandbox is destroyed', async () => {
		const asked: string[] = [];
		const queues: QueueDirectory = new QueueDirectory(
			readConfig({ ...baseEnv, ...mapped }),
			async (id: string) => {
				asked.push(id);
				return 'team-a';
			},
		);
		queues.remember('sandbox-1', 'team-a');
		const { sandbox } = stubSandbox(ok, { env: mapped, queues });
		await sandbox.destroy();
		expect(await queues.resolve('sandbox-1', undefined)).toBe('team-a');
		expect(asked).toEqual(['sandbox-1']);
	});
});

describe('port readiness', () => {
	it('passes a surface readiness probe (http mode and path) to the agent', async () => {
		const { sandbox, waits } = stubSandbox();
		const started: SandboxProcess = await sandbox.startProcess('code-server');
		await started.waitForPort(8443, { mode: 'http', path: '/healthz', timeout: 5_000 });
		expect(waits).toEqual([
			{ port: 8443, timeoutMs: 5_000, pid: 4242, probe: { mode: 'http', path: '/healthz' } },
		]);
	});

	it('sends no probe for a plain wait, so the agent defaults to tcp', async () => {
		const { sandbox, waits } = stubSandbox();
		const started: SandboxProcess = await sandbox.startProcess('marimo edit');
		await started.waitForPort(2718, { timeout: 1_000 });
		expect(waits[0]?.probe).toBeUndefined();
	});

	it('isPortReady is one http look (a zero wait), with no process to watch', async () => {
		const { sandbox, waits } = stubSandbox();
		await sandbox.exec('true'); // reaches the agent, as the surface manager's exec does first
		expect(await sandbox.isPortReady(8443, { path: '/healthz' })).toBe(true);
		expect(waits).toEqual([
			{ port: 8443, timeoutMs: 0, pid: undefined, probe: { mode: 'http', path: '/healthz' } },
		]);
	});

	it('isPortReady is false when the port is closed or the agent cannot be asked', async () => {
		const closed: { sandbox: ArmadaSandbox } = stubSandbox(ok, {
			channel: { waitForPort: async () => ({ open: false }) },
		});
		await closed.sandbox.exec('true');
		expect(await closed.sandbox.isPortReady(8443)).toBe(false);

		const unreachable: { sandbox: ArmadaSandbox } = stubSandbox(ok, {
			channel: {
				waitForPort: async () => {
					throw new Error('agent gone');
				},
			},
		});
		await unreachable.sandbox.exec('true');
		expect(await unreachable.sandbox.isPortReady(8443)).toBe(false);
	});

	it('isPortReady is false, and submits nothing, for a sandbox this process has not reached', async () => {
		const { sandbox, submitted, waits } = stubSandbox();
		expect(await sandbox.isPortReady(8443, { path: '/healthz' })).toBe(false);
		expect(submitted).toEqual([]);
		expect(waits).toEqual([]);
	});
});
