import { describe, expect, it } from 'bun:test';
import type { ArmadaClient, PodLocation } from '../src/armada.js';
import { readConfig } from '../src/config.js';
import type { ArmadaConfig } from '../src/config.js';
import type { PodExec, PodExecOptions, PodExecResult } from '../src/exec.js';
import { ArmadaSandbox } from '../src/sandbox.js';
import { shellQuote } from '../src/shell.js';
import type { SandboxProcess } from '../src/types.js';

const config: ArmadaConfig = readConfig({
	ARMADA_URL: 'http://armada.example.com/',
	ARMADA_QUEUE: 'marimohub',
	MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
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
}

const ok: PodExecResult = { stdout: '', stderr: '', exitCode: 0 };

/** A sandbox whose job is "already placed" and whose execs are recorded. */
function stubSandbox(respond: PodExecResult | ((call: ExecCall) => PodExecResult) = ok): {
	sandbox: ArmadaSandbox;
	calls: ExecCall[];
} {
	const calls: ExecCall[] = [];
	const armada: ArmadaClient = {
		submit: async () => ({ jobId: 'job-1', jobSetId: 'set-1' }),
		waitForRunning: async () => pod,
	} as unknown as ArmadaClient;
	const podExec: PodExec = {
		run: async (_pod: PodLocation, command: readonly string[], options?: PodExecOptions) => {
			const call: ExecCall = { command, stdin: options?.stdin };
			calls.push(call);
			return typeof respond === 'function' ? respond(call) : respond;
		},
	} as unknown as PodExec;
	return { sandbox: new ArmadaSandbox('sandbox-1', config, armada, podExec), calls };
}

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

		expect(calls[0]?.command).toEqual([
			'sh',
			'-c',
			"export API_KEY='secret'; [ -n \"${HOME_DIR:-}\" ] || export HOME_DIR='/work'; echo hi",
		]);
	});

	it('lets a forced value beat a later onlyIfUnset default for the same key', async () => {
		const { sandbox, calls } = stubSandbox();
		await sandbox.setEnvVars({ K: 'forced' });
		await sandbox.setEnvVars({ K: 'default' }, { onlyIfUnset: true });
		await sandbox.exec('run');

		expect(calls[0]?.command[2]).toBe(
			"export K='forced'; [ -n \"${K:-}\" ] || export K='default'; run",
		);
	});

	it('rejects a bad name at the set, not at the next exec', async () => {
		const { sandbox, calls } = stubSandbox();
		expect(await rejection(sandbox.setEnvVars({ 'A B': 'x' }))).toContain(
			'Invalid environment variable name',
		);

		await sandbox.exec('echo hi');
		expect(calls[0]?.command[2]).toBe('echo hi');
	});
});

/** Result whose stdout is the echoed PID of the detached process. */
const pidEcho: PodExecResult = { stdout: '4242\n', stderr: '', exitCode: 0 };

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
