import { afterEach, describe, expect, it } from 'bun:test';
import { ArmadaClient } from '../src/armada.js';
import type { ActiveJob, PodLocation, SubmittedJob } from '../src/armada.js';
import { readConfig } from '../src/config.js';
import type { ArmadaConfig } from '../src/config.js';
import { buildPodSpec } from '../src/podspec.js';
import type { AgentSpec } from '../src/podspec.js';
import type { ActiveSandbox } from '../src/types.js';

const agent: AgentSpec = { tokenSha256: 'ab'.repeat(32) };

const env: Record<string, string> = {
	ARMADA_URL: 'http://armada.example.com/',
	ARMADA_QUEUE: 'marimohub',
	ARMADA_NAMESPACE: 'kernels',
	MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
	ARMADA_AGENT_IMAGE: 'ghcr.io/example/kernel-agent:1',
	ARMADA_AUTH_TOKEN: 'secret',
};

const config: ArmadaConfig = readConfig(env);

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
			buildPodSpec(config, agent),
			'marimohub',
		);

		expect(job).toEqual({ jobId: 'job-1', jobSetId: 'sandbox-7', queue: 'marimohub' });
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
					// The kernel's port and the agent's, so the address event carries both.
					services: [{ type: 'NodePort', ports: [config.port, config.agentPort] }],
				},
			],
		});
	});

	it('asks for an Ingress instead under ARMADA_EXPOSE=ingress', async () => {
		stubFetch(Response.json({ jobResponseItems: [{ jobId: 'job-1' }] }));
		const ingressConfig: ArmadaConfig = readConfig({
			...env,
			ARMADA_EXPOSE: 'ingress',
			ARMADA_INGRESS_CERT_NAME: 'kernels-',
			ARMADA_INGRESS_ANNOTATIONS: '{"nginx.ingress.kubernetes.io/proxy-read-timeout":"3600"}',
		});

		await new ArmadaClient(ingressConfig).submit(
			'sandbox-7',
			buildPodSpec(ingressConfig, agent),
			'marimohub',
		);

		expect(JSON.stringify(calls[0]?.body)).not.toContain('"services"');
		expect(calls[0]?.body).toMatchObject({
			jobRequestItems: [
				{
					ingress: [
						{
							ports: [config.port, config.agentPort],
							tlsEnabled: true,
							certName: 'kernels-',
							// Armada's default is headless, which leaves nothing for a rule to route to.
							useClusterIP: true,
							annotations: { 'nginx.ingress.kubernetes.io/proxy-read-timeout': '3600' },
						},
					],
				},
			],
		});
	});

	it('omits the certificate name and annotations it was not given', async () => {
		stubFetch(Response.json({ jobResponseItems: [{ jobId: 'job-1' }] }));
		const ingressConfig: ArmadaConfig = readConfig({
			...env,
			ARMADA_EXPOSE: 'ingress',
			ARMADA_INGRESS_TLS: 'false',
		});

		await new ArmadaClient(ingressConfig).submit(
			'sandbox-7',
			buildPodSpec(ingressConfig, agent),
			'marimohub',
		);

		const body: string = JSON.stringify(calls[0]?.body);
		expect(body).not.toContain('certName');
		expect(body).not.toContain('annotations":{"nginx');
		expect(calls[0]?.body).toMatchObject({
			jobRequestItems: [
				{
					ingress: [
						{ ports: [config.port, config.agentPort], tlsEnabled: false, useClusterIP: true },
					],
				},
			],
		});
	});

	it('reports a per-item rejection, which arrives inside a 200', async () => {
		stubFetch(Response.json({ jobResponseItems: [{ error: 'queue does not exist' }] }));

		const message: string = await rejection(
			new ArmadaClient(config).submit('s', buildPodSpec(config, agent), 'marimohub'),
		);
		expect(message).toContain('queue does not exist');
	});

	it('surfaces the gateway error body, not just the status', async () => {
		stubFetch(new Response('no such queue', { status: 404 }));

		const message: string = await rejection(
			new ArmadaClient(config).submit('s', buildPodSpec(config, agent), 'marimohub'),
		);
		expect(message).toContain('(404): no such queue');
	});
});

describe('waitForRunning', () => {
	const job: SubmittedJob = { jobId: 'job-1', jobSetId: 'sandbox-7', queue: 'marimohub' };

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
	const job: SubmittedJob = { jobId: 'job-1', jobSetId: 'sandbox-7', queue: 'marimohub' };

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

describe('portUrl', () => {
	const job: SubmittedJob = { jobId: 'job-1', jobSetId: 'sandbox-7', queue: 'marimohub' };

	function addressEvent(address: string): void {
		stubFetch(
			eventStream({
				result: {
					id: '1',
					message: { ingressInfo: { jobId: 'job-1', ingressAddresses: { '2718': address } } },
				},
			}),
		);
	}

	it('is plain http to a NodePort address', async () => {
		addressEvent('172.18.0.3:31234');
		expect(await new ArmadaClient(config).portUrl(job, 2718)).toBe('http://172.18.0.3:31234');
	});

	it('is https to an Ingress hostname when its TLS is on', async () => {
		addressEvent('kernel-2718-armada-job-1-0.kernels.example.com');
		const ingress: ArmadaClient = new ArmadaClient(
			readConfig({ ...env, ARMADA_EXPOSE: 'ingress' }),
		);
		expect(await ingress.portUrl(job, 2718)).toBe(
			'https://kernel-2718-armada-job-1-0.kernels.example.com',
		);
	});

	it('is http to an Ingress hostname when its TLS is off', async () => {
		addressEvent('kernel-2718-armada-job-1-0.kernels.example.com');
		const ingress: ArmadaClient = new ArmadaClient(
			readConfig({ ...env, ARMADA_EXPOSE: 'ingress', ARMADA_INGRESS_TLS: 'false' }),
		);
		expect(await ingress.portUrl(job, 2718)).toBe(
			'http://kernel-2718-armada-job-1-0.kernels.example.com',
		);
	});

	it('keeps a scheme the address already carries', async () => {
		addressEvent('https://already.example.com');
		expect(await new ArmadaClient(config).portUrl(job, 2718)).toBe('https://already.example.com');
	});
});

describe('cancel', () => {
	it('cancels the job by queue, job set and id', async () => {
		stubFetch(Response.json({ cancelledIds: ['job-1'] }));

		await new ArmadaClient(config).cancel({
			jobId: 'job-1',
			jobSetId: 'sandbox-7',
			queue: 'marimohub',
		});

		expect(calls[0]?.url).toBe('http://armada.example.com/v1/job/cancel');
		expect(calls[0]?.body).toEqual({
			queue: 'marimohub',
			jobSetId: 'sandbox-7',
			jobId: 'job-1',
		});
	});

	it('cancels a whole set with no job id, which the server routes to CancelJobSet', async () => {
		stubFetch(Response.json({}));

		await new ArmadaClient(config).cancelSet('sandbox-7', 'marimohub');

		expect(calls[0]?.body).toEqual({ queue: 'marimohub', jobSetId: 'sandbox-7' });
	});
});

const lookoutConfig: ArmadaConfig = readConfig({
	ARMADA_URL: 'http://armada.example.com/',
	ARMADA_QUEUE: 'marimohub',
	ARMADA_LOOKOUT_URL: 'http://lookout.example.com',
	MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
	ARMADA_AGENT_IMAGE: 'ghcr.io/example/kernel-agent:1',
});

/** A full-or-partial Lookout page of jobs, for the pagination test. */
function lookoutPage(start: number, count: number): Response {
	return Response.json({
		jobs: Array.from({ length: count }, (_: unknown, n: number) => ({
			jobSet: `sb-${String(start + n)}`,
			queue: 'marimohub',
		})),
	});
}

describe('listActive', () => {
	it("asks Lookout for active jobs carrying this installation's mark, whatever their queue", async () => {
		stubFetch(
			Response.json({
				jobs: [
					{
						jobId: 'job-1',
						jobSet: 'sb-one',
						queue: 'marimohub',
						state: 'RUNNING',
						submitted: '2026-09-02T12:00:00Z',
					},
					{ jobId: 'job-2', jobSet: 'sb-two', queue: 'team-a', state: 'QUEUED' },
				],
			}),
		);

		const active: ActiveJob[] = await new ArmadaClient(lookoutConfig).listActive();

		expect(calls[0]?.url).toBe('http://lookout.example.com/api/v1/jobs');
		// No queue filter: the mark's value is the default queue name, which
		// names the installation across every queue its map ever used.
		expect(calls[0]?.body).toEqual({
			filters: [
				{ field: 'state', value: ['QUEUED', 'LEASED', 'PENDING', 'RUNNING'], match: 'anyOf' },
				{ field: 'marimohub/sandbox', value: 'marimohub', match: 'exact', isAnnotation: true },
			],
			order: { field: 'submitted', direction: 'ASC' },
			skip: 0,
			take: 500,
		});
		// A QUEUED job has no pod anywhere yet, but its sandbox is on its way and
		// must not look reapable, so it is in the list, with no createdAt to give.
		expect(active).toEqual([
			{ id: 'sb-one', queue: 'marimohub', createdAt: '2026-09-02T12:00:00Z' },
			{ id: 'sb-two', queue: 'team-a' },
		]);
	});

	it('skips a job Lookout reports without a queue rather than guess one', async () => {
		stubFetch(
			Response.json({
				jobs: [
					{ jobId: 'job-1', jobSet: 'sb-one', state: 'RUNNING' },
					{ jobId: 'job-2', jobSet: 'sb-two', queue: 'team-a', state: 'RUNNING' },
				],
			}),
		);

		expect(await new ArmadaClient(lookoutConfig).listActive()).toEqual([
			{ id: 'sb-two', queue: 'team-a' },
		]);
	});

	it('pages until a page comes back short', async () => {
		let requests = 0;
		stubFetch((): Response => (requests++ === 0 ? lookoutPage(0, 500) : lookoutPage(500, 1)));

		const active: ActiveSandbox[] = await new ArmadaClient(lookoutConfig).listActive();

		expect(calls).toHaveLength(2);
		expect(calls[1]?.body).toMatchObject({ skip: 500 });
		expect(active).toHaveLength(501);
	});

	it('rejects with the missing variable when Lookout is not configured', async () => {
		expect(await rejection(new ArmadaClient(config).listActive())).toContain('ARMADA_LOOKOUT_URL');
	});
});

describe('findQueue', () => {
	it('asks Lookout for the marked job set and returns its queue', async () => {
		stubFetch(Response.json({ jobs: [{ jobId: 'job-1', jobSet: 'sb-one', queue: 'team-a' }] }));

		expect(await new ArmadaClient(lookoutConfig).findQueue('sb-one')).toBe('team-a');
		expect(calls[0]?.url).toBe('http://lookout.example.com/api/v1/jobs');
		expect(calls[0]?.body).toEqual({
			filters: [
				{ field: 'jobSet', value: 'sb-one', match: 'exact' },
				{ field: 'marimohub/sandbox', value: 'marimohub', match: 'exact', isAnnotation: true },
			],
			order: { field: 'submitted', direction: 'DESC' },
			skip: 0,
			take: 1,
		});
	});

	it('is undefined for a job set Lookout does not know, and without Lookout at all', async () => {
		stubFetch(Response.json({ jobs: [] }));
		expect(await new ArmadaClient(lookoutConfig).findQueue('sb-none')).toBeUndefined();
		expect(await new ArmadaClient(config).findQueue('sb-none')).toBeUndefined();
		expect(calls).toHaveLength(1);
	});
});

describe('submit to a mapped queue', () => {
	it('sends the queue it was given, not the default', async () => {
		stubFetch(Response.json({ jobResponseItems: [{ jobId: 'job-1' }] }));

		const job: SubmittedJob = await new ArmadaClient(config).submit(
			'sandbox-7',
			buildPodSpec(config, agent),
			'team-b',
		);

		expect(job.queue).toBe('team-b');
		expect(calls[0]?.body).toMatchObject({ queue: 'team-b', jobSetId: 'sandbox-7' });
	});
});
