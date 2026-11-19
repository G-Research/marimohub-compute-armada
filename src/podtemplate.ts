/**
 * `ARMADA_POD_TEMPLATE_FILE`: a partial Pod manifest a deployment adds to every
 * kernel pod. It is the same shape marimohub's own Kubernetes backend reads
 * from `MARIMOHUB_COMPUTE_KUBERNETES_POD_TEMPLATE_FILE`, so a fragment written
 * for that backend works here as long as it uses only the fields below.
 *
 * What it can add:
 *
 * - `spec.volumes`: any volume source (CSI, Secret, ConfigMap, ...), by name.
 * - On the kernel container: `env`, `envFrom` and `volumeMounts`.
 * - `spec.serviceAccountName`, `spec.automountServiceAccountToken` and
 *   `spec.enableServiceLinks`, which decide what identity a kernel holds.
 *
 * Everything else is refused at startup, by path: the fields the adapter owns
 * (the agent's volume, init container, command, ports, resources, the agent
 * token variable, the pod lifecycle), the fields another variable already
 * sets, and anything this adapter does not support yet. Errors name the field,
 * never its value, because a value may be a credential.
 *
 * The template becomes part of the submission, which Armada shows to everyone
 * with Lookout access for good (docs/DECISIONS.md, "Nothing secret in the
 * submission"). It can only name things: a Secret by name, a key in it, a
 * mount path. A literal `env` value is the exception, and is public.
 */
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import type {
	V1EnvFromSource,
	V1EnvVar,
	V1PodSpec,
	V1Volume,
	V1VolumeMount,
} from '@kubernetes/client-node';
import { LineCounter, parseDocument } from 'yaml';
import type { Document, Tags } from 'yaml';

/** What a template adds to the pod the adapter builds. Every field is optional. */
export interface PodTemplate {
	volumes: V1Volume[];
	env: V1EnvVar[];
	envFrom: V1EnvFromSource[];
	volumeMounts: V1VolumeMount[];
	serviceAccountName?: string | undefined;
	automountServiceAccountToken?: boolean | undefined;
	enableServiceLinks?: boolean | undefined;
}

/** The names the adapter's own parts of the pod use, which a template may not take. */
export interface ReservedNames {
	/** The agent's `emptyDir` volume. */
	volume: string;
	/** Where it is mounted in the kernel container. */
	mountPath: string;
	/** The variable the agent reads its token hash from. */
	env: string;
	/** The kernel container's name in the pod the adapter builds. */
	container: string;
}

const SETTING = 'ARMADA_POD_TEMPLATE_FILE';

/**
 * marimohub's Kubernetes backend names its kernel container `marimo`, this
 * adapter `kernel`. Either name means the kernel container, so a template
 * written for that backend needs no edit.
 */
const KERNEL_CONTAINER_NAMES: ReadonlySet<string> = new Set(['kernel', 'marimo']);

/** Spec fields an existing variable sets, with the variable to use instead. */
const SET_ELSEWHERE: Record<string, string> = {
	imagePullSecrets: 'ARMADA_IMAGE_PULL_SECRETS',
	securityContext: 'ARMADA_RUN_AS_USER, ARMADA_RUN_AS_GROUP and ARMADA_FS_GROUP',
	nodeSelector: 'ARMADA_GPU_NODE_SELECTORS',
	priorityClassName: 'ARMADA_PRIORITY_CLASS',
};

/** Spec fields the adapter sets itself on every pod. */
const ADAPTER_OWNED_SPEC: ReadonlySet<string> = new Set([
	'initContainers',
	'ephemeralContainers',
	'restartPolicy',
	'terminationGracePeriodSeconds',
	'activeDeadlineSeconds',
	'resources',
]);

/** Kernel container fields the adapter sets itself. */
const ADAPTER_OWNED_CONTAINER: ReadonlySet<string> = new Set([
	'image',
	'command',
	'args',
	'ports',
	'resources',
]);

const MOUNT_PROPAGATION: ReadonlySet<string> = new Set([
	'None',
	'HostToContainer',
	'Bidirectional',
]);

/** A volume name: an RFC 1123 label. */
const DNS_LABEL: RegExp = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** A service account, Secret or ConfigMap name: an RFC 1123 subdomain. */
const DNS_SUBDOMAIN: RegExp = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/** An environment variable name: letters, digits, `_`, `-` and `.`, not starting with a digit. */
const ENV_NAME: RegExp = /^[-._a-zA-Z][-._a-zA-Z0-9]*$/;

type Json = Record<string, unknown>;

function fail(path: string, problem: string): never {
	throw new Error(`${SETTING}: ${path} ${problem}`);
}

function isObject(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown, path: string): Json {
	if (!isObject(value)) fail(path, 'must be an object');
	return value;
}

function list(value: unknown, path: string): unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) fail(path, 'must be a list');
	return value;
}

function string(value: unknown, path: string): string {
	if (typeof value !== 'string' || value === '') fail(path, 'must be a non-empty string');
	return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'boolean') fail(path, 'must be true or false');
	return value;
}

function name(value: unknown, path: string, rule: RegExp, what: string): string {
	const text: string = string(value, path);
	if (text.length > 253 || !rule.test(text)) fail(path, `is not a valid ${what}`);
	return text;
}

function only(source: Json, allowed: readonly string[], path: string): void {
	for (const key of Object.keys(source)) {
		if (!allowed.includes(key)) fail(`${path}.${key}`, 'is not supported by this adapter');
	}
}

function unique(values: string[], path: string, what: string): void {
	const seen: Map<string, number> = new Map();
	for (const [i, value] of values.entries()) {
		const first: number | undefined = seen.get(value);
		if (first !== undefined) {
			// The indices, not the value: whatever the file holds stays out of errors.
			fail(`${path}[${String(first)}]`, `and ${path}[${String(i)}] have the same ${what}`);
		}
		seen.set(value, i);
	}
}

/** A `{name, optional}` reference to a Secret or ConfigMap. */
function reference(value: unknown, path: string): { name: string; optional?: boolean } {
	const ref: Json = object(value, path);
	only(ref, ['name', 'optional'], path);
	const optional: boolean | undefined = optionalBoolean(ref.optional, `${path}.optional`);
	return {
		name: name(ref.name, `${path}.name`, DNS_SUBDOMAIN, 'object name'),
		...(optional === undefined ? {} : { optional }),
	};
}

/** As `reference`, with the key inside the object. */
function keyReference(
	value: unknown,
	path: string,
): { name: string; key: string; optional?: boolean } {
	const ref: Json = object(value, path);
	only(ref, ['name', 'key', 'optional'], path);
	const optional: boolean | undefined = optionalBoolean(ref.optional, `${path}.optional`);
	return {
		name: name(ref.name, `${path}.name`, DNS_SUBDOMAIN, 'object name'),
		key: string(ref.key, `${path}.key`),
		...(optional === undefined ? {} : { optional }),
	};
}

function optionalString(value: unknown, path: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'string') fail(path, 'must be a string');
	return value;
}

/**
 * A volume is its name plus exactly one source. The source is not checked any
 * further: Kubernetes knows every source's schema and refuses the pod, and the
 * adapter would only be a stale copy of it.
 */
function readVolume(value: unknown, path: string, reserved: ReservedNames): V1Volume {
	const volume: Json = object(value, path);
	const volumeName: string = name(volume.name, `${path}.name`, DNS_LABEL, 'volume name');
	if (volumeName === reserved.volume) {
		fail(`${path}.name`, `is ${reserved.volume}, the adapter's own volume for the agent`);
	}
	const sources: string[] = Object.keys(volume).filter((key: string) => key !== 'name');
	if (sources.length !== 1) fail(path, 'must have exactly one volume source');
	const [source = ''] = sources;
	const body: Json = object(
		retarget(object(volume[source], `${path}.${source}`), `${path}.${source}`, reserved),
		`${path}.${source}`,
	);
	return { name: volumeName, [source]: body };
}

/**
 * The kernel container, as a `resourceFieldRef.containerName` names it. The
 * kubelet looks the name up exactly, and a template written for marimohub's
 * Kubernetes backend names it `marimo`, so either name becomes the adapter's.
 * No other container is the template's to point at.
 */
function kernelContainer(value: unknown, path: string, reserved: ReservedNames): string {
	if (typeof value !== 'string' || !KERNEL_CONTAINER_NAMES.has(value)) {
		fail(path, `must be ${[...KERNEL_CONTAINER_NAMES].join(' or ')}, the kernel container`);
	}
	return reserved.container;
}

/**
 * A volume source, with every `resourceFieldRef.containerName` in it pointed at
 * the kernel container: `downwardAPI` items, and those of a `projected` volume.
 * Nothing else in the source is touched.
 */
function retarget(value: unknown, path: string, reserved: ReservedNames): unknown {
	if (Array.isArray(value)) {
		return value.map((item: unknown, i: number): unknown =>
			retarget(item, `${path}[${String(i)}]`, reserved),
		);
	}
	if (!isObject(value)) return value;
	const copy: Json = {};
	for (const [key, child] of Object.entries(value)) {
		const at: string = `${path}.${key}`;
		if (key === 'resourceFieldRef' && isObject(child) && child.containerName !== undefined) {
			copy[key] = {
				...child,
				containerName: kernelContainer(child.containerName, `${at}.containerName`, reserved),
			};
		} else {
			copy[key] = retarget(child, at, reserved);
		}
	}
	return copy;
}

function readValueFrom(
	value: unknown,
	path: string,
	reserved: ReservedNames,
): NonNullable<V1EnvVar['valueFrom']> {
	const from: Json = object(value, path);
	const kinds: string[] = Object.keys(from);
	if (kinds.length !== 1) fail(path, 'must have exactly one source');
	const [kind = ''] = kinds;
	const at: string = `${path}.${kind}`;
	switch (kind) {
		case 'secretKeyRef':
			return { secretKeyRef: keyReference(from[kind], at) };
		case 'configMapKeyRef':
			return { configMapKeyRef: keyReference(from[kind], at) };
		case 'fieldRef': {
			const ref: Json = object(from[kind], at);
			only(ref, ['fieldPath', 'apiVersion'], at);
			const apiVersion: string | undefined = optionalString(ref.apiVersion, `${at}.apiVersion`);
			return {
				fieldRef: {
					fieldPath: string(ref.fieldPath, `${at}.fieldPath`),
					...(apiVersion === undefined ? {} : { apiVersion }),
				},
			};
		}
		case 'resourceFieldRef': {
			const ref: Json = object(from[kind], at);
			only(ref, ['resource', 'containerName', 'divisor'], at);
			const containerName: string | undefined =
				ref.containerName === undefined
					? undefined
					: kernelContainer(ref.containerName, `${at}.containerName`, reserved);
			const divisor: string | undefined = optionalString(ref.divisor, `${at}.divisor`);
			return {
				resourceFieldRef: {
					resource: string(ref.resource, `${at}.resource`),
					...(containerName === undefined ? {} : { containerName }),
					...(divisor === undefined ? {} : { divisor }),
				},
			};
		}
		default:
			return fail(at, 'is not supported by this adapter');
	}
}

function readEnv(value: unknown, path: string, reserved: ReservedNames): V1EnvVar {
	const env: Json = object(value, path);
	only(env, ['name', 'value', 'valueFrom'], path);
	const envName: string = string(env.name, `${path}.name`);
	if (!ENV_NAME.test(envName)) fail(`${path}.name`, 'is not a valid environment variable name');
	if (envName === reserved.env) {
		fail(`${path}.name`, `is ${reserved.env}, which the adapter sets for the agent`);
	}
	if (env.value !== undefined && env.valueFrom !== undefined) {
		fail(path, 'sets both value and valueFrom; give one');
	}
	if (env.value !== undefined && typeof env.value !== 'string') {
		fail(`${path}.value`, 'must be a string; quote numbers and booleans');
	}
	if (env.valueFrom !== undefined) {
		return {
			name: envName,
			valueFrom: readValueFrom(env.valueFrom, `${path}.valueFrom`, reserved),
		};
	}
	return { name: envName, ...(env.value === undefined ? {} : { value: env.value }) };
}

function readEnvFrom(value: unknown, path: string): V1EnvFromSource {
	const source: Json = object(value, path);
	only(source, ['prefix', 'secretRef', 'configMapRef'], path);
	const prefix: string | undefined = optionalString(source.prefix, `${path}.prefix`);
	if ((source.secretRef === undefined) === (source.configMapRef === undefined)) {
		fail(path, 'must have exactly one of secretRef and configMapRef');
	}
	return {
		...(prefix === undefined ? {} : { prefix }),
		...(source.secretRef === undefined
			? {}
			: { secretRef: reference(source.secretRef, `${path}.secretRef`) }),
		...(source.configMapRef === undefined
			? {}
			: { configMapRef: reference(source.configMapRef, `${path}.configMapRef`) }),
	};
}

/**
 * The path a mount lands on, so `/a/`, `//a` and `/x/../a` are all `/a`: the
 * container runtime resolves them to one place, and Kubernetes only refuses two
 * mounts whose paths are the same string.
 */
function mountTarget(path: string): string {
	const normalized: string = posix.normalize(path);
	return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/** True when `path` is `dir` or inside it. */
function within(path: string, dir: string): boolean {
	const normalized: string = mountTarget(path);
	return normalized === dir || normalized.startsWith(`${dir}/`);
}

function readMount(
	value: unknown,
	path: string,
	volumes: string[],
	reserved: ReservedNames,
): V1VolumeMount {
	const mount: Json = object(value, path);
	only(
		mount,
		['name', 'mountPath', 'readOnly', 'subPath', 'subPathExpr', 'mountPropagation'],
		path,
	);
	const volumeName: string = string(mount.name, `${path}.name`);
	if (volumeName === reserved.volume) {
		fail(`${path}.name`, `is ${reserved.volume}, the adapter's own volume for the agent`);
	}
	if (!volumes.includes(volumeName)) {
		fail(`${path}.name`, 'names a volume that spec.volumes does not define');
	}
	const mountPath: string = string(mount.mountPath, `${path}.mountPath`);
	if (!mountPath.startsWith('/')) fail(`${path}.mountPath`, 'must be an absolute path');
	// `/` covers the whole container, the agent's directory and the kernel image with it.
	if (mountTarget(mountPath) === '/' || within(mountPath, reserved.mountPath)) {
		fail(
			`${path}.mountPath`,
			`is or covers ${reserved.mountPath}, where the adapter mounts the agent`,
		);
	}
	const readOnly: boolean | undefined = optionalBoolean(mount.readOnly, `${path}.readOnly`);
	const subPath: string | undefined = optionalString(mount.subPath, `${path}.subPath`);
	const subPathExpr: string | undefined = optionalString(mount.subPathExpr, `${path}.subPathExpr`);
	if (subPath !== undefined && subPathExpr !== undefined) {
		fail(path, 'sets both subPath and subPathExpr; give one');
	}
	const propagation: string | undefined = optionalString(
		mount.mountPropagation,
		`${path}.mountPropagation`,
	);
	if (propagation !== undefined && !MOUNT_PROPAGATION.has(propagation)) {
		fail(`${path}.mountPropagation`, `must be one of ${[...MOUNT_PROPAGATION].join(', ')}`);
	}
	return {
		name: volumeName,
		mountPath,
		...(readOnly === undefined ? {} : { readOnly }),
		...(subPath === undefined ? {} : { subPath }),
		...(subPathExpr === undefined ? {} : { subPathExpr }),
		...(propagation === undefined ? {} : { mountPropagation: propagation }),
	};
}

function readContainer(
	value: unknown,
	path: string,
	volumes: string[],
	reserved: ReservedNames,
): Pick<PodTemplate, 'env' | 'envFrom' | 'volumeMounts'> {
	const container: Json = object(value, path);
	if (typeof container.name !== 'string' || !KERNEL_CONTAINER_NAMES.has(container.name)) {
		fail(
			`${path}.name`,
			`must be ${[...KERNEL_CONTAINER_NAMES].join(' or ')}: the template can only add to the kernel container`,
		);
	}
	for (const key of Object.keys(container)) {
		if (ADAPTER_OWNED_CONTAINER.has(key)) {
			fail(`${path}.${key}`, 'is set by the adapter; leave it out of the template');
		}
	}
	only(container, ['name', 'env', 'envFrom', 'volumeMounts'], path);

	const env: V1EnvVar[] = list(container.env, `${path}.env`).map(
		(entry: unknown, i: number): V1EnvVar => readEnv(entry, `${path}.env[${String(i)}]`, reserved),
	);
	unique(
		env.map((entry: V1EnvVar) => entry.name),
		`${path}.env`,
		'name',
	);
	const envFrom: V1EnvFromSource[] = list(container.envFrom, `${path}.envFrom`).map(
		(entry: unknown, i: number): V1EnvFromSource =>
			readEnvFrom(entry, `${path}.envFrom[${String(i)}]`),
	);
	const volumeMounts: V1VolumeMount[] = list(container.volumeMounts, `${path}.volumeMounts`).map(
		(entry: unknown, i: number): V1VolumeMount =>
			readMount(entry, `${path}.volumeMounts[${String(i)}]`, volumes, reserved),
	);
	unique(
		volumeMounts.map((mount: V1VolumeMount) => mountTarget(mount.mountPath)),
		`${path}.volumeMounts`,
		'mount target',
	);
	return { env, envFrom, volumeMounts };
}

/** Checks a parsed template against what the adapter accepts. */
export function validatePodTemplate(value: unknown, reserved: ReservedNames): PodTemplate {
	const root: Json = object(value, '<root>');
	only(root, ['apiVersion', 'kind', 'metadata', 'spec'], '<root>');
	if (root.apiVersion !== undefined && root.apiVersion !== 'v1') {
		fail('apiVersion', 'must be v1 when set');
	}
	if (root.kind !== undefined && root.kind !== 'Pod') fail('kind', 'must be Pod when set');
	if (root.metadata !== undefined) {
		fail(
			'metadata',
			'is not read here; set pod labels and annotations with ARMADA_POD_LABELS and ARMADA_POD_ANNOTATIONS',
		);
	}

	const spec: Json = root.spec === undefined ? {} : object(root.spec, 'spec');
	for (const key of Object.keys(spec)) {
		const variable: string | undefined = SET_ELSEWHERE[key];
		if (variable !== undefined) fail(`spec.${key}`, `is set with ${variable}, not the template`);
		if (ADAPTER_OWNED_SPEC.has(key)) {
			fail(`spec.${key}`, 'is set by the adapter; leave it out of the template');
		}
		if (key === 'serviceAccount') {
			fail('spec.serviceAccount', 'is the deprecated alias; use spec.serviceAccountName');
		}
	}
	only(
		spec,
		[
			'volumes',
			'containers',
			'serviceAccountName',
			'automountServiceAccountToken',
			'enableServiceLinks',
		],
		'spec',
	);

	const volumes: V1Volume[] = list(spec.volumes, 'spec.volumes').map(
		(entry: unknown, i: number): V1Volume =>
			readVolume(entry, `spec.volumes[${String(i)}]`, reserved),
	);
	const volumeNames: string[] = volumes.map((volume: V1Volume) => volume.name);
	unique(volumeNames, 'spec.volumes', 'name');

	const containers: unknown[] = list(spec.containers, 'spec.containers');
	if (containers.length > 1) {
		fail(
			'spec.containers',
			'must have at most one entry, the kernel container; the adapter adds no others',
		);
	}
	const kernel: Pick<PodTemplate, 'env' | 'envFrom' | 'volumeMounts'> =
		containers.length === 0
			? { env: [], envFrom: [], volumeMounts: [] }
			: readContainer(containers[0], 'spec.containers[0]', volumeNames, reserved);

	return {
		volumes,
		...kernel,
		serviceAccountName:
			spec.serviceAccountName === undefined
				? undefined
				: name(
						spec.serviceAccountName,
						'spec.serviceAccountName',
						DNS_SUBDOMAIN,
						'service account name',
					),
		automountServiceAccountToken: optionalBoolean(
			spec.automountServiceAccountToken,
			'spec.automountServiceAccountToken',
		),
		enableServiceLinks: optionalBoolean(spec.enableServiceLinks, 'spec.enableServiceLinks'),
	};
}

/** YAML 1.1's timestamp tag, which would turn `secretName: 2024-01-01` into another string. */
const TIMESTAMP_TAG: string = 'tag:yaml.org,2002:timestamp';

/**
 * One YAML or JSON document. YAML 1.1, as Kubernetes manifests are written,
 * so `defaultMode: 0444` is octal, but without timestamps: a date-like value
 * stays the string it was written as, since values are submitted as written.
 * A syntax error is located by line, never quoted: the line may hold a value.
 */
export function parsePodTemplate(source: string, reserved: ReservedNames): PodTemplate {
	const lines: LineCounter = new LineCounter();
	const document: Document.Parsed = parseDocument(source, {
		version: '1.1',
		prettyErrors: false,
		lineCounter: lines,
		customTags: (tags: Tags): Tags =>
			tags.filter((tag: Tags[number]) => typeof tag === 'string' || tag.tag !== TIMESTAMP_TAG),
	});
	const [error] = document.errors;
	if (error !== undefined) {
		// The library's code, not its message: some messages copy text from the
		// file, such as the characters of a bad escape inside a quoted value. The
		// library places an unclosed quote or bracket at the end of the input,
		// whatever line it opened on, so that case names no line at all.
		const where: string =
			error.pos[0] >= source.trimEnd().length
				? 'at the end of the file, so a quote or bracket is not closed'
				: `at line ${String(lines.linePos(error.pos[0]).line)}`;
		throw new Error(`${SETTING} must hold one valid YAML or JSON document: ${error.code} ${where}`);
	}
	let value: unknown;
	try {
		value = document.toJS({ maxAliasCount: 100 });
	} catch {
		throw new Error(`${SETTING} has YAML aliases that cannot be resolved`);
	}
	return validatePodTemplate(value, reserved);
}

/** Read once at startup, so a bad file stops marimohub rather than the first session. */
export function loadPodTemplateFile(path: string, reserved: ReservedNames): PodTemplate {
	let source: string;
	try {
		source = readFileSync(path, 'utf8');
	} catch {
		throw new Error(`${SETTING} cannot be read: ${path}`);
	}
	return parsePodTemplate(source, reserved);
}

/** The pod-level fields a template sets, and nothing for the ones it leaves out. */
export function templateSpecFields(
	template: PodTemplate | undefined,
): Pick<V1PodSpec, 'serviceAccountName' | 'automountServiceAccountToken' | 'enableServiceLinks'> {
	if (template === undefined) return {};
	return {
		...(template.serviceAccountName === undefined
			? {}
			: { serviceAccountName: template.serviceAccountName }),
		...(template.automountServiceAccountToken === undefined
			? {}
			: { automountServiceAccountToken: template.automountServiceAccountToken }),
		...(template.enableServiceLinks === undefined
			? {}
			: { enableServiceLinks: template.enableServiceLinks }),
	};
}
