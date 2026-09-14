/**
 * Verifies the hand-written types in `src/armada-types.ts` against the real
 * Armada spec.
 *
 * We hand-write the wire types rather than generate them (see that file), which
 * trades generated-code churn for the risk of drifting from the server. This
 * closes that gap: the table below names every field we depend on, and the check
 * fetches `pkg/api/api.swagger.json` at the release in `.armada-version` and
 * fails if any of them moved.
 *
 * Run it after changing anything Armada-related, and after bumping the pinned
 * version. CI runs it too, whenever one of those files changed.
 */
import { readFileSync } from 'node:fs';

interface SwaggerSchema {
	type?: string;
	$ref?: string;
	enum?: string[];
	properties?: Record<string, SwaggerSchema>;
	items?: SwaggerSchema;
}

interface SwaggerDoc {
	definitions?: Record<string, SwaggerSchema>;
	paths?: Record<string, Record<string, unknown>>;
}

/** The JSON type a field must still have. `ref` is "points at another definition". */
type FieldType = 'string' | 'boolean' | 'integer' | 'number' | 'object' | 'array' | 'ref';

/** Endpoint to the method we call it with. */
const ENDPOINTS: Record<string, string> = {
	'/v1/job/submit': 'post',
	'/v1/job-set/{queue}/{id}': 'post',
	'/v1/job/cancel': 'post',
	'/v1/job/statusUsingExternalJobUri': 'post',
};

/** Every field `src/armada-types.ts` names, and the type we read it as. */
const CONTRACT: Record<string, Record<string, FieldType>> = {
	apiJobSubmitRequest: { queue: 'string', jobSetId: 'string', jobRequestItems: 'array' },
	apiJobSubmitRequestItem: {
		clientId: 'string',
		namespace: 'string',
		podSpec: 'ref',
		externalJobUri: 'string',
		ingress: 'array',
		services: 'array',
		labels: 'object',
		annotations: 'object',
		priority: 'number',
	},
	apiIngressConfig: {
		type: 'ref',
		ports: 'array',
		tlsEnabled: 'boolean',
		certName: 'string',
		useClusterIP: 'boolean',
		annotations: 'object',
	},
	apiServiceConfig: { name: 'string', type: 'ref', ports: 'array' },
	apiJobSubmitResponse: { jobResponseItems: 'array' },
	apiJobSubmitResponseItem: { jobId: 'string', error: 'string' },
	apiJobSetRequest: {
		queue: 'string',
		id: 'string',
		watch: 'boolean',
		fromMessageId: 'string',
		errorIfMissing: 'boolean',
	},
	apiEventStreamMessage: { id: 'string', message: 'ref' },
	apiEventMessage: {
		running: 'ref',
		ingressInfo: 'ref',
		failed: 'ref',
		cancelled: 'ref',
		succeeded: 'ref',
	},
	apiJobRunningEvent: {
		jobId: 'string',
		jobSetId: 'string',
		queue: 'string',
		created: 'string',
		clusterId: 'string',
		podName: 'string',
		podNamespace: 'string',
		nodeName: 'string',
		podNumber: 'integer',
	},
	apiJobIngressInfoEvent: {
		jobId: 'string',
		clusterId: 'string',
		podName: 'string',
		podNamespace: 'string',
		ingressAddresses: 'object',
	},
	apiJobFailedEvent: {
		jobId: 'string',
		reason: 'string',
		cause: 'ref',
		failureCategory: 'string',
		failureSubcategory: 'string',
		retryable: 'boolean',
		exitCodes: 'object',
	},
	apiJobCancelRequest: {
		queue: 'string',
		jobSetId: 'string',
		jobId: 'string',
		jobIds: 'array',
		reason: 'string',
	},
	apiCancellationResult: { cancelledIds: 'array' },
	apiJobStatusUsingExternalJobUriRequest: {
		queue: 'string',
		jobset: 'string',
		externalJobUri: 'string',
	},
	apiJobStatusResponse: { jobStates: 'object' },
	runtimeStreamError: {
		message: 'string',
		grpcCode: 'integer',
		httpCode: 'integer',
		httpStatus: 'string',
	},
};

/** Enum members we hard-code as string literals. */
const ENUMS: Record<string, readonly string[]> = {
	apiIngressType: ['Ingress'],
	apiServiceType: ['NodePort', 'Headless'],
	apiJobState: [
		'QUEUED',
		'PENDING',
		'RUNNING',
		'SUCCEEDED',
		'FAILED',
		'UNKNOWN',
		'SUBMITTED',
		'LEASED',
		'PREEMPTED',
		'CANCELLED',
		'REJECTED',
	],
};

/**
 * What `listActive` reads from Lookout, whose spec is a separate file
 * (`internal/lookout/swagger.yaml`) and YAML rather than JSON. We own no YAML
 * parser and a handful of fields does not justify one, so these are checked as
 * tokens in the raw text: a rename or removal makes its token vanish, which is
 * the drift this guards against. Coarser than the structural check above, and
 * deliberately so.
 */
const LOOKOUT_TOKENS: readonly string[] = [
	// The one endpoint we call, and its request shape.
	'/api/v1/jobs:',
	'filters:',
	'order:',
	'skip:',
	'take:',
	// The filter definition: match modes we send, and annotation matching.
	'isAnnotation:',
	'- exact',
	'- anyOf',
	// The job fields we read. `jobSet` is the sandbox id, `submitted` becomes
	// `createdAt`.
	'jobSet:',
	'queue:',
	'submitted:',
	'state:',
	'jobs:',
];

function actualType(schema: SwaggerSchema): string {
	if (schema.$ref !== undefined) return 'ref';
	return schema.type ?? 'unknown';
}

/** Fetch a spec file at the pinned release, failing loudly when it is missing. */
async function fetchSpec(url: string): Promise<string> {
	const response: Response = await fetch(url);
	if (!response.ok) {
		throw new Error(`could not fetch the spec (${response.status}): ${url}`);
	}
	return response.text();
}

async function main(): Promise<void> {
	const version: string = (
		process.env['ARMADA_VERSION'] ?? readFileSync('.armada-version', 'utf8')
	).trim();
	const url: string = `https://raw.githubusercontent.com/armadaproject/armada/${version}/pkg/api/api.swagger.json`;

	console.log(`checking src/armada-types.ts against armada ${version}`);
	const parsed: unknown = JSON.parse(await fetchSpec(url));
	if (typeof parsed !== 'object' || parsed === null) {
		throw new Error(`the spec at ${url} is not a JSON object`);
	}
	const doc: SwaggerDoc = parsed;
	const definitions: Record<string, SwaggerSchema> = doc.definitions ?? {};
	const problems: string[] = [];

	for (const [path, method] of Object.entries(ENDPOINTS)) {
		if (doc.paths?.[path]?.[method] === undefined) {
			problems.push(`endpoint ${method.toUpperCase()} ${path} is gone`);
		}
	}

	for (const [name, fields] of Object.entries(CONTRACT)) {
		const definition: SwaggerSchema | undefined = definitions[name];
		if (definition === undefined) {
			problems.push(`definition ${name} is gone`);
			continue;
		}
		for (const [field, expected] of Object.entries(fields)) {
			const property: SwaggerSchema | undefined = definition.properties?.[field];
			if (property === undefined) {
				problems.push(`${name}.${field} is gone`);
				continue;
			}
			const actual: string = actualType(property);
			if (actual !== expected) {
				problems.push(`${name}.${field} is ${actual} now, we read it as ${expected}`);
			}
		}
	}

	for (const [name, members] of Object.entries(ENUMS)) {
		const values: string[] = definitions[name]?.enum ?? [];
		for (const member of members) {
			if (!values.includes(member)) {
				problems.push(`${name} no longer has the member ${member} (has: ${values.join(', ')})`);
			}
		}
	}

	const lookoutUrl: string = `https://raw.githubusercontent.com/armadaproject/armada/${version}/internal/lookout/swagger.yaml`;
	const lookoutSpec: string = await fetchSpec(lookoutUrl);
	for (const token of LOOKOUT_TOKENS) {
		if (!lookoutSpec.includes(token)) {
			problems.push(`lookout swagger no longer contains "${token}" (${lookoutUrl})`);
		}
	}

	if (problems.length > 0) {
		console.error(`\n${problems.length} mismatch(es) against armada ${version}:\n`);
		for (const problem of problems) console.error(`  ${problem}`);
		console.error(
			'\nFix src/armada-types.ts and the CONTRACT table in this script together.\n' +
				'The spec is at ' +
				url +
				'\n',
		);
		process.exit(1);
	}

	const fieldCount: number = Object.values(CONTRACT).reduce(
		(total: number, fields: Record<string, FieldType>) => total + Object.keys(fields).length,
		0,
	);
	console.log(
		`ok: ${Object.keys(ENDPOINTS).length} endpoints, ${Object.keys(CONTRACT).length} definitions, ${fieldCount} fields, ${LOOKOUT_TOKENS.length} lookout tokens`,
	);
}

await main();
