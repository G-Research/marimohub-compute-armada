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
	JobRunningEvent,
	JobCancelRequest,
	JobSetRequest,
	JobSubmitRequest,
	JobSubmitResponse,
	JobSubmitResponseItem,
} from './armada-types.js';
import { authorizationHeader } from './auth.js';
import type { ArmadaConfig } from './config.js';
import { readNdjson } from './ndjson.js';
import type { SandboxId } from './types.js';

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
					// name, so fail terminally and let marimohub offer the retry.
					annotations: { 'armadaproject.io/failFast': 'true' },
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
	 * Ingress address Armada assigned for a port, from `JobIngressInfoEvent`
	 * (`ingress_addresses` maps port to address).
	 */
	async ingressAddress(_job: SubmittedJob, _port: number): Promise<string> {
		throw new Error('ArmadaClient.ingressAddress is not implemented');
	}

	async cancel(job: SubmittedJob): Promise<void> {
		const request: JobCancelRequest = {
			queue: this.config.queue,
			jobSetId: job.jobSetId,
			jobId: job.jobId,
		};
		await this.post('/v1/job/cancel', request);
	}

	/** Jobs this deployment owns, for the reconciler. */
	async listActive(): Promise<SubmittedJob[]> {
		throw new Error('ArmadaClient.listActive is not implemented');
	}

	private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
		const response: Response = await fetch(`${this.config.url.replace(/\/$/, '')}${path}`, {
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
}
