/**
 * The slice of Armada's REST API this adapter speaks, hand-written.
 *
 * Armada's grpc-gateway publishes a full spec (`GET /swagger.json`), but we call
 * four endpoints, and 165 of the 249 definitions it reaches are embedded
 * Kubernetes types we already have from `@kubernetes/client-node`. Generating the
 * lot would bury a dozen useful types in six thousand lines that churn on every
 * Armada release for endpoints we never touch.
 *
 * `bun run check:armada-api` verifies every field below against the spec of the
 * release named in `.armada-version`, so an Armada bump that moves something we
 * depend on fails in CI rather than at runtime.
 *
 * Everything the gateway sends is optional: this is proto3 JSON, which omits
 * fields at their default. Fields we always send on requests are required here,
 * which is stricter than the wire, never looser.
 */
import type { V1PodSpec } from '@kubernetes/client-node';

/** `POST /v1/job/submit` */
export interface JobSubmitRequest {
	queue: string;
	jobSetId: string;
	jobRequestItems: JobSubmitRequestItem[];
}

export interface JobSubmitRequestItem {
	/** Dedupe key: resubmitting with the same value returns the original job. */
	clientId: string;
	namespace: string;
	podSpec: V1PodSpec;
	/** Our own identifier for the job. Queryable via `/v1/job/statusUsingExternalJobUri`. */
	externalJobUri?: string;
	ingress?: IngressConfig[];
	services?: ServiceConfig[];
	labels?: Record<string, string>;
	annotations?: Record<string, string>;
	priority?: number;
}

export interface IngressConfig {
	type?: 'Ingress';
	ports: number[];
	tlsEnabled?: boolean;
	certName?: string;
	useClusterIP?: boolean;
	annotations?: Record<string, string>;
}

export interface ServiceConfig {
	name?: string;
	type?: 'NodePort' | 'Headless';
	ports: number[];
}

export interface JobSubmitResponse {
	jobResponseItems?: JobSubmitResponseItem[];
}

export interface JobSubmitResponseItem {
	jobId?: string;
	/** Per-item failure; the request as a whole can still be a 200. */
	error?: string;
}

/** `POST /v1/job-set/{queue}/{id}`, an `application/ndjson-stream` response. */
export interface JobSetRequest {
	queue: string;
	id: string;
	/** Keep the stream open instead of ending at the last existing message. */
	watch: boolean;
	fromMessageId?: string;
	errorIfMissing?: boolean;
}

/** One newline-delimited line of that stream. */
export interface EventStreamLine {
	result?: EventStreamMessage;
	error?: StreamError;
}

export interface StreamError {
	message?: string;
	grpcCode?: number;
	httpCode?: number;
	httpStatus?: string;
}

export interface EventStreamMessage {
	/** Cursor: pass back as `fromMessageId` to resume. */
	id?: string;
	message?: EventMessage;
}

/** A union in the proto; exactly one key is set. Only the events we act on. */
export interface EventMessage {
	running?: JobRunningEvent;
	ingressInfo?: JobIngressInfoEvent;
	failed?: JobFailedEvent;
	cancelled?: JobLifecycleEvent;
	succeeded?: JobLifecycleEvent;
}

/** Fields every job event carries. */
interface JobEventBase {
	jobId?: string;
	jobSetId?: string;
	queue?: string;
	created?: string;
}

/** Events we observe but read nothing else from. */
export type JobLifecycleEvent = JobEventBase;

/** Where the pod landed. The whole reason the control channel can work. */
export interface JobRunningEvent extends JobEventBase {
	clusterId?: string;
	podName?: string;
	podNamespace?: string;
	nodeName?: string;
	podNumber?: number;
}

export interface JobIngressInfoEvent extends JobEventBase {
	clusterId?: string;
	podName?: string;
	podNamespace?: string;
	/** Port to the address Armada assigned it. */
	ingressAddresses?: Record<string, string>;
}

export interface JobFailedEvent extends JobEventBase {
	reason?: string;
	cause?: string;
	failureCategory?: string;
	failureSubcategory?: string;
	/**
	 * True when the scheduler will retry this run, so the failure is not terminal
	 * and further events follow for the same job. Absent means terminal.
	 */
	retryable?: boolean;
	/** Deprecated upstream in favour of container statuses; kept for the message. */
	exitCodes?: Record<string, number>;
}

/** `POST /v1/job/cancel` */
export interface JobCancelRequest {
	queue: string;
	jobSetId: string;
	jobId?: string;
	jobIds?: string[];
	reason?: string;
}

export interface CancellationResult {
	cancelledIds?: string[];
}

/**
 * `POST /v1/job/statusUsingExternalJobUri`
 *
 * How we find our own jobs again after a restart. Armada has no "list the jobs I
 * own" call: `/v1/job/details` and `/v1/job/status` both take explicit job ids,
 * and `/v1/queues/active` returns queue names. This is the only lookup keyed by
 * something we choose, so `externalJobUri` is set at submit time.
 */
export interface JobStatusUsingExternalJobUriRequest {
	queue: string;
	jobset: string;
	externalJobUri: string;
}

export interface JobStatusResponse {
	/** Job id to state. */
	jobStates?: Record<string, JobState>;
}

export type JobState =
	| 'QUEUED'
	| 'PENDING'
	| 'RUNNING'
	| 'SUCCEEDED'
	| 'FAILED'
	| 'UNKNOWN'
	| 'SUBMITTED'
	| 'LEASED'
	| 'PREEMPTED'
	| 'CANCELLED'
	| 'REJECTED';

/*
 * Lookout's job-query API, a separate service from the Armada server with its
 * own spec (`internal/lookout/swagger.yaml` in the Armada repo, not
 * `api.swagger.json`). It exists here because enumeration is the one question
 * the server cannot answer: Lookout is the component that aggregates jobs
 * across every executor cluster, which is why its UI can list them and the
 * server API cannot. The contract check verifies these fields against the
 * swagger at the pinned release, like everything above.
 */

/** One predicate of `POST /api/v1/jobs` (`definitions.filter`). */
export interface LookoutFilter {
	field: string;
	/** The swagger says `object`; in practice a scalar, or an array for `anyOf`. */
	value: string | number | string[];
	match:
		| 'exact'
		| 'anyOf'
		| 'startsWith'
		| 'contains'
		| 'greaterThan'
		| 'lessThan'
		| 'greaterThanOrEqualTo'
		| 'lessThanOrEqualTo'
		| 'exists';
	/** Match `field` against the job's annotations instead of its columns. */
	isAnnotation?: boolean;
}

/** `definitions.order` */
export interface LookoutOrder {
	field: string;
	direction: 'ASC' | 'DESC';
}

/** `POST /api/v1/jobs` request body. */
export interface LookoutGetJobsRequest {
	filters: LookoutFilter[];
	order: LookoutOrder;
	/** First elements to skip, for pagination. */
	skip: number;
	/** Page size. */
	take: number;
}

/** The fields of `definitions.job` we read; the response carries many more. */
export interface LookoutJob {
	jobId?: string;
	/** Which queue holds the job; a sandbox's queue after a restart (`src/queues.ts`). */
	queue?: string;
	/** Our job set id is the sandbox id, so this is how a job names its sandbox. */
	jobSet?: string;
	state?: string;
	/** RFC 3339 submission time. */
	submitted?: string;
}

/** `POST /api/v1/jobs` response body. */
export interface LookoutGetJobsResponse {
	jobs?: LookoutJob[];
}
