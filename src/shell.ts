/**
 * Shell-building helpers for commands run through pod exec.
 *
 * Semantics transcribed from marimohub's `@marimo-hub/compute-commons` (v0.3.12),
 * like `src/types.ts`, so this adapter behaves the same as marimohub's own
 * pod-exec backends. Replace with an import once the packages are published.
 */
import type { FileInfo } from './types.js';

/**
 * Single-quote a value for safe interpolation into an `sh -c` string. An
 * embedded single quote becomes the classic `'\''` sequence, so the result is
 * injection-safe for arbitrary input (paths, repo URLs, env values).
 */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Prefix `cmd` with `export K='v'; …` for the accumulated env vars, because pod
 * exec has no per-command environment. Values are {@link shellQuote}d.
 *
 * `defaults` are fallbacks (`setEnvVars` with `onlyIfUnset`): each is exported
 * behind a `[ -n "${K:-}" ]` guard, so a value the sandbox already defines (image
 * ENV, profile script, or a forced export from `env`) wins. The guards come
 * after the forced exports, which is what lets a key present in both resolve to
 * the forced value.
 */
export function withEnvPrefix(
	cmd: string,
	env: Record<string, string>,
	defaults: Record<string, string> = {},
): string {
	const forced: string[] = Object.entries(env).map(
		([key, value]: [string, string]) => `export ${assertEnvName(key)}=${shellQuote(value)}; `,
	);
	const guarded: string[] = Object.entries(defaults).map(
		([key, value]: [string, string]) =>
			`[ -n "\${${assertEnvName(key)}:-}" ] || export ${key}=${shellQuote(value)}; `,
	);
	return forced.join('') + guarded.join('') + cmd;
}

/**
 * An in-pod TCP wait: connect to `127.0.0.1:port` until it answers or `seconds`
 * elapse, exit 0 on open and 1 on deadline. It runs inside the pod because
 * every exec is a fresh websocket through the API server, so polling from
 * outside would quantize the wait to that round trip. The connect timeout is
 * clamped to the remaining budget: against a blackholed port (packets dropped,
 * not refused) a fixed timeout could let the final connect run past the
 * deadline.
 *
 * Inline Python looks odd, but it is the only probe a kernel image guarantees.
 * `python3` is definitionally present (the kernel is Python), while `nc`,
 * `curl` and `wget` are all absent from `python:*-slim`, and `/dev/tcp` is a
 * bashism the pod's `sh` does not have. POSIX sh also cannot express what the
 * wait needs: a monotonic ms-precision deadline (so chunks sum to the exact
 * timeout) or a per-connect timeout. And it is inline rather than a file so
 * `waitForPort` does not depend on `writeFiles` having run first.
 */
export function portWaitCommand(port: number, seconds: number): string {
	const script: string =
		'import socket,sys,time\n' +
		`end=time.monotonic()+${String(seconds)}\n` +
		'while True:\n' +
		'    left=end-time.monotonic()\n' +
		'    s=socket.socket(); s.settimeout(max(0.01,min(1,left)))\n' +
		`    ok=s.connect_ex(("127.0.0.1",${String(port)}))==0\n` +
		'    s.close()\n' +
		'    if ok: sys.exit(0)\n' +
		'    if time.monotonic()>=end: sys.exit(1)\n' +
		'    time.sleep(0.05)\n';
	return `python3 -c ${shellQuote(script)}`;
}

/**
 * Names are interpolated unquoted, so anything `sh` would not accept as a
 * variable name must fail here, as a clear error instead of in-pod shell noise.
 */
export function assertEnvName(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new Error(`Invalid environment variable name: ${JSON.stringify(name)}`);
	}
	return name;
}

/**
 * Exit code the read probe uses for "the path is not there", so a caller can
 * answer `NOT_FOUND` instead of the blanket `READ_FAILED` upstream returns.
 * 44 is outside the range `base64` and `sh` produce themselves.
 */
export const READ_FILE_NOT_FOUND_EXIT = 44;

/**
 * Read a file as base64.
 *
 * Upstream's kubernetes adapter runs a plain `cat` and hands the exec's stdout
 * back as text. Our exec channel decodes stdout with `toString('utf8')`, so a
 * byte that is not valid UTF-8 would come back as U+FFFD: `writeFiles` takes
 * care to carry bytes verbatim into the pod (decision 18) and a raw `cat` would
 * quietly corrupt them on the way out. base64 is ASCII, so it survives the
 * channel, and `readFile` decides from the bytes how to report them.
 *
 * The path is fed to `base64` by redirection rather than as an operand: a path
 * beginning with `-` then needs no `--` support, which GNU coreutils has and
 * busybox does not. A missing path exits {@link READ_FILE_NOT_FOUND_EXIT}; a
 * directory or an unreadable file fails on the redirect, which is a read
 * failure and not a missing file.
 */
export function readFileCommand(path: string): string {
	const quoted: string = shellQuote(path);
	return `if [ -e ${quoted} ] || [ -L ${quoted} ]; then base64 < ${quoted}; else exit ${String(READ_FILE_NOT_FOUND_EXIT)}; fi`;
}

/** Exit code the list probe uses for "it exists, it is not a directory". */
export const NOT_A_DIRECTORY_EXIT = 20;

/** Printed to stderr with {@link NOT_A_DIRECTORY_EXIT}, so an exec log says why. */
export const NOT_A_DIRECTORY_MARKER = 'MARIMOHUB_NOT_A_DIRECTORY';

/**
 * List a directory as NUL-separated `type<TAB>size<TAB>path` records.
 *
 * The probe in front of the `find` is what lets `listFiles` tell "you listed a
 * file" from "the listing failed": an empty success would otherwise look like
 * an empty directory, which marimohub's compute contract explicitly rejects.
 *
 * `-printf` is GNU find, as it is upstream; busybox find has no equivalent.
 * That is the same class of assumption as `setsid` in decision 19 and holds for
 * any Debian-family kernel image.
 */
export function listFilesCommand(path: string, options?: { recursive?: boolean }): string {
	const quoted: string = shellQuote(path);
	const probe: string =
		`if [ -d ${quoted} ]; then :; ` +
		`elif [ -e ${quoted} ] || [ -L ${quoted} ]; then ` +
		`printf '${NOT_A_DIRECTORY_MARKER}\\n' >&2; exit ${String(NOT_A_DIRECTORY_EXIT)}; ` +
		`else exit 1; fi`;
	const depth: string = options?.recursive === true ? '' : ' -maxdepth 1';
	return `${probe}; find ${quoted} -mindepth 1${depth} -printf '%y\\t%s\\t%p\\0'`;
}

/** Parse the NUL-separated records {@link listFilesCommand} printed. */
export function parseListFilesOutput(
	stdout: string,
	rootPath: string,
	options?: { includeHidden?: boolean },
): FileInfo[] {
	const files: FileInfo[] = [];
	for (const record of stdout.split('\0')) {
		// `find` terminates every record with a NUL, so the split always leaves a
		// trailing empty string, and an empty directory produces nothing else.
		if (record === '') continue;
		const [typeChar, size, ...pathParts] = record.split('\t');
		// The path is the last field, so one containing a tab rejoins intact.
		const absolutePath: string = pathParts.join('\t');
		// A record with no path field is not something `-printf '%y\t%s\t%p'` can
		// produce; it means the output was truncated or something else wrote to
		// stdout, and a `FileInfo` cannot be built without a path anyway.
		if (absolutePath === '') continue;
		const name: string = absolutePath.slice(absolutePath.lastIndexOf('/') + 1);
		// Hiding is done here rather than in the `find` expression, so `-prune`
		// never stops the walk: a recursive listing still descends into a dot
		// directory and reports its non-dot children, which is what upstream does
		// and what `readSessionArtifacts` needs for `__marimo__` trees.
		if (options?.includeHidden !== true && name.startsWith('.')) continue;
		files.push({
			name,
			absolutePath,
			relativePath: absolutePath.startsWith(rootPath)
				? absolutePath.slice(rootPath.length).replace(/^\//, '')
				: absolutePath,
			type: FILE_TYPES[typeChar ?? ''] ?? 'other',
			size: Number(size) || 0,
		});
	}
	return files;
}

/** `find -printf '%y'` type characters we name; everything else is `other`. */
const FILE_TYPES: Record<string, FileInfo['type']> = {
	f: 'file',
	d: 'directory',
	l: 'symlink',
};
