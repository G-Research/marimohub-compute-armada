import { describe, expect, it } from 'bun:test';
import type { ArmadaClient, PodLocation } from '../src/armada.js';
import { readConfig } from '../src/config.js';
import type { ArmadaConfig } from '../src/config.js';
import type { PodExec, PodExecOptions, PodExecResult } from '../src/exec.js';
import { ArmadaSandbox } from '../src/sandbox.js';

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

/** A sandbox whose job is "already placed" and whose execs are recorded. */
function stubSandbox(result: PodExecResult = { stdout: '', stderr: '', exitCode: 0 }): {
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
			calls.push({ command, stdin: options?.stdin });
			return result;
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
