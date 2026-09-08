import { describe, expect, it } from 'bun:test';
import type { ArmadaClient, PodLocation } from '../src/armada.js';
import { readConfig } from '../src/config.js';
import type { ArmadaConfig } from '../src/config.js';
import { CommandTimeoutError } from '../src/channel.js';
import type { CommandResult, ControlChannel, RunOptions, StreamOptions } from '../src/channel.js';
import { ArmadaSandbox } from '../src/sandbox.js';
import type {
	ExecResult,
	FileInfo,
	ListFilesResult,
	ReadFileResult,
	SandboxProcess,
} from '../src/types.js';

const baseEnv: Record<string, string> = {
	ARMADA_URL: 'http://armada.example.com/',
	ARMADA_QUEUE: 'marimohub',
	MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
	ARMADA_AGENT_IMAGE: 'ghcr.io/example/kernel-agent:1',
};

const pod: PodLocation = {
	clusterId: 'Cluster1',
	podName: 'armada-job-0',
	podNamespace: 'default',
};

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
	cancelled: string[];
	writes: { path: string; content: string | Uint8Array }[];
	reads: string[];
	lists: { path: string; recursive: boolean }[];
	starts: { command: readonly string[]; cwd: string | undefined }[];
	signals: { pid: number; signal: string }[];
	waits: { port: number; timeoutMs: number; pid: number | undefined }[];
}

/** A sandbox whose job is "already placed" and whose channel calls are recorded. */
function stubSandbox(
	respond:
		| CommandResult
		| ((call: ExecCall) => CommandResult)
		| ((call: ExecCall) => Promise<CommandResult>) = ok,
	options: { env?: Record<string, string>; channel?: Partial<ControlChannel> } = {},
): Recorded & { sandbox: ArmadaSandbox } {
	const settings: ArmadaConfig = readConfig({ ...baseEnv, ...options.env });
	const recorded: Recorded = {
		calls: [],
		cancelled: [],
		writes: [],
		reads: [],
		lists: [],
		starts: [],
		signals: [],
		waits: [],
	};
	// oxlint-disable-next-line no-unsafe-type-assertion -- a stub of a class with private fields; structural typing cannot satisfy it
	const armada: ArmadaClient = {
		submit: async () => ({ jobId: 'job-1', jobSetId: 'set-1' }),
		waitForRunning: async () => pod,
		portUrl: async (_job: unknown, port: number) => `http://172.18.0.3:${String(30000 + port)}`,
		cancel: async (job: { jobId: string }) => {
			recorded.cancelled.push(`job:${job.jobId}`);
		},
		cancelSet: async (jobSetId: string) => {
			recorded.cancelled.push(`set:${jobSetId}`);
		},
	} as unknown as ArmadaClient;
	const channel: ControlChannel = {
		ready: async (): Promise<void> => {},
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
		waitForPort: async (port: number, timeoutMs: number, pid?: number) => {
			recorded.waits.push({ port, timeoutMs, pid });
			return { open: true };
		},
		...options.channel,
	};
	return {
		sandbox: new ArmadaSandbox('sandbox-1', settings, armada, () => channel),
		...recorded,
	};
}

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
		expect(cancelled).toEqual(['set:sandbox-1']);
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
			{ port: 2718, timeoutMs: 30_000, pid: 4242 },
			{ port: 8080, timeoutMs: 5_000, pid: 4242 },
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
