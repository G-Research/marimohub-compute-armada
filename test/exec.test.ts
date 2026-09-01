import { describe, expect, it } from 'bun:test';
import { ClusterAccess } from '../src/clusters.js';
import { describeFailure, exitCodeOf } from '../src/exec.js';
import { toExecResult } from '../src/sandbox.js';

describe('exit codes', () => {
	it('reads the code Kubernetes hides in the failure causes', () => {
		expect(
			exitCodeOf({
				status: 'Failure',
				details: { causes: [{ reason: 'ExitCode', message: '3' }] },
			}),
		).toBe(3);
	});

	it('treats success as zero', () => {
		expect(exitCodeOf({ status: 'Success' })).toBe(0);
		expect(exitCodeOf(undefined)).toBe(0);
	});

	it('does not report a failure without a code as a clean run', () => {
		// The exec itself went wrong; calling that exit 0 would report success.
		expect(exitCodeOf({ status: 'Failure', message: 'container not found' })).toBe(1);
	});
});

describe('failure messages', () => {
	it('reads a websocket ErrorEvent, which stringifies to nothing useful', () => {
		// The literal symptom this replaced: "[object ErrorEvent]".
		expect(describeFailure({ type: 'error', message: 'connection refused' })).toBe(
			'connection refused',
		);
	});

	it('unwraps a nested error', () => {
		expect(describeFailure({ type: 'error', error: new Error('404 not found') })).toBe(
			'404 not found',
		);
	});

	it('falls back to the event type rather than to nothing', () => {
		expect(describeFailure({ type: 'error' })).toBe('websocket error');
	});

	it('keeps an ordinary error message', () => {
		expect(describeFailure(new Error('boom'))).toBe('boom');
	});
});

describe('exec results', () => {
	it('passes a successful command through', () => {
		expect(toExecResult({ stdout: 'hi\n', stderr: '', exitCode: 0 })).toEqual({
			success: true,
			stdout: 'hi\n',
			stderr: '',
		});
	});

	it('reports a non-zero exit as a failed command, keeping its output', () => {
		expect(toExecResult({ stdout: 'partial', stderr: 'boom', exitCode: 2 })).toEqual({
			success: false,
			stdout: 'partial',
			stderr: 'boom',
			error: { code: 'COMMAND_FAILED' },
		});
	});
});

describe('cluster access', () => {
	it('substitutes the cluster id the way Lookout does', () => {
		const access: ClusterAccess = new ClusterAccess('/etc/clusters/{CLUSTER_ID}.yaml');
		expect(access.pathFor('Cluster1')).toBe('/etc/clusters/Cluster1.yaml');
	});

	it('uses ambient credentials when no pattern is configured', () => {
		expect(new ClusterAccess().pathFor('Cluster1')).toBeUndefined();
	});

	it('names the cluster and the path it looked in when credentials are missing', async () => {
		const access: ClusterAccess = new ClusterAccess('/nope/{CLUSTER_ID}.yaml');
		let message = '';
		try {
			await access.configFor('Cluster1');
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain('Cluster1');
		expect(message).toContain('/nope/Cluster1.yaml');
	});
});
