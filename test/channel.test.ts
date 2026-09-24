import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { AgentChannel, CommandTimeoutError, boundedReadGiveUpMs } from '../src/channel.js';
import type {
	AgentEndpoint,
	CommandResult,
	ListFilesOutcome,
	PortWait,
	ProcessStatus,
	ReadBudget,
	ReadFileOutcome,
} from '../src/channel.js';
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

/** One request to any other endpoint, as the fake agent saw it. */
interface ApiRequest {
	method: string;
	path: string;
	query: Record<string, string>;
	body: Uint8Array<ArrayBuffer>;
}

/** Lines the fake agent sends next; `WAIT` holds the response open from there. */
const WAIT = '<wait>';
let script: string[] = [];
let healthy = true;
const received: Received[] = [];
const requests: ApiRequest[] = [];
/** In-memory files behind `/files`, path to bytes. */
const files: Map<string, Uint8Array<ArrayBuffer>> = new Map();
/** Makes the fake hold a bounded read past any deadline a test sets. */
let stallBounded = false;
/** Scripted JSON answer for the next process/list request, by path. */
let answers: Record<string, { status: number; body: unknown }> = {};

const encoder: TextEncoder = new TextEncoder();
const b64: (text: string) => string = (text: string): string =>
	Buffer.from(text).toString('base64');

function scripted(path: string): Response | undefined {
	const answer: { status: number; body: unknown } | undefined = answers[path];
	if (answer === undefined) return undefined;
	// A string body is served as text, the way the log endpoint answers.
	if (typeof answer.body === 'string') return new Response(answer.body, { status: answer.status });
	return Response.json(answer.body, { status: answer.status });
}

/**
 * A fake agent speaking the protocol `agent/server.go` speaks, so the client is
 * tested against the wire and not against a mock of itself.
 */
const server: ReturnType<typeof Bun.serve> = Bun.serve({
	port: 0,
	async fetch(request: Request): Promise<Response> {
		const url: URL = new URL(request.url);
		const path: string = url.pathname;
		if (path === '/healthz') {
			return healthy ? new Response('ok\n') : new Response('starting', { status: 503 });
		}
		if (path === '/exec') {
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
		}

		if (request.headers.get('authorization') !== 'Bearer token-1') {
			return Response.json({ error: 'wrong token' }, { status: 401 });
		}
		requests.push({
			method: request.method,
			path,
			query: Object.fromEntries(url.searchParams),
			body: new Uint8Array(await request.arrayBuffer()),
		});
		const filePath: string = url.searchParams.get('path') ?? '';
		if (path === '/files' && request.method === 'PUT') {
			files.set(filePath, requests.at(-1)?.body ?? new Uint8Array());
			return Response.json({});
		}
		if (path === '/files' && request.method === 'GET') {
			const bytes: Uint8Array<ArrayBuffer> | undefined = files.get(filePath);
			if (bytes === undefined) {
				return Response.json(
					{ error: `no such file: ${filePath}`, code: 'not_found' },
					{
						status: 404,
					},
				);
			}
			return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
		}
		if (path === '/files/bounded') {
			if (stallBounded) {
				await Bun.sleep(5_000);
				return new Response('too late');
			}
			const answer: Response | undefined = scripted(path);
			if (answer !== undefined) return answer;
			const bytes: Uint8Array<ArrayBuffer> | undefined = files.get(filePath);
			if (bytes === undefined) {
				return Response.json(
					{ error: `no such file: ${filePath}`, code: 'not_found' },
					{ status: 404 },
				);
			}
			const maxBytes: number = Number(url.searchParams.get('maxBytes'));
			if (bytes.byteLength > maxBytes) {
				return Response.json(
					{ error: `${filePath} is over the budget of ${String(maxBytes)}`, code: 'read_failed' },
					{ status: 500 },
				);
			}
			return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
		}
		return scripted(path) ?? Response.json({ error: `unscripted path ${path}` }, { status: 500 });
	},
});

afterAll(async () => {
	await server.stop(true);
});

afterEach(() => {
	script = [];
	healthy = true;
	received.length = 0;
	requests.length = 0;
	files.clear();
	answers = {};
	stallBounded = false;
});

function endpoint(token = 'token-1'): AgentEndpoint {
	return {
		url: `http://127.0.0.1:${String(server.port)}`,
		token,
		pod: { clusterId: 'Cluster1', podName: 'armada-job-0', podNamespace: 'default' },
	};
}

function channel(token = 'token-1'): AgentChannel {
	return new AgentChannel(endpoint(token));
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
		const result: CommandResult = await channel().run(['sh', '-c', 'x'], {
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
		await channel().run(['cat'], { stdin: new Uint8Array([0, 255, 10]) });

		expect(received[0]?.body.stdin).toBe(Buffer.from([0, 255, 10]).toString('base64'));
	});

	it('rejects a timed-out command with its own error type', async () => {
		script = [JSON.stringify({ pid: 41 }), JSON.stringify({ exit: -1, timedOut: true })];
		let caught: unknown;
		try {
			await channel().run(['sleep', '30'], { timeoutMs: 100 });
		} catch (error) {
			caught = error;
		}

		// The type is what lets a caller tell "the deadline it set" from "the
		// backstop it did not".
		expect(caught).toBeInstanceOf(CommandTimeoutError);
		expect(String(caught)).toContain(
			'Command timed out after 100ms in default/armada-job-0: sleep 30',
		);
	});

	it('names the pod, the command and the agent error when refused', async () => {
		const message: string = await rejection(channel('nope').run(['true']));

		expect(message).toContain('The agent in default/armada-job-0 could not run "true"');
		expect(message).toContain('HTTP 401: wrong token');
	});

	it('rejects when the agent reports an error line, or ends without an exit', async () => {
		script = [JSON.stringify({ error: 'cannot start sh: not found' })];
		expect(await rejection(channel().run(['sh']))).toContain('cannot start sh: not found');

		script = [JSON.stringify({ stdout: b64('partial') })];
		expect(await rejection(channel().run(['sh']))).toContain('ended without an exit status');
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
	it('yields stdout chunks as they come, skips stderr, and ends cleanly', async () => {
		script = [
			JSON.stringify({ pid: 41 }),
			JSON.stringify({ stdout: b64('one') }),
			JSON.stringify({ stderr: b64('noise') }),
			JSON.stringify({ stdout: b64('two') }),
			JSON.stringify({ exit: 0 }),
		];
		const stream: ReadableStream<Uint8Array> = await channel().stream(['sh', '-c', 'x']);

		expect(await readAll(stream)).toBe('one|two');
		// No deadline goes to the agent: a stream's timeout ends it, not fails it.
		expect(received[0]?.body).toEqual({ cmd: ['sh', '-c', 'x'] });
	});

	it('closes the request on cancel, which is what kills the command', async () => {
		script = [JSON.stringify({ pid: 41 }), JSON.stringify({ stdout: b64('first') }), WAIT];
		const stream: ReadableStream<Uint8Array> = await channel().stream(['x']);
		const reader: ReadableStreamDefaultReader<Uint8Array> = stream.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
		await reader.cancel();

		expect(await until(() => received[0]?.aborted === true)).toBe(true);
	});

	it('ends, rather than fails, when its timeout passes', async () => {
		script = [JSON.stringify({ stdout: b64('first') }), WAIT];
		const stream: ReadableStream<Uint8Array> = await channel().stream(['x'], {
			timeoutMs: 100,
		});

		expect(await readAll(stream)).toBe('first');
		expect(await until(() => received[0]?.aborted === true)).toBe(true);
	});

	it('fails the stream when the agent refuses the command', async () => {
		expect(await rejection(channel('nope').stream(['x']))).toContain('HTTP 401');
	});
});

describe('files', () => {
	it('writes bytes raw, with the path in the query and nothing quoted', async () => {
		const bytes: Uint8Array<ArrayBuffer> = new Uint8Array([0, 159, 146, 150]);
		await channel().writeFile("/work/it's file.bin", bytes);

		expect(requests[0]?.method).toBe('PUT');
		expect(requests[0]?.query).toEqual({ path: "/work/it's file.bin" });
		expect(requests[0]?.body).toEqual(bytes);
	});

	it('reads back the bytes it wrote, byte for byte', async () => {
		const bytes: Uint8Array = new Uint8Array([0, 159, 146, 150]);
		await channel().writeFile('/work/blob.bin', bytes);
		const read: ReadFileOutcome = await channel().readFile('/work/blob.bin');

		expect(read).toEqual({ outcome: 'ok', bytes });
	});

	it('maps the agent refusal codes to outcomes a sandbox can answer with', async () => {
		expect(await channel().readFile('/work/missing.py')).toEqual({ outcome: 'not-found' });

		answers['/files/list'] = {
			status: 409,
			body: { error: '/work/notebook.py is not a directory', code: 'not_a_directory' },
		};
		expect(await channel().listFiles('/work/notebook.py', false)).toEqual({
			outcome: 'not-a-directory',
		});

		answers['/files/list'] = {
			status: 404,
			body: { error: 'no such directory: /gone', code: 'not_found' },
		};
		const failed: ListFilesOutcome = await channel().listFiles('/gone', false);
		expect(failed.outcome).toBe('failed');
	});

	it('throws on a refusal without a known code, such as a wrong token', async () => {
		expect(await rejection(channel('nope').readFile('/x'))).toContain('HTTP 401: wrong token');
		expect(await rejection(channel('nope').writeFile('/x', 'y'))).toContain('could not write /x');
	});

	it('lists entries as the agent walked them, sending the recursive flag', async () => {
		answers['/files/list'] = {
			status: 200,
			body: {
				entries: [
					{ path: '/work/notebook.py', type: 'file', size: 12 },
					{ path: '/work/data', type: 'directory', size: 4096 },
				],
			},
		};
		const listed: ListFilesOutcome = await channel().listFiles('/work', true);

		expect(listed).toEqual({
			outcome: 'ok',
			entries: [
				{ path: '/work/notebook.py', type: 'file', size: 12 },
				{ path: '/work/data', type: 'directory', size: 4096 },
			],
		});
		expect(requests[0]?.query).toEqual({ path: '/work', recursive: 'true' });

		await channel().listFiles('/work', false);
		expect(requests[1]?.query).toEqual({ path: '/work' });
	});
});

describe('bounded reads', () => {
	const budget: ReadBudget = { maxBytes: 4, timeoutMs: 5_000 };

	it('sends the budget beside the path and reads back the bytes', async () => {
		const bytes: Uint8Array = new Uint8Array([0, 159, 146, 150]);
		await channel().writeFile("/work/it's.bin", bytes);
		const read: ReadFileOutcome = await channel().readFileBounded("/work/it's.bin", budget);

		expect(read).toEqual({ outcome: 'ok', bytes });
		expect(requests[1]?.path).toBe('/files/bounded');
		expect(requests[1]?.query).toEqual({
			path: "/work/it's.bin",
			maxBytes: '4',
			timeoutMs: '5000',
		});
	});

	it('maps the agent refusal codes as a plain read does', async () => {
		expect(await channel().readFileBounded('/work/missing.py', budget)).toEqual({
			outcome: 'not-found',
		});

		await channel().writeFile('/work/big.py', 'print(1)\n');
		const over: ReadFileOutcome = await channel().readFileBounded('/work/big.py', budget);
		expect(over.outcome).toBe('failed');
		expect(over.outcome === 'failed' && over.message).toContain('over the budget of 4');
	});

	it('refuses a body past the budget even when the agent sends one', async () => {
		answers['/files/bounded'] = { status: 200, body: 'print(1)\n' };
		const read: ReadFileOutcome = await channel().readFileBounded('/work/notebook.py', budget);

		expect(read).toEqual({
			outcome: 'failed',
			message: 'the agent sent more than the budget of 4 bytes',
		});
	});

	it('gives up at the deadline when the agent does not answer', async () => {
		stallBounded = true;
		const started: number = Date.now();
		const message: string = await rejection(
			channel().readFileBounded('/work/notebook.py', { maxBytes: 4, timeoutMs: 200 }),
		);

		// The deadline plus the second the agent gets to answer it first.
		expect(Date.now() - started).toBeLessThan(2_500);
		expect(message).toContain('could not read /work/notebook.py');
	});

	it('throws on a refusal without a known code, such as an agent that predates the route', async () => {
		answers['/files/bounded'] = { status: 404, body: '404 page not found' };
		expect(await rejection(channel().readFileBounded('/x', budget))).toContain(
			'HTTP 404: 404 page not found',
		);
		expect(await rejection(channel('nope').readFileBounded('/x', budget))).toContain(
			'HTTP 401: wrong token',
		);
	});
	it('gives the agent a second past its deadline, but never past what a timer holds', () => {
		expect(boundedReadGiveUpMs(10_000)).toBe(11_000);
		// Node fires a timer past 2^31 - 1 after 1ms; Bun does not, so this is
		// asserted on the number rather than by waiting for the abort.
		expect(boundedReadGiveUpMs(2 ** 31 - 1)).toBe(2 ** 31 - 1);
		expect(boundedReadGiveUpMs(2 ** 31 - 500)).toBe(2 ** 31 - 1);
	});

	it('reports the agent answer to its own deadline, not an abort', async () => {
		answers['/files/bounded'] = {
			status: 500,
			body: { error: 'reading /work/notebook.py: deadline of 200ms passed', code: 'read_failed' },
		};
		expect(
			await channel().readFileBounded('/work/notebook.py', { maxBytes: 4, timeoutMs: 200 }),
		).toEqual({
			outcome: 'failed',
			message: 'HTTP 500: reading /work/notebook.py: deadline of 200ms passed',
		});
	});
});

describe('processes', () => {
	it('starts a process with its cwd and returns the pid the agent named', async () => {
		answers['/process/start'] = { status: 200, body: { pid: 77 } };
		const pid: number = await channel().startProcess(['sh', '-lc', 'marimo run'], '/work');

		expect(pid).toBe(77);
		expect(JSON.parse(new TextDecoder().decode(requests[0]?.body))).toEqual({
			cmd: ['sh', '-lc', 'marimo run'],
			cwd: '/work',
		});
	});

	it('rejects with the agent message when the start is refused', async () => {
		answers['/process/start'] = {
			status: 500,
			body: { error: 'cannot start sh: not found' },
		};
		const message: string = await rejection(channel().startProcess(['sh']));

		expect(message).toContain('could not start');
		expect(message).toContain('cannot start sh: not found');
	});

	it('reads a status back, running or exited', async () => {
		answers['/process/status'] = { status: 200, body: { running: true } };
		expect(await channel().processStatus(77)).toEqual({ running: true });

		answers['/process/status'] = { status: 200, body: { running: false, exitCode: 3 } };
		const done: ProcessStatus = await channel().processStatus(77);
		expect(done).toEqual({ running: false, exitCode: 3 });
		expect(requests[0]?.query).toEqual({ pid: '77' });
	});

	it('signals by pid and name', async () => {
		answers['/process/signal'] = { status: 200, body: {} };
		await channel().signalProcess(77, 'KILL');

		expect(JSON.parse(new TextDecoder().decode(requests[0]?.body))).toEqual({
			pid: 77,
			signal: 'KILL',
		});
	});

	it('reads the log as plain text', async () => {
		answers['/process/logs'] = { status: 200, body: 'kernel output\n' };
		expect(await channel().processLogs(77)).toBe('kernel output\n');
	});

	it('asks the agent to wait for a port, watching a pid', async () => {
		answers['/process/waitport'] = { status: 200, body: { open: true } };
		expect(await channel().waitForPort(2718, 30_000, 77)).toEqual({ open: true });
		expect(JSON.parse(new TextDecoder().decode(requests[0]?.body))).toEqual({
			port: 2718,
			timeoutMs: 30_000,
			pid: 77,
		});

		answers['/process/waitport'] = {
			status: 200,
			body: { open: false, exited: true, exitCode: 7 },
		};
		const crashed: PortWait = await channel().waitForPort(2718, 30_000, 77);
		expect(crashed).toEqual({ open: false, exited: true, exitCode: 7 });
	});

	it('sends an http probe with its path when asked for one', async () => {
		answers['/process/waitport'] = { status: 200, body: { open: true } };
		await channel().waitForPort(8443, 2_000, undefined, { mode: 'http', path: '/healthz' });
		expect(JSON.parse(new TextDecoder().decode(requests[0]?.body))).toEqual({
			port: 8443,
			timeoutMs: 2_000,
			mode: 'http',
			path: '/healthz',
		});
	});
});

describe('ready', () => {
	it('resolves once the agent answers, polling until it does', async () => {
		healthy = false;
		setTimeout(() => {
			healthy = true;
		}, 300);
		await channel().ready(3_000);
	});

	it('rejects with the last reason when the agent never answers', async () => {
		healthy = false;
		const message: string = await rejection(channel().ready(400));
		expect(message).toContain('did not answer within 400ms: HTTP 503');
	});

	it('reports a connection that cannot be made', async () => {
		const unreachable: AgentChannel = new AgentChannel({
			...endpoint(),
			url: 'http://127.0.0.1:1',
		});
		expect(await rejection(unreachable.ready(300))).toContain('The agent in default/armada-job-0');
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
