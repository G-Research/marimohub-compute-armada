import { afterEach, describe, expect, it } from 'bun:test';
import { ArmadaClient } from '../src/armada.js';
import type { PodLocation, SubmittedJob } from '../src/armada.js';
import { readConfig } from '../src/config.js';
import type { ArmadaConfig } from '../src/config.js';
import { buildPodSpec } from '../src/podspec.js';

const config: ArmadaConfig = readConfig({
	ARMADA_URL: 'http://armada.example.com/',
	ARMADA_QUEUE: 'marimohub',
	ARMADA_NAMESPACE: 'kernels',
	MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
	ARMADA_AUTH_TOKEN: 'secret',
});

interface Call {
	url: string;
	headers: Record<string, string>;
	body: unknown;
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

const calls: Call[] = [];
const realFetch: typeof fetch = globalThis.fetch;

/** Records the request and answers with `response`. */
function stubFetch(response: Response | (() => Response)): void {
	const stub: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const url: string =
			input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
		const body: BodyInit | null | undefined = init?.body;
		calls.push({
			url,
			// Headers normalises the casing, which is what a server would see too.
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
			body: typeof body === 'string' ? JSON.parse(body) : undefined,
		});
		return typeof response === 'function' ? response() : response;
	};

	// fetch carries statics a plain function does not, so keep the real ones.
	globalThis.fetch = Object.assign(stub, { preconnect: realFetch.preconnect });
}

/** An ndjson event stream, the shape the gateway sends for a streaming RPC. */
function eventStream(...messages: readonly object[]): Response {
	return new Response(messages.map((message: object) => JSON.stringify(message)).join('\n'));
}

afterEach(() => {
	globalThis.fetch = realFetch;
	calls.length = 0;
});

describe('submit', () => {
	it('uses the sandbox id as client id, job set and external uri', async () => {
		stubFetch(Response.json({ jobResponseItems: [{ jobId: 'job-1' }] }));

		const job: SubmittedJob = await new ArmadaClient(config).submit(
			'sandbox-7',
			buildPodSpec(config),
		);

		expect(job).toEqual({ jobId: 'job-1', jobSetId: 'sandbox-7' });
		expect(calls[0]?.url).toBe('http://armada.example.com/v1/job/submit');
		expect(calls[0]?.headers['authorization']).toBe('Bearer secret');

		expect(calls[0]?.body).toMatchObject({
			queue: 'marimohub',
			jobSetId: 'sandbox-7',
			jobRequestItems: [
				{
					clientId: 'sandbox-7',
					externalJobUri: 'sandbox-7',
					namespace: 'kernels',
					// A retried kernel would be an empty process wearing the session's name.
					annotations: { 'armadaproject.io/failFast': 'true' },
					services: [{ type: 'NodePort', ports: [config.port] }],
				},
			],
		});
	});

	it('reports a per-item rejection, which arrives inside a 200', async () => {
		stubFetch(Response.json({ jobResponseItems: [{ error: 'queue does not exist' }] }));

		const message: string = await rejection(
			new ArmadaClient(config).submit('s', buildPodSpec(config)),
		);
		expect(message).toContain('queue does not exist');
	});

	it('surfaces the gateway error body, not just the status', async () => {
		stubFetch(new Response('no such queue', { status: 404 }));

		const message: string = await rejection(
			new ArmadaClient(config).submit('s', buildPodSpec(config)),
		);
		expect(message).toContain('(404): no such queue');
	});
});

describe('waitForRunning', () => {
	const job: SubmittedJob = { jobId: 'job-1', jobSetId: 'sandbox-7' };

	it('returns where the pod landed', async () => {
		stubFetch(
			eventStream(
				{ result: { id: '1', message: { submitted: { jobId: 'job-1' } } } },
				{
					result: {
						id: '2',
						message: {
							running: {
								jobId: 'job-1',
								clusterId: 'cluster-a',
								podName: 'armada-job-1-0',
								podNamespace: 'kernels',
								nodeName: 'node-3',
							},
						},
					},
				},
			),
		);

		const pod: PodLocation = await new ArmadaClient(config).waitForRunning(job);

		expect(pod).toEqual({
			clusterId: 'cluster-a',
			podName: 'armada-job-1-0',
			podNamespace: 'kernels',
			nodeName: 'node-3',
		});
		expect(calls[0]?.url).toBe('http://armada.example.com/v1/job-set/marimohub/sandbox-7');
		expect(calls[0]?.body).toEqual({
			queue: 'marimohub',
			id: 'sandbox-7',
			watch: true,
			errorIfMissing: false,
		});
	});

	it('fails immediately on a terminal failure rather than waiting out the timeout', async () => {
		stubFetch(
			eventStream({
				result: { id: '1', message: { failed: { jobId: 'job-1', reason: 'image pull failed' } } },
			}),
		);

		expect(await rejection(new ArmadaClient(config).waitForRunning(job))).toContain(
			'image pull failed',
		);
	});

	it('keeps waiting through a retryable failure, since another run follows', async () => {
		stubFetch(
			eventStream(
				{
					result: {
						id: '1',
						message: { failed: { jobId: 'job-1', reason: 'node died', retryable: true } },
					},
				},
				{
					result: {
						id: '2',
						message: {
							running: { jobId: 'job-1', clusterId: 'cluster-b', podName: 'armada-job-1-0' },
						},
					},
				},
			),
		);

		const pod: PodLocation = await new ArmadaClient(config).waitForRunning(job);
		expect(pod.clusterId).toBe('cluster-b');
	});

	it('ignores events belonging to another job', async () => {
		stubFetch(
			eventStream({
				result: { id: '1', message: { running: { jobId: 'other', clusterId: 'cluster-x' } } },
			}),
		);

		expect(await rejection(new ArmadaClient(config).waitForRunning(job))).toContain(
			'ended before job job-1 started',
		);
	});

	it('reports a stream-level error', async () => {
		stubFetch(eventStream({ error: { message: 'jobset not found' } }));

		expect(await rejection(new ArmadaClient(config).waitForRunning(job))).toContain(
			'jobset not found',
		);
	});
});

describe('ingressAddress', () => {
	const job: SubmittedJob = { jobId: 'job-1', jobSetId: 'sandbox-7' };

	it('returns the address Armada assigned for the port', async () => {
		stubFetch(
			eventStream(
				{ result: { id: '1', message: { running: { jobId: 'job-1' } } } },
				{
					result: {
						id: '2',
						message: {
							ingressInfo: {
								jobId: 'job-1',
								ingressAddresses: { '2718': '172.18.0.3:31234', '8080': 'other' },
							},
						},
					},
				},
			),
		);

		const address: string = await new ArmadaClient(config).ingressAddress(job, 2718);

		expect(address).toBe('172.18.0.3:31234');
		expect(calls[0]?.url).toBe('http://armada.example.com/v1/job-set/marimohub/sandbox-7');
	});

	it('names the ports the job does expose when ours is not among them', async () => {
		stubFetch(
			eventStream({
				result: {
					id: '1',
					message: { ingressInfo: { jobId: 'job-1', ingressAddresses: { '8080': 'other' } } },
				},
			}),
		);

		const message: string = await rejection(new ArmadaClient(config).ingressAddress(job, 2718));
		expect(message).toContain('no address for port 2718');
		expect(message).toContain('8080');
	});

	it('ignores another job and reports a stream that ends without an answer', async () => {
		stubFetch(
			eventStream({
				result: {
					id: '1',
					message: { ingressInfo: { jobId: 'other', ingressAddresses: { '2718': 'x' } } },
				},
			}),
		);

		expect(await rejection(new ArmadaClient(config).ingressAddress(job, 2718))).toContain(
			'ended before job job-1 reported an ingress address',
		);
	});

	it('fails fast when the job is cancelled instead of waiting out the timeout', async () => {
		stubFetch(eventStream({ result: { id: '1', message: { cancelled: { jobId: 'job-1' } } } }));

		expect(await rejection(new ArmadaClient(config).ingressAddress(job, 2718))).toContain(
			'was cancelled',
		);
	});
});

describe('cancel', () => {
	it('cancels the job by queue, job set and id', async () => {
		stubFetch(Response.json({ cancelledIds: ['job-1'] }));

		await new ArmadaClient(config).cancel({ jobId: 'job-1', jobSetId: 'sandbox-7' });

		expect(calls[0]?.url).toBe('http://armada.example.com/v1/job/cancel');
		expect(calls[0]?.body).toEqual({
			queue: 'marimohub',
			jobSetId: 'sandbox-7',
			jobId: 'job-1',
		});
	});
});
