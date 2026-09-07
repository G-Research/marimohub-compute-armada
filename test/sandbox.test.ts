import { beforeAll, describe, expect, it } from 'bun:test';
import type { ArmadaClient, PodLocation } from '../src/armada.js';
import { readConfig } from '../src/config.js';
import type { ArmadaConfig } from '../src/config.js';
import type { CommandResult, ControlChannel, RunOptions, StreamOptions } from '../src/channel.js';
import { ArmadaSandbox } from '../src/sandbox.js';
import { shellQuote } from '../src/shell.js';
import type { FileInfo, ListFilesResult, ReadFileResult, SandboxProcess } from '../src/types.js';

const config: ArmadaConfig = readConfig({
	ARMADA_URL: 'http://armada.example.com/',
	ARMADA_QUEUE: 'marimohub',
	MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
	ARMADA_AGENT_IMAGE: 'ghcr.io/example/kernel-agent:1',
});

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

/**
 * The command inside the process-group wrapper, as the pod's shell runs it.
 * Every exec is wrapped now, so the prologue is noise for most assertions.
 */
function scriptOf(call: ExecCall | undefined): string {
	return (call?.command.at(-1) ?? '').replace(/^trap 'rm -f \S+' EXIT; echo \$\$ > \S+; /, '');
}

/** A sandbox whose job is "already placed" and whose execs are recorded. */
function stubSandbox(
	respond:
		| CommandResult
		| ((call: ExecCall) => CommandResult)
		| ((call: ExecCall) => Promise<CommandResult>) = ok,
	env: Record<string, string> = {},
): {
	sandbox: ArmadaSandbox;
	calls: ExecCall[];
	cancelled: string[];
} {
	const settings: ArmadaConfig =
		Object.keys(env).length === 0
			? config
			: readConfig({
					ARMADA_URL: 'http://armada.example.com/',
					ARMADA_QUEUE: 'marimohub',
					MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
					ARMADA_AGENT_IMAGE: 'ghcr.io/example/kernel-agent:1',
					...env,
				});
	const calls: ExecCall[] = [];
	const cancelled: string[] = [];
	// oxlint-disable-next-line no-unsafe-type-assertion -- a stub of a class with private fields; structural typing cannot satisfy it
	const armada: ArmadaClient = {
		submit: async () => ({ jobId: 'job-1', jobSetId: 'set-1' }),
		waitForRunning: async () => pod,
		ingressAddress: async (_job: unknown, port: number) => `172.18.0.3:${String(30000 + port)}`,
		cancel: async (job: { jobId: string }) => {
			cancelled.push(`job:${job.jobId}`);
		},
		cancelSet: async (jobSetId: string) => {
			cancelled.push(`set:${jobSetId}`);
		},
	} as unknown as ArmadaClient;
	const channel: ControlChannel = {
		ready: async (): Promise<void> => {},
		run: async (command: readonly string[], options?: RunOptions): Promise<CommandResult> => {
			const call: ExecCall = { command, stdin: options?.stdin, timeoutMs: options?.timeoutMs };
			calls.push(call);
			// What AgentChannel.run does when the deadline passes.
			if (options?.timeoutMs !== undefined && options.onStop !== undefined) {
				await options.onStop();
			}
			return typeof respond === 'function' ? respond(call) : respond;
		},
		stream: async (
			command: readonly string[],
			options?: StreamOptions,
		): Promise<ReadableStream<Uint8Array>> => {
			calls.push({ command, stdin: undefined, timeoutMs: options?.timeoutMs });
			return new ReadableStream<Uint8Array>({
				start(controller: ReadableStreamDefaultController<Uint8Array>) {
					controller.enqueue(new TextEncoder().encode('streamed'));
					controller.close();
				},
				// What AgentChannel.stream does with a cancel.
				async cancel() {
					await options?.onStop?.();
				},
			});
		},
	};
	return {
		sandbox: new ArmadaSandbox('sandbox-1', settings, armada, () => channel),
		calls,
		cancelled,
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
	it('creates the parent and streams content over stdin, never the command line', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.writeFiles([{ path: "/work/it's.py", content: 'print(1)\n' }]);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.command).toEqual([
			'sh',
			'-c',
			"mkdir -p -- '/work' && cat > '/work/it'\\''s.py'",
		]);
		expect(calls[0]?.stdin).toBe('print(1)\n');
	});

	it('passes bytes through without stringifying them', async () => {
		const bytes: Uint8Array = new Uint8Array([0, 159, 146, 150]);
		const { sandbox, calls } = stubSandbox();
		await sandbox.writeFiles([{ path: '/work/blob.bin', content: bytes }]);

		expect(calls[0]?.stdin).toBe(bytes);
	});

	it('skips mkdir when there is no parent to create', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.writeFiles([{ path: 'notebook.py', content: '' }]);

		expect(calls[0]?.command).toEqual(['sh', '-c', "cat > 'notebook.py'"]);
	});

	it('does nothing for an empty set, not even submit the job', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.writeFiles([]);

		expect(calls).toHaveLength(0);
	});

	it('names the file and keeps stderr when a write fails', async () => {
		const { sandbox } = stubSandbox({ stdout: '', stderr: 'No space left', exitCode: 1 });
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

		// 32718 proves the asked-for port reached ingressAddress.
		expect(exposed).toEqual({ url: 'http://172.18.0.3:32718' });
	});
});

/** Result whose stdout is the echoed PID of the detached process. */
const pidEcho: CommandResult = { stdout: '4242\n', stderr: '', exitCode: 0 };

describe('startProcess', () => {
	it('launches detached with cwd and layered env, and parses the pid', async () => {
		const { sandbox, calls } = stubSandbox(pidEcho);
		await sandbox.setEnvVars({ SANDBOX_VAR: 'a' });
		const started: SandboxProcess = await sandbox.startProcess('marimo run', {
			cwd: '/work',
			env: { PROC_VAR: 'b', DROPPED: undefined },
		});

		const launch: readonly string[] = calls[0]?.command ?? [];
		expect(launch[0]).toBe('sh');
		expect(launch[1]).toBe('-c');
		const logFile: string = /\/tmp\/mh-proc-\d+\.log/.exec(launch[2] ?? '')?.[0] ?? '';
		// Sandbox-wide vars first, per-process vars after, so the process wins.
		const inner = "export SANDBOX_VAR='a'; export PROC_VAR='b'; marimo run";
		expect(launch[2]).toBe(
			`cd '/work'; setsid sh -lc ${shellQuote(inner)} >${logFile} 2>&1 </dev/null & echo $!`,
		);
		expect(started.id).toBe('armada-proc-4242');
		expect(started.command).toBe('marimo run');

		const named: SandboxProcess = await sandbox.startProcess('marimo run', {
			processId: 'kernel',
		});
		expect(named.id).toBe('kernel');
	});

	it('kills the pid it parsed, defaulting to TERM', async () => {
		const { sandbox, calls } = stubSandbox(pidEcho);
		const started: SandboxProcess = await sandbox.startProcess('sleep 1000');
		await started.kill();
		await started.kill('KILL');

		expect(calls[1]?.command[2]).toBe('kill -TERM 4242 2>/dev/null || true');
		expect(calls[2]?.command[2]).toBe('kill -KILL 4242 2>/dev/null || true');
	});

	it('reads the process log back', async () => {
		const { sandbox, calls } = stubSandbox((call: ExecCall) =>
			(call.command[2] ?? '').startsWith('cat ')
				? { stdout: 'kernel output', stderr: '', exitCode: 0 }
				: pidEcho,
		);
		const started: SandboxProcess = await sandbox.startProcess('marimo run');

		expect(await started.getLogs()).toEqual({ stdout: 'kernel output', stderr: '' });
		expect(calls[1]?.command[2]).toMatch(/^cat \/tmp\/mh-proc-\d+\.log 2>\/dev\/null \|\| true$/);
	});

	it('waits for the port with an in-pod waiter in a login shell', async () => {
		const { sandbox, calls } = stubSandbox((call: ExecCall) =>
			(call.command[2] ?? '').startsWith('python3 -c') ? ok : pidEcho,
		);
		const started: SandboxProcess = await sandbox.startProcess('marimo run');
		await started.waitForPort(2718);

		const wait: ExecCall | undefined = calls.at(-1);
		expect(wait?.command[1]).toBe('-lc');
		expect(wait?.command[2]).toContain('("127.0.0.1",2718)');
	});

	it('reports a dead process as a crash carrying its log, not a timeout', async () => {
		const { sandbox } = stubSandbox((call: ExecCall) => {
			const cmd: string = call.command[2] ?? '';
			// The waiter fails its chunk and the /proc liveness check reports dead.
			if (cmd.startsWith('python3 -c') || cmd.includes('/proc/4242/stat')) {
				return { stdout: '', stderr: '', exitCode: 1 };
			}
			if (cmd.startsWith('cat ')) return { stdout: 'Traceback: boom', stderr: '', exitCode: 0 };
			return pidEcho;
		});
		const started: SandboxProcess = await sandbox.startProcess('marimo run');

		const message: string = await rejection(started.waitForPort(2718, { timeout: 100 }));
		expect(message).toContain('process exited before port 2718 opened');
		expect(message).toContain('Traceback: boom');
	});

	it('times out with the log when the process lives but the port never opens', async () => {
		const { sandbox } = stubSandbox((call: ExecCall) => {
			const cmd: string = call.command[2] ?? '';
			if (cmd.startsWith('python3 -c')) return { stdout: '', stderr: '', exitCode: 1 };
			if (cmd.startsWith('cat ')) return { stdout: 'still starting', stderr: '', exitCode: 0 };
			return pidEcho;
		});
		const started: SandboxProcess = await sandbox.startProcess('marimo run');

		const message: string = await rejection(started.waitForPort(2718, { timeout: 50 }));
		expect(message).toContain('timed out waiting for port 2718');
		expect(message).toContain('still starting');
	});
});

/** What the pod's `base64` prints for `content`, wrapped at 76 columns as GNU does. */
function base64Of(content: string | Uint8Array): string {
	const encoded: string = Buffer.from(content).toString('base64');
	return `${encoded.replace(/(.{76})/g, '$1\n')}\n`;
}

describe('readFile', () => {
	it('decodes the base64 the pod printed and reports it as text', async () => {
		const { sandbox, calls } = stubSandbox({
			stdout: base64Of('print(1)\n'),
			stderr: '',
			exitCode: 0,
		});
		const result: ReadFileResult = await sandbox.readFile('/work/notebook.py');

		expect(result).toEqual({ success: true, content: 'print(1)\n', encoding: 'utf-8' });
		expect(calls[0]?.command[0]).toBe('sh');
		// Not `sh -lc`: profile output on stdout would corrupt the base64.
		expect(calls[0]?.command[1]).toBe('-c');
		expect(calls[0]?.command[2]).toContain(`base64 < ${shellQuote('/work/notebook.py')}`);
	});

	it('joins the lines GNU base64 wrapped, for a file past 57 bytes', async () => {
		const long: string = 'x'.repeat(200);
		const { sandbox } = stubSandbox({ stdout: base64Of(long), stderr: '', exitCode: 0 });
		const result: ReadFileResult = await sandbox.readFile('/work/long.txt');

		expect(result.success && result.content).toBe(long);
	});

	it('returns bytes that are not UTF-8 as base64, so nothing is corrupted', async () => {
		const bytes: Uint8Array = new Uint8Array([0, 159, 146, 150]);
		const { sandbox } = stubSandbox({ stdout: base64Of(bytes), stderr: '', exitCode: 0 });
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
		const { sandbox } = stubSandbox({ stdout: base64Of(withBom), stderr: '', exitCode: 0 });
		const result: ReadFileResult = await sandbox.readFile('/work/bom.txt');

		expect(result.success && result.content).toBe('\ufeffa');
	});

	it('reads an empty file as empty text, not as a failure', async () => {
		const { sandbox } = stubSandbox({ stdout: '', stderr: '', exitCode: 0 });
		const result: ReadFileResult = await sandbox.readFile('/work/empty.py');

		expect(result).toEqual({ success: true, content: '', encoding: 'utf-8' });
	});

	it('separates a path that is not there from one that cannot be read', async () => {
		const { sandbox: absent } = stubSandbox({ stdout: '', stderr: '', exitCode: 44 });
		expect(await absent.readFile('/work/missing.py')).toEqual({
			success: false,
			content: '',
			error: { code: 'NOT_FOUND' },
		});

		const { sandbox: unreadable } = stubSandbox({
			stdout: '',
			stderr: 'Is a directory',
			exitCode: 2,
		});
		expect(await unreadable.readFile('/work')).toEqual({
			success: false,
			content: '',
			error: { code: 'READ_FAILED' },
		});
	});

	it('reports a broken control channel as a backend error, never a throw', async () => {
		const { sandbox } = stubSandbox(() => {
			throw new Error('websocket closed');
		});
		expect(await sandbox.readFile('/work/notebook.py')).toEqual({
			success: false,
			content: '',
			error: { code: 'BACKEND_ERROR' },
		});
	});

	it('runs without the env prefix, which would print nothing but is not ours to parse', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.setEnvVars({ API_KEY: 'secret' });
		await sandbox.readFile('/work/notebook.py');

		expect(calls[0]?.command[2]?.startsWith('if [ -e ')).toBe(true);
	});
});

describe('listFiles', () => {
	it('parses the records find printed', async () => {
		const { sandbox, calls } = stubSandbox({
			stdout: 'f\t12\t/work/notebook.py\0d\t4096\t/work/data\0',
			stderr: '',
			exitCode: 0,
		});
		const result: ListFilesResult = await sandbox.listFiles('/work');

		expect(result.success).toBe(true);
		expect(result.files.map((file: FileInfo) => file.name)).toEqual(['notebook.py', 'data']);
		expect(calls[0]?.command[1]).toBe('-c');
	});

	it('passes recursion through to find and hiding through to the parser', async () => {
		const { sandbox, calls } = stubSandbox({
			stdout: 'f\t1\t/work/.env\0',
			stderr: '',
			exitCode: 0,
		});
		const result: ListFilesResult = await sandbox.listFiles('/work', {
			recursive: true,
			includeHidden: true,
		});

		expect(calls[0]?.command[2]).not.toContain('-maxdepth');
		expect(result.files.map((file: FileInfo) => file.name)).toEqual(['.env']);
	});

	it('reports a file as NOT_A_DIRECTORY, never as an empty directory', async () => {
		const { sandbox } = stubSandbox({
			stdout: '',
			stderr: 'MARIMOHUB_NOT_A_DIRECTORY\n',
			exitCode: 20,
		});
		expect(await sandbox.listFiles('/work/notebook.py')).toEqual({
			success: false,
			files: [],
			error: { code: 'NOT_A_DIRECTORY' },
		});
	});

	it('reports any other non-zero exit as a failed listing', async () => {
		const { sandbox } = stubSandbox({ stdout: '', stderr: '', exitCode: 1 });
		expect(await sandbox.listFiles('/work/missing')).toEqual({
			success: false,
			files: [],
			error: { code: 'LIST_FAILED' },
		});
	});

	it('reports a broken control channel as a backend error, never a throw', async () => {
		const { sandbox } = stubSandbox(() => {
			throw new Error('websocket closed');
		});
		expect(await sandbox.listFiles('/work')).toEqual({
			success: false,
			files: [],
			error: { code: 'BACKEND_ERROR' },
		});
	});

	it('reads an empty directory as a success with no files', async () => {
		const { sandbox } = stubSandbox();
		expect(await sandbox.listFiles('/work')).toEqual({ success: true, files: [] });
	});
});

describe('exec', () => {
	it('runs in a login shell, so a profile-provided PATH reaches user code', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.exec('uv run marimo --version');

		expect(calls[0]?.command.slice(0, 2)).toEqual(['sh', '-lc']);
		expect(scriptOf(calls[0])).toBe('uv run marimo --version');
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

		const command: readonly string[] = calls[0]?.command ?? [];
		// A login shell that is its own group leader, so a cancel can kill it.
		expect(command.slice(0, 2)).toEqual(['sh', '-lc']);
		expect(command[2]).toMatch(
			/^trap 'rm -f (\/tmp\/mh-stream-\d+\.pgid)' EXIT; echo \$\$ > \1; export API_KEY='secret'; tail -f \/tmp\/log$/,
		);
		expect(await collect(stream)).toBe('streamed');
	});

	it('kills the process group when the consumer cancels', async () => {
		const { sandbox, calls } = stubSandbox();
		const stream: ReadableStream = await sandbox.execStream('tail -f /tmp/log');
		await stream.cancel();

		const groupFile: string =
			/(\/tmp\/mh-stream-\d+\.pgid)/.exec(calls[0]?.command[2] ?? '')?.[1] ?? '';
		expect(groupFile).not.toBe('');
		// The kill goes to the negated group id, so the shell's children go too.
		expect(calls[1]?.command[2]).toContain(`kill -TERM -"$group"`);
		expect(calls[1]?.command[2]).toContain(groupFile);
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

describe('exec timeouts', () => {
	it("tracks a command with no deadline too, since most of marimohub's have none", async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.exec('echo hi');

		expect(calls).toHaveLength(1);
		// Wrapped, so a dropped socket still leaves something the sweep can kill,
		// but with no timeout there is nothing to kill it early.
		expect(calls[0]?.command.slice(0, 2)).toEqual(['sh', '-lc']);
		expect(calls[0]?.timeoutMs).toBeUndefined();
	});

	it('makes a command with a deadline killable, and kills it when the deadline passes', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.exec('sleep 60', { timeout: 1_000 });

		const command: readonly string[] = calls[0]?.command ?? [];
		expect(command.slice(0, 2)).toEqual(['sh', '-lc']);
		// The cleanup is a trap, so a command ending in `exit` still removes the
		// file, and the command's own status is what `exec` reports.
		expect(command[2]).toMatch(
			/^trap 'rm -f (\/tmp\/mh-exec-\d+\.pgid)' EXIT; echo \$\$ > \1; sleep 60$/,
		);
		expect(calls[0]?.timeoutMs).toBe(1_000);

		// The stub fires onStop, as the real timeout does: a kill must follow.
		const groupFile: string = /(\/tmp\/mh-exec-\d+\.pgid)/.exec(command[2] ?? '')?.[1] ?? '';
		expect(calls[1]?.command[2]).toContain('kill -TERM -"$group"');
		expect(calls[1]?.command[2]).toContain(groupFile);
	});

	it('gives each command its own group file', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.exec('one', { timeout: 10 });
		await sandbox.exec('two', { timeout: 10 });

		expect(calls[0]?.command[2]).not.toBe(calls[2]?.command[2]);
	});
});

describe('ghost sweep', () => {
	it('spares the commands it is still waiting on', async () => {
		const { sandbox, calls } = stubSandbox();
		const stream: ReadableStream = await sandbox.execStream('tail -f /tmp/log');
		const groupFile: string =
			/(\/tmp\/mh-stream-\d+\.pgid)/.exec(calls[0]?.command[2] ?? '')?.[1] ?? '';

		await sandbox.sweep();
		expect(calls.at(-1)?.command[2]).toContain(`case "$file" in '${groupFile}') continue;; esac`);
		await stream.cancel();
	});

	it('stops sparing a command once it has finished', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.exec('echo hi', { timeout: 1_000 });

		await sandbox.sweep();
		// The exec is over, so nothing is exempt and its file is fair game.
		expect(calls.at(-1)?.command[2]).not.toContain('continue;; esac');
	});

	it('counts what it killed and reports it once', async () => {
		const { sandbox } = stubSandbox((call: ExecCall) =>
			(call.command[2] ?? '').startsWith('for file in')
				? {
						stdout:
							'/tmp/mh-exec-1.pgid\t412\tkilled\n' +
							'/tmp/mh-exec-2.pgid\t907\tkilled\n' +
							// Only the file was left behind, so it is not a ghost.
							'/tmp/mh-exec-3.pgid\t44\tgone\n',
						stderr: '',
						exitCode: 0,
					}
				: ok,
		);
		await sandbox.ready();

		expect(await sandbox.sweep()).toBe(2);
		expect(sandbox.drainCounters()).toEqual({ ghosts_killed: 2 });
		// Drained, so marimohub does not see the same ghosts twice.
		expect(sandbox.drainCounters()).toEqual({ ghosts_killed: 0 });
	});

	it('is quiet when a sweep cannot reach the pod', async () => {
		const { sandbox } = stubSandbox(() => {
			throw new Error('websocket closed');
		});
		await sandbox.ready();

		expect(await sandbox.sweep()).toBe(0);
	});

	it('has nothing to sweep before the job has a pod', async () => {
		const { sandbox, calls } = stubSandbox();
		expect(await sandbox.sweep()).toBe(0);
		expect(calls).toHaveLength(0);
	});
});

/** The group file of the command a sandbox started first. */
const groupFileOf: (calls: ExecCall[]) => string = (calls: ExecCall[]) =>
	/(\/tmp\/mh-\w+-\d+\.pgid)/.exec(calls[0]?.command.at(-1) ?? '')?.[1] ?? '';

/** Whether the last sweep spared the command that file belongs to. */
const spared: (calls: ExecCall[], groupFile: string) => boolean = (
	calls: ExecCall[],
	groupFile: string,
) => (calls.at(-1)?.command[2] ?? '').includes(`case "$file" in '${groupFile}') continue;; esac`);

describe('long-running commands', () => {
	/** A command the pod never answers, which is the case the backstop is for. */
	const never: (call: ExecCall) => Promise<CommandResult> = (call: ExecCall) =>
		(call.command[2] ?? '').startsWith('for file in')
			? Promise.resolve(ok)
			: new Promise<CommandResult>(() => {});

	const capped: { sandbox: ArmadaSandbox; calls: ExecCall[] } = stubSandbox(never, {
		ARMADA_COMMAND_MAX_SECONDS: '1',
	});
	const streaming: { sandbox: ArmadaSandbox; calls: ExecCall[] } = stubSandbox(never, {
		ARMADA_COMMAND_MAX_SECONDS: '1',
	});
	const uncapped: { sandbox: ArmadaSandbox; calls: ExecCall[] } = stubSandbox(never, {
		ARMADA_COMMAND_MAX_SECONDS: '0',
	});

	beforeAll(async () => {
		await capped.sandbox.ready();
		void capped.sandbox.exec('uv sync');
		await streaming.sandbox.execStream('tail -f /tmp/log');
		await uncapped.sandbox.ready();
		void uncapped.sandbox.exec('uv sync');
		// One wait for all three, since the shortest backstop the config accepts is
		// a whole second.
		await new Promise((resolve: (value: unknown) => void) => setTimeout(resolve, 1_100));
	});

	it('gives up on an exec that outlives the backstop, so its caller stops waiting', async () => {
		await capped.sandbox.sweep();

		// No longer spared, so this sweep kills it and `exec` sees it die rather
		// than waiting on it forever.
		expect(spared(capped.calls, groupFileOf(capped.calls))).toBe(false);
	});

	it('leaves a stream alone however long it stays open', async () => {
		await streaming.sandbox.sweep();

		// A reader keeping a stream open for hours is a decision, not a stuck
		// command.
		expect(spared(streaming.calls, groupFileOf(streaming.calls))).toBe(true);
	});

	it('expires nothing when the backstop is off', async () => {
		await uncapped.sandbox.sweep();

		expect(spared(uncapped.calls, groupFileOf(uncapped.calls))).toBe(true);
	});
});
