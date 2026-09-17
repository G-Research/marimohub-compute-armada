/**
 * Placement half of the adapter: submit a job, follow its event stream, and
 * resolve where it landed.
 *
 * There is no official JS/TS Armada client (Go, Java, Scala, Python and .NET
 * only), so this talks to the grpc-gateway REST endpoints. The protos carry
 * `google.api.http` annotations, so every RPC has an HTTP form.
 */
import type { V1PodSpec } from '@kubernetes/client-node';
import type {
	LookoutFilter,
	EventMessage,
	EventStreamLine,
	JobFailedEvent,
	JobIngressInfoEvent,
	JobRunningEvent,
	JobCancelRequest,
	JobSetRequest,
	JobSubmitRequest,
	JobSubmitRequestItem,
	JobSubmitResponse,
	JobSubmitResponseItem,
	LookoutGetJobsRequest,
	LookoutGetJobsResponse,
	LookoutJob,
} from './armada-types.js';
import { authorizationHeader } from './auth.js';
import type { ArmadaConfig, Exposure } from './config.js';
import { readNdjson } from './ndjson.js';
import { exposedPorts } from './podspec.js';
import type { ActiveSandbox, SandboxId } from './types.js';

/** Where a running job's pod lives, from `JobRunningEvent`. */
export interface PodLocation {
	clusterId: string;
	podName: string;
	podNamespace: string;
	nodeName?: string;
}

export interface SubmittedJob {
	jobId: string;
	jobSetId: string;
	/** Every later call about the job is addressed by queue and job set. */
	queue: string;
}

/** A live job as Lookout reports it: the sandbox, and the queue that holds it. */
export interface ActiveJob extends ActiveSandbox {
	queue: string;
}

/**
 * Every Armada response type we read has only optional fields, so a JSON object
 * is structurally one of them. Checking that much and no more keeps the parse
 * honest without a schema validator: a field we read but the server stopped
 * sending is caught by `bun run check:armada-api`, not at runtime.
 */
function asObject(value: unknown, what: string): object {
	if (typeof value !== 'object' || value === null) {
		throw new Error(`Armada returned ${what} that is not a JSON object: ${JSON.stringify(value)}`);
	}
	return value;
}

/** Long enough for an image pull on a cold node, short enough to fail a wedged queue. */
const DEFAULT_RUNNING_TIMEOUT_MS = 5 * 60 * 1000;

/** The ingress event lands around Running, so by expose time it usually replays. */
const DEFAULT_INGRESS_TIMEOUT_MS = 60 * 1000;

/**
 * Annotation marking a job as this installation's, set at submit and filtered
 * on by `listActive` and `findQueue`. Its value is the default queue name
 * (`ARMADA_QUEUE`), which names one marimohub installation however many queues
 * its owner map spreads jobs over, so enumeration does not depend on the map
 * of the day and two installations sharing an Armada never see each other's
 * sandboxes. Job annotations land on the pod too, so the mark is visible from
 * Lookout and from Kubernetes alike.
 */
export const SANDBOX_MARK = 'marimohub/sandbox';

/** Lookout job states meaning "this sandbox is alive or on its way". */
const ACTIVE_JOB_STATES: string[] = ['QUEUED', 'LEASED', 'PENDING', 'RUNNING'];

/** Lookout page size; more active kernels than this loops rather than truncates. */
const LIST_ACTIVE_PAGE = 500;

export class ArmadaClient {
	constructor(private readonly config: ArmadaConfig) {}

	/**
	 * Headers for every call to the gateway.
	 *
	 * Authorization is resolved per request rather than at construction, so a
	 * token file that is rotated under us is picked up without a restart.
	 */
	async requestHeaders(): Promise<Record<string, string>> {
		const authorization: string | undefined = await authorizationHeader(this.config.auth);
		return {
			'content-type': 'application/json',
			...(authorization === undefined ? {} : { authorization }),
		};
	}

	/**
	 * Submit one job for a sandbox.
	 *
	 * The sandbox id is used three times over, each for a different reason:
	 * `clientId` so a resubmit dedupes instead of starting a second kernel,
	 * `jobSetId` so this sandbox's events are their own stream, and
	 * `externalJobUri` because it is the only way to find the job again later.
	 *
	 * The queue is the caller's choice (`src/queues.ts`) and travels with the
	 * returned job, since every later call is addressed by it.
	 */
	async submit(sandboxId: SandboxId, podSpec: V1PodSpec, queue: string): Promise<SubmittedJob> {
		const ports: number[] = exposedPorts(podSpec);
		const expose: Exposure = this.config.expose;
		// Either way the executor reports one address per port in the same event.
		// An Ingress needs a service behind it, and Armada creates that itself: a
		// ClusterIP one, since a headless service (Armada's default) leaves the
		// ingress controller to resolve pod IPs on its own.
		const exposure: Pick<JobSubmitRequestItem, 'ingress' | 'services'> =
			expose.kind === 'ingress'
				? {
						ingress: [
							{
								ports,
								tlsEnabled: expose.tls,
								...(expose.certName === undefined ? {} : { certName: expose.certName }),
								useClusterIP: true,
								...(Object.keys(expose.annotations).length === 0
									? {}
									: { annotations: expose.annotations }),
							},
						],
					}
				: { services: [{ type: 'NodePort', ports }] };
		const request: JobSubmitRequest = {
			queue,
			jobSetId: sandboxId,
			jobRequestItems: [
				{
					clientId: sandboxId,
					externalJobUri: sandboxId,
					namespace: this.config.namespace,
					podSpec,
					// A retry would hand the user an empty kernel wearing their session's
					// name, so fail terminally and let marimohub offer the retry. The
					// sandbox mark is what `listActive` filters on: a queue may hold jobs
					// that are not marimohub's, and enumeration feeds a reconciler that
					// destroys what it does not recognise, so only marked jobs may appear.
					annotations: { 'armadaproject.io/failFast': 'true', [SANDBOX_MARK]: this.config.queue },
					...exposure,
				},
			],
		};

		const response: JobSubmitResponse = await this.postJson('/v1/job/submit', request);
		const item: JobSubmitResponseItem | undefined = response.jobResponseItems?.[0];
		if (item?.error !== undefined && item.error !== '') {
			throw new Error(`Armada rejected the job for sandbox ${sandboxId}: ${item.error}`);
		}
		if (item?.jobId === undefined || item.jobId === '') {
			throw new Error(`Armada returned no job id for sandbox ${sandboxId}`);
		}
		return { jobId: item.jobId, jobSetId: sandboxId, queue };
	}

	/**
	 * Block until the job reaches Running, returning where its pod landed.
	 *
	 * Terminal failures arrive on the same stream, so we react to them rather than
	 * waiting out the timeout with no explanation. A failure marked `retryable` is
	 * the scheduler saying another run follows, so it is not the end.
	 */
	async waitForRunning(
		job: SubmittedJob,
		timeoutMs: number = DEFAULT_RUNNING_TIMEOUT_MS,
	): Promise<PodLocation> {
		const request: JobSetRequest = {
			queue: job.queue,
			id: job.jobSetId,
			watch: true,
			errorIfMissing: false,
		};
		const path: string = `/v1/job-set/${encodeURIComponent(job.queue)}/${encodeURIComponent(job.jobSetId)}`;
		const response: Response = await this.post(path, request, AbortSignal.timeout(timeoutMs));
		if (response.body === null) throw new Error(`Armada returned no event stream for ${path}`);

		for await (const value of readNdjson(response.body)) {
			const line: EventStreamLine = asObject(value, 'an event stream line');
			if (line.error !== undefined) {
				throw new Error(`Armada event stream failed: ${line.error.message ?? 'unknown error'}`);
			}

			const message: EventMessage | undefined = line.result?.message;
			if (message === undefined) continue;

			const running: JobRunningEvent | undefined = message.running;
			if (running !== undefined && running.jobId === job.jobId) {
				return {
					clusterId: running.clusterId ?? '',
					podName: running.podName ?? '',
					podNamespace: running.podNamespace ?? this.config.namespace,
					...(running.nodeName === undefined ? {} : { nodeName: running.nodeName }),
				};
			}

			const failed: JobFailedEvent | undefined = message.failed;
			if (failed !== undefined && failed.jobId === job.jobId && failed.retryable !== true) {
				throw new Error(`Armada job ${job.jobId} failed: ${failed.reason ?? 'no reason given'}`);
			}

			if (message.cancelled !== undefined && message.cancelled.jobId === job.jobId) {
				throw new Error(`Armada job ${job.jobId} was cancelled before it started`);
			}
		}

		throw new Error(`Armada event stream ended before job ${job.jobId} started`);
	}

	/**
	 * The address Armada assigned for a container port, from
	 * `JobIngressInfoEvent`: `hostIP:nodePort` for a NodePort service, the rule
	 * host for an Ingress. The stream replays existing messages before watching,
	 * so an address reported before this call resolves without waiting.
	 *
	 * The event carries every exposed port at once, so an event for our job that
	 * lacks the asked-for port is a configuration error, not something to wait
	 * out.
	 */
	async ingressAddress(
		job: SubmittedJob,
		port: number,
		timeoutMs: number = DEFAULT_INGRESS_TIMEOUT_MS,
	): Promise<string> {
		const request: JobSetRequest = {
			queue: job.queue,
			id: job.jobSetId,
			watch: true,
			errorIfMissing: false,
		};
		const path: string = `/v1/job-set/${encodeURIComponent(job.queue)}/${encodeURIComponent(job.jobSetId)}`;
		const response: Response = await this.post(path, request, AbortSignal.timeout(timeoutMs));
		if (response.body === null) throw new Error(`Armada returned no event stream for ${path}`);

		for await (const value of readNdjson(response.body)) {
			const line: EventStreamLine = asObject(value, 'an event stream line');
			if (line.error !== undefined) {
				throw new Error(`Armada event stream failed: ${line.error.message ?? 'unknown error'}`);
			}

			const message: EventMessage | undefined = line.result?.message;
			if (message === undefined) continue;

			const info: JobIngressInfoEvent | undefined = message.ingressInfo;
			if (info !== undefined && info.jobId === job.jobId) {
				const address: string | undefined = info.ingressAddresses?.[String(port)];
				if (address !== undefined && address !== '') return address;
				const known: string = Object.keys(info.ingressAddresses ?? {}).join(', ');
				throw new Error(
					`Armada reported no address for port ${String(port)} of job ${job.jobId}; it exposes: ${known === '' ? 'nothing' : known}`,
				);
			}

			const failed: JobFailedEvent | undefined = message.failed;
			if (failed !== undefined && failed.jobId === job.jobId && failed.retryable !== true) {
				throw new Error(`Armada job ${job.jobId} failed: ${failed.reason ?? 'no reason given'}`);
			}

			if (message.cancelled !== undefined && message.cancelled.jobId === job.jobId) {
				throw new Error(`Armada job ${job.jobId} was cancelled`);
			}
		}

		throw new Error(
			`Armada event stream ended before job ${job.jobId} reported an ingress address`,
		);
	}

	/**
	 * `ingressAddress` as a URL. The scheme is the submit's to choose, since the
	 * submit is what decided whether the address is a NodePort on the cluster
	 * network or an Ingress hostname with or without a certificate.
	 */
	async portUrl(job: SubmittedJob, port: number): Promise<string> {
		const address: string = await this.ingressAddress(job, port);
		if (address.includes('://')) return address;
		const expose: Exposure = this.config.expose;
		const scheme: string = expose.kind === 'ingress' && expose.tls ? 'https' : 'http';
		return `${scheme}://${address}`;
	}

	async cancel(job: SubmittedJob): Promise<void> {
		const request: JobCancelRequest = {
			queue: job.queue,
			jobSetId: job.jobSetId,
			jobId: job.jobId,
		};
		await this.post('/v1/job/cancel', request);
	}

	/**
	 * Cancel every job in a set, for a sandbox this process never submitted.
	 *
	 * The reconciler addresses sandboxes by id alone, and a job set id is a
	 * sandbox id, so no job lookup is needed: a cancel with no job id is
	 * explicitly redirected to CancelJobSet by the server
	 * (`internal/server/submit/submit.go:170`). Cancelling a set that no longer
	 * exists (or never did) is a no-op, not an error.
	 */
	async cancelSet(jobSetId: string, queue: string): Promise<void> {
		const request: JobCancelRequest = { queue, jobSetId };
		await this.post('/v1/job/cancel', request);
	}

	/**
	 * Which queue holds a sandbox's job, asked of Lookout by job set, for a
	 * sandbox this process never submitted and has not enumerated
	 * (`src/queues.ts`). `undefined` when no live or finished job carries the set
	 * and the mark, or when Lookout is not configured; rejects when Lookout
	 * cannot be asked, which the directory turns into a `QueueUnknownError`.
	 */
	async findQueue(jobSetId: SandboxId): Promise<string | undefined> {
		const lookout: string | undefined = this.config.lookoutUrl;
		if (lookout === undefined) return undefined;
		const jobs: LookoutJob[] = await this.lookoutJobs(
			lookout,
			[{ field: 'jobSet', value: jobSetId, match: 'exact' }],
			{ field: 'submitted', direction: 'DESC' },
			0,
			1,
		);
		const queue: string | undefined = jobs[0]?.queue;
		return queue === undefined || queue === '' ? undefined : queue;
	}

	/**
	 * One page of Lookout's job list, always scoped by the {@link SANDBOX_MARK}
	 * annotation carrying this installation's name: the reconciler destroys
	 * what `listActive` returns, and Lookout sees every queue of every tenant,
	 * so an unmarked answer would cancel strangers' work on the next sweep.
	 */
	private async lookoutJobs(
		lookout: string,
		filters: LookoutFilter[],
		order: LookoutGetJobsRequest['order'],
		skip: number,
		take: number,
	): Promise<LookoutJob[]> {
		const request: LookoutGetJobsRequest = {
			filters: [
				...filters,
				{ field: SANDBOX_MARK, value: this.config.queue, match: 'exact', isAnnotation: true },
			],
			order,
			skip,
			take,
		};
		const response: object = await this.postJsonTo(lookout, '/api/v1/jobs', request);
		return (response as LookoutGetJobsResponse).jobs ?? [];
	}

	/**
	 * Every sandbox with a live job, for marimohub's reconciler.
	 *
	 * Asked of Lookout, not the Armada server, because the server has no "list
	 * the jobs I own" call at all. Lookout is the component that
	 * aggregates jobs across every executor cluster, so this needs no cluster
	 * inventory, and it sees jobs still QUEUED, which have no pod anywhere yet.
	 * The answer is scoped by the mark alone, not by queue: a job is this
	 * installation's wherever the owner map of the day put it, or a map since
	 * retired. Each job comes back with its queue, so a sandbox found here can
	 * be cancelled without another lookup; a job Lookout reports without one is
	 * skipped rather than guessed at.
	 */
	async listActive(): Promise<ActiveJob[]> {
		const lookout: string | undefined = this.config.lookoutUrl;
		if (lookout === undefined) {
			throw new Error('listActive needs ARMADA_LOOKOUT_URL, which is not configured');
		}

		// Keyed by job set so a set holding several jobs (ours hold one) appears
		// once. Insertion order is submission order, per `order` below.
		const sandboxes: Map<string, ActiveJob> = new Map();
		for (let skip = 0; ; skip += LIST_ACTIVE_PAGE) {
			// oxlint-disable-next-line no-await-in-loop -- each page's fullness decides whether another exists
			const jobs: LookoutJob[] = await this.lookoutJobs(
				lookout,
				[{ field: 'state', value: ACTIVE_JOB_STATES, match: 'anyOf' }],
				{ field: 'submitted', direction: 'ASC' },
				skip,
				LIST_ACTIVE_PAGE,
			);
			for (const job of jobs) {
				if (job.jobSet === undefined || job.jobSet === '') continue;
				if (job.queue === undefined || job.queue === '') continue;
				sandboxes.set(job.jobSet, {
					id: job.jobSet,
					queue: job.queue,
					...(job.submitted === undefined ? {} : { createdAt: job.submitted }),
				});
			}
			if (jobs.length < LIST_ACTIVE_PAGE) return [...sandboxes.values()];
		}
	}

	private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
		return this.postTo(this.config.url, path, body, signal);
	}

	private async postTo(
		base: string,
		path: string,
		body: unknown,
		signal?: AbortSignal,
	): Promise<Response> {
		const response: Response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
			method: 'POST',
			headers: await this.requestHeaders(),
			body: JSON.stringify(body),
			...(signal === undefined ? {} : { signal }),
		});

		if (!response.ok) {
			// The gateway puts the useful part in the body, not the status text.
			const detail: string = (await response.text()).trim();
			throw new Error(
				`Armada ${path} failed (${response.status}): ${detail === '' ? response.statusText : detail}`,
			);
		}
		return response;
	}

	private async postJson(path: string, body: unknown): Promise<object> {
		const response: Response = await this.post(path, body);
		return asObject(await response.json(), `a response to ${path}`);
	}

	private async postJsonTo(base: string, path: string, body: unknown): Promise<object> {
		const response: Response = await this.postTo(base, path, body);
		return asObject(await response.json(), `a response to ${path}`);
	}
}
