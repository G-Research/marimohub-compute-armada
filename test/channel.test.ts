import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { AgentChannel } from '../src/channel.js';
import type { AgentEndpoint, CommandResult } from '../src/channel.js';
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

interface ExecBody {
	cmd: string[];
	stdin?: string;
	timeoutMs?: number;
}

/** One `/exec` request as the fake agent saw it. */
interface Received {
	authorization: string | null;
	body: ExecBody;
	/** Set when the client closed the request before the response ended. */
	aborted: boolean;
}

/** Lines the fake agent sends next; `WAIT` holds the response open from there. */
const WAIT = '<wait>';
let script: string[] = [];
let healthy = true;
const received: Received[] = [];

const encoder: TextEncoder = new TextEncoder();
const b64: (text: string) => string = (text: string): string =>
	Buffer.from(text).toString('base64');

/**
 * A fake agent speaking the protocol `agent/server.go` speaks, so the client is
 * tested against the wire and not against a mock of itself.
 */
const server: ReturnType<typeof Bun.serve> = Bun.serve({
	port: 0,
	async fetch(request: Request): Promise<Response> {
		const path: string = new URL(request.url).pathname;
		if (path === '/healthz') {
			return healthy ? new Response('ok\n') : new Response('starting', { status: 503 });
		}
		if (path !== '/exec') return new Response('not found', { status: 404 });
		// oxlint-disable-next-line no-unsafe-type-assertion -- the fake trusts the client it tests
		const body: ExecBody = (await request.json()) as ExecBody;
		const record: Received = {
			authorization: request.headers.get('authorization'),
			body,
			aborted: false,
		};
		received.push(record);
		if (record.authorization !== 'Bearer token-1') {
			return Response.json({ error: 'wrong token' }, { status: 401 });
		}
		const lines: string[] = script;
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller: ReadableStreamDefaultController<Uint8Array>): void {
					for (const line of lines) {
						if (line === WAIT) return;
						controller.enqueue(encoder.encode(`${line}\n`));
					}
					controller.close();
				},
				cancel(): void {
					record.aborted = true;
				},
			}),
			{ headers: { 'content-type': 'application/x-ndjson' } },
		);
	},
});

afterAll(async () => {
	await server.stop(true);
});

afterEach(() => {
	script = [];
	healthy = true;
	received.length = 0;
});

function endpoint(token = 'token-1'): AgentEndpoint {
	return {
		address: `127.0.0.1:${String(server.port)}`,
		token,
		pod: { clusterId: 'Cluster1', podName: 'armada-job-0', podNamespace: 'default' },
	};
}

async function until(condition: () => boolean, ms = 2_000): Promise<boolean> {
	const deadline: number = Date.now() + ms;
	// oxlint-disable-next-line no-await-in-loop -- a poll
	while (!condition() && Date.now() < deadline) await Bun.sleep(20);
	return condition();
}

describe('run', () => {
	it('sends the token and the command, and collects output and exit code', async () => {
		script = [
			JSON.stringify({ pid: 41 }),
			JSON.stringify({ stdout: b64('hi ') }),
			JSON.stringify({ stderr: b64('oops') }),
			JSON.stringify({ stdout: b64('there\n') }),
			JSON.stringify({ exit: 3 }),
		];
		const result: CommandResult = await new AgentChannel(endpoint()).run(['sh', '-c', 'x'], {
			stdin: 'data',
			timeoutMs: 5_000,
		});

		expect(result).toEqual({ stdout: 'hi there\n', stderr: 'oops', exitCode: 3 });
		expect(received[0]?.authorization).toBe('Bearer token-1');
		expect(received[0]?.body).toEqual({
			cmd: ['sh', '-c', 'x'],
			stdin: b64('data'),
			timeoutMs: 5_000,
		});
	});

	it('sends binary stdin as its own bytes', async () => {
		script = [JSON.stringify({ exit: 0 })];
		await new AgentChannel(endpoint()).run(['cat'], { stdin: new Uint8Array([0, 255, 10]) });

		expect(received[0]?.body.stdin).toBe(Buffer.from([0, 255, 10]).toString('base64'));
	});

	it('rejects a timed-out command the way the old channel did, and calls onStop', async () => {
		script = [JSON.stringify({ pid: 41 }), JSON.stringify({ exit: -1, timedOut: true })];
		let stopped = false;
		const message: string = await rejection(
			new AgentChannel(endpoint()).run(['sleep', '30'], {
				timeoutMs: 100,
				onStop: async () => {
					stopped = true;
				},
			}),
		);

		expect(message).toContain('Command timed out after 100ms in default/armada-job-0: sleep 30');
		expect(stopped).toBe(true);
	});

	it('names the pod, the command and the agent error when refused', async () => {
		const message: string = await rejection(new AgentChannel(endpoint('nope')).run(['true']));

		expect(message).toContain('The agent in default/armada-job-0 could not run "true"');
		expect(message).toContain('HTTP 401: wrong token');
	});

	it('rejects when the agent reports an error line, or ends without an exit', async () => {
		script = [JSON.stringify({ error: 'cannot start sh: not found' })];
		expect(await rejection(new AgentChannel(endpoint()).run(['sh']))).toContain(
			'cannot start sh: not found',
		);

		script = [JSON.stringify({ stdout: b64('partial') })];
		expect(await rejection(new AgentChannel(endpoint()).run(['sh']))).toContain(
			'ended without an exit status',
		);
	});

	it('keeps a scheme the address already has', async () => {
		script = [JSON.stringify({ exit: 0 })];
		const channel: AgentChannel = new AgentChannel({
			...endpoint(),
			address: `http://127.0.0.1:${String(server.port)}`,
		});
		expect((await channel.run(['true'])).exitCode).toBe(0);
	});
});

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
	const chunks: string[] = [];
	const reader: ReadableStreamDefaultReader<Uint8Array> = stream.getReader();
	const decoder: TextDecoder = new TextDecoder();
	for (;;) {
		// oxlint-disable-next-line no-await-in-loop -- reading a stream to its end
		const next: Awaited<ReturnType<typeof reader.read>> = await reader.read();
		if (next.done) break;
		chunks.push(decoder.decode(next.value));
	}
	return chunks.join('|');
}

describe('stream', () => {
	it('yields stdout chunks as they come, skips stderr, and reports the end', async () => {
		script = [
			JSON.stringify({ pid: 41 }),
			JSON.stringify({ stdout: b64('one') }),
			JSON.stringify({ stderr: b64('noise') }),
			JSON.stringify({ stdout: b64('two') }),
			JSON.stringify({ exit: 0 }),
		];
		let finished = 0;
		const stream: ReadableStream<Uint8Array> = await new AgentChannel(endpoint()).stream(
			['sh', '-c', 'x'],
			{
				onFinished: () => {
					finished += 1;
				},
			},
		);

		expect(await readAll(stream)).toBe('one|two');
		expect(finished).toBe(1);
		// No deadline goes to the agent: a stream's timeout ends it, not fails it.
		expect(received[0]?.body).toEqual({ cmd: ['sh', '-c', 'x'] });
	});

	it('closes the request on cancel, which is what kills the command', async () => {
		script = [JSON.stringify({ pid: 41 }), JSON.stringify({ stdout: b64('first') }), WAIT];
		let stopped = false;
		const stream: ReadableStream<Uint8Array> = await new AgentChannel(endpoint()).stream(['x'], {
			onStop: async () => {
				stopped = true;
			},
		});
		const reader: ReadableStreamDefaultReader<Uint8Array> = stream.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
		await reader.cancel();

		expect(stopped).toBe(true);
		expect(await until(() => received[0]?.aborted === true)).toBe(true);
	});

	it('ends, rather than fails, when its timeout passes', async () => {
		script = [JSON.stringify({ stdout: b64('first') }), WAIT];
		let stopped = false;
		const stream: ReadableStream<Uint8Array> = await new AgentChannel(endpoint()).stream(['x'], {
			timeoutMs: 100,
			onStop: async () => {
				stopped = true;
			},
		});

		expect(await readAll(stream)).toBe('first');
		expect(stopped).toBe(true);
		expect(await until(() => received[0]?.aborted === true)).toBe(true);
	});

	it('fails the stream when the agent refuses the command', async () => {
		expect(await rejection(new AgentChannel(endpoint('nope')).stream(['x']))).toContain('HTTP 401');
	});
});

describe('ready', () => {
	it('resolves once the agent answers, polling until it does', async () => {
		healthy = false;
		setTimeout(() => {
			healthy = true;
		}, 300);
		await new AgentChannel(endpoint()).ready(3_000);
	});

	it('rejects with the last reason when the agent never answers', async () => {
		healthy = false;
		const message: string = await rejection(new AgentChannel(endpoint()).ready(400));
		expect(message).toContain('did not answer within 400ms: HTTP 503');
	});

	it('reports a connection that cannot be made', async () => {
		const channel: AgentChannel = new AgentChannel({ ...endpoint(), address: '127.0.0.1:1' });
		expect(await rejection(channel.ready(300))).toContain('The agent in default/armada-job-0');
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
