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
	EventMessage,
	EventStreamLine,
	JobFailedEvent,
	JobIngressInfoEvent,
	JobRunningEvent,
	JobCancelRequest,
	JobSetRequest,
	JobSubmitRequest,
	JobSubmitResponse,
	JobSubmitResponseItem,
	LookoutGetJobsRequest,
	LookoutGetJobsResponse,
	LookoutJob,
} from './armada-types.js';
import { authorizationHeader } from './auth.js';
import type { ArmadaConfig } from './config.js';
import { readNdjson } from './ndjson.js';
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
 * Annotation marking a job as this adapter's, set at submit and filtered on by
 * `listActive`. Job annotations land on the pod too, so the mark is visible
 * from Lookout and from Kubernetes alike.
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
	 */
	async submit(sandboxId: SandboxId, podSpec: V1PodSpec): Promise<SubmittedJob> {
		const request: JobSubmitRequest = {
			queue: this.config.queue,
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
					annotations: { 'armadaproject.io/failFast': 'true', [SANDBOX_MARK]: 'true' },
					services: [{ type: 'NodePort', ports: [this.config.port] }],
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
		return { jobId: item.jobId, jobSetId: sandboxId };
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
			queue: this.config.queue,
			id: job.jobSetId,
			watch: true,
			errorIfMissing: false,
		};
		const path: string = `/v1/job-set/${encodeURIComponent(this.config.queue)}/${encodeURIComponent(job.jobSetId)}`;
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
			queue: this.config.queue,
			id: job.jobSetId,
			watch: true,
			errorIfMissing: false,
		};
		const path: string = `/v1/job-set/${encodeURIComponent(this.config.queue)}/${encodeURIComponent(job.jobSetId)}`;
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

	async cancel(job: SubmittedJob): Promise<void> {
		const request: JobCancelRequest = {
			queue: this.config.queue,
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
	async cancelSet(jobSetId: string): Promise<void> {
		const request: JobCancelRequest = { queue: this.config.queue, jobSetId };
		await this.post('/v1/job/cancel', request);
	}

	/**
	 * Every sandbox with a live job, for marimohub's reconciler.
	 *
	 * Asked of Lookout, not the Armada server, because the server has no "list
	 * the jobs I own" call at all (decision 4). Lookout is the component that
	 * aggregates jobs across every executor cluster, so this needs no cluster
	 * inventory, and it sees jobs still QUEUED, which have no pod anywhere yet.
	 * The filters scope the answer to our queue and to jobs carrying the
	 * {@link SANDBOX_MARK} annotation, because the reconciler destroys
	 * sandboxes it has no record of and must never be shown a job that is not
	 * marimohub's.
	 */
	async listActive(): Promise<ActiveSandbox[]> {
		const lookout: string | undefined = this.config.lookoutUrl;
		if (lookout === undefined) {
			throw new Error('listActive needs ARMADA_LOOKOUT_URL, which is not configured');
		}

		// Keyed by job set so a set holding several jobs (ours hold one) appears
		// once. Insertion order is submission order, per `order` below.
		const sandboxes: Map<string, ActiveSandbox> = new Map();
		for (let skip = 0; ; skip += LIST_ACTIVE_PAGE) {
			const request: LookoutGetJobsRequest = {
				filters: [
					{ field: 'queue', value: this.config.queue, match: 'exact' },
					{ field: 'state', value: ACTIVE_JOB_STATES, match: 'anyOf' },
					{ field: SANDBOX_MARK, value: 'true', match: 'exact', isAnnotation: true },
				],
				order: { field: 'submitted', direction: 'ASC' },
				skip,
				take: LIST_ACTIVE_PAGE,
			};
			// oxlint-disable-next-line no-await-in-loop -- each page's fullness decides whether another exists
			const response: object = await this.postJsonTo(lookout, '/api/v1/jobs', request);
			const jobs: LookoutJob[] = (response as LookoutGetJobsResponse).jobs ?? [];
			for (const job of jobs) {
				if (job.jobSet === undefined || job.jobSet === '') continue;
				sandboxes.set(job.jobSet, {
					id: job.jobSet,
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
