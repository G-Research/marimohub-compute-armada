import { describe, expect, it } from 'bun:test';
import { ClusterAccess } from '../src/clusters.js';
import { describeFailure, exitCodeOf, podOutputStream } from '../src/exec.js';
import type { PodOutputStream } from '../src/exec.js';
import { toExecResult } from '../src/sandbox.js';

/** The rejection reason as a string, so failures assert on the message plainly. */
async function rejection(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return String(error);
	}
	throw new Error('expected the call to reject, it resolved');
}

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

const bytes: (text: string) => Uint8Array = (text: string) => new TextEncoder().encode(text);

describe('output stream', () => {
	it('hands each chunk to the reader as it is written', async () => {
		const output: PodOutputStream = podOutputStream(() => {});
		const reader: ReadableStreamDefaultReader<Uint8Array> = output.stream.getReader();

		output.write(bytes('first'), () => {});
		expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');

		output.write(bytes('second'), () => {});
		expect(new TextDecoder().decode((await reader.read()).value)).toBe('second');

		output.end();
		expect((await reader.read()).done).toBe(true);
	});

	it('holds the producer until the consumer reads', async () => {
		const output: PodOutputStream = podOutputStream(() => {});
		let acked: number = 0;
		const ack: () => void = () => {
			acked++;
		};

		// The default queuing strategy counts one chunk, so a single enqueue takes
		// `desiredSize` to zero and the producer waits from the first chunk on.
		// That is the point: a command nobody is reading cannot fill memory.
		output.write(bytes('one'), ack);
		expect(acked).toBe(0);

		const reader: ReadableStreamDefaultReader<Uint8Array> = output.stream.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe('one');
		expect(acked).toBe(1);
	});

	it('closes the socket when the consumer cancels, and frees a held producer', async () => {
		let cancelled: number = 0;
		const output: PodOutputStream = podOutputStream(() => {
			cancelled++;
		});
		let acked: number = 0;
		output.write(bytes('one'), () => {
			acked++;
		});
		expect(acked).toBe(0);

		await output.stream.cancel();
		expect(cancelled).toBe(1);
		// Otherwise the write callback is stranded and the socket never unwinds.
		expect(acked).toBe(1);
	});

	it('drops writes that arrive after the stream is finished', async () => {
		const output: PodOutputStream = podOutputStream(() => {});
		output.end();

		let acked: boolean = false;
		// Enqueueing on a closed controller would throw; the producer still needs
		// its callback.
		expect(() => {
			output.write(bytes('late'), () => {
				acked = true;
			});
		}).not.toThrow();
		expect(acked).toBe(true);
	});

	it('fails the stream with the websocket error, once', async () => {
		const output: PodOutputStream = podOutputStream(() => {});
		output.fail(new Error('connection reset'));
		output.end();

		const message: string = await rejection(output.stream.getReader().read());
		expect(message).toContain('connection reset');
	});

	it('ignores an end after a cancel, rather than closing a dead controller', async () => {
		const output: PodOutputStream = podOutputStream(() => {});
		await output.stream.cancel();

		expect(() => {
			output.end();
		}).not.toThrow();
	});
});
