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
 * Build a `git clone` command, upstream's `buildGitCloneCommand` verbatim: the
 * repo, branch and target are all {@link shellQuote}d, closing the injection
 * hole that interpolating them raw would open, and the target defaults to `.`,
 * the working directory the caller is already in.
 */
export function gitCloneCommand(
	repo: string,
	options?: { branch?: string; targetDir?: string },
): string {
	const parts: string[] = ['git', 'clone'];
	if (options?.branch !== undefined) parts.push('--branch', shellQuote(options.branch));
	parts.push(shellQuote(repo), shellQuote(options?.targetDir ?? '.'));
	return parts.join(' ');
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

/**
 * Argv that runs `script` in a login shell in its own process group, recording
 * that group's id in `groupFile`.
 *
 * This exists because **closing an exec websocket does not stop the command it
 * started**, measured against a real pod: a loop kept ticking after the socket
 * closed, whether or not it was still writing to stdout. So anything we might
 * have to abandon (a stream the consumer cancels, an `exec` that outruns its
 * timeout) has to be killable, and a process group is what makes a shell die
 * along with the `sleep` it was waiting on.
 *
 * The pieces are separate argv entries, so nothing here needs quoting, and the
 * prologue redirects to the file rather than to stdout, which belongs to the
 * caller. Cleanup is an `EXIT` trap rather than a trailing `rm`, because a
 * command ending in an explicit `exit` never reaches a trailing anything: that
 * left a file behind per `exec` in the live run. A trap also keeps the command's
 * exit status, which `exec` reports and a trailing `rm` would overwrite with its
 * own. A killed shell runs no trap, so {@link killGroupCommand} removes the file
 * on that path.
 */
export function processGroupCommand(groupFile: string, script: string): string[] {
	return [
		'setsid',
		'--wait',
		'sh',
		'-lc',
		`trap 'rm -f ${groupFile}' EXIT; echo $$ > ${groupFile}; ${script}`,
	];
}

/**
 * Kill the process group whose id `groupFile` holds, and clean the file up.
 *
 * `execStream` needs this because closing an exec websocket does not stop the
 * command it started. The negative argument is what makes `kill` address the
 * whole group, so a shell loop dies along with the `sleep` it was waiting on.
 * Silent when the file is missing or the group is already gone: this runs while
 * a stream is being torn down and has nobody to report to.
 */
export function killGroupCommand(groupFile: string): string {
	const quoted: string = shellQuote(groupFile);
	return `group=$(cat ${quoted} 2>/dev/null); [ -n "$group" ] && kill -TERM -"$group" 2>/dev/null; rm -f ${quoted}; exit 0`;
}

/**
 * Report every process in the pod except PID 1 and the shell doing the asking.
 *
 * A ghost check, for `dev/smoke.ts`. It reads `/proc` rather than running `ps`
 * because the kernel image has no `procps`: `ps` prints nothing at all there,
 * which would make an empty result look like a clean pod. Records are
 * NUL-separated `pid<TAB>state<TAB>command`, and the state comes from the same
 * field the liveness probe reads (decision 19), so a zombie left behind by a
 * PID 1 that never reaps is visible rather than indistinguishable from a live
 * process.
 *
 * The asking shell skips itself and its own children, since `$(...)` in the
 * loop forks and those forks are not news.
 */
export function strayProcessCommand(): string {
	return (
		'self=$$; for dir in /proc/[0-9]*; do pid=${dir#/proc/}; ' +
		'[ "$pid" = 1 ] && continue; [ "$pid" = "$self" ] && continue; ' +
		"rest=$(sed 's/^.*) //' $dir/stat 2>/dev/null) || continue; " +
		'set -- $rest; [ "$2" = "$self" ] && continue; ' +
		"cmd=$(tr '\\0' ' ' < $dir/cmdline 2>/dev/null); " +
		'printf \'%s\\t%s\\t%s\\0\' "$pid" "$1" "$cmd"; done'
	);
}

/** One process {@link strayProcessCommand} found. */
export interface StrayProcess {
	pid: string;
	/** The `/proc/<pid>/stat` state field; `Z` is a zombie nobody reaped. */
	state: string;
	/** The command line, empty for a zombie, which no longer has one. */
	command: string;
}

/** Parse the NUL-separated records {@link strayProcessCommand} printed. */
export function parseStrayProcesses(stdout: string): StrayProcess[] {
	const found: StrayProcess[] = [];
	for (const record of stdout.split('\0')) {
		// The command terminates each record with a NUL, so the split leaves a
		// trailing empty string, and a clean pod produces nothing else.
		if (record === '') continue;
		const [pid, state, ...rest] = record.split('\t');
		// Without a pid there is nothing to report and nothing to kill.
		if (pid === undefined || pid === '') continue;
		found.push({ pid, state: state ?? '', command: rest.join('\t').trim() });
	}
	return found;
}

/**
 * Kill every process group this adapter started and is no longer waiting on.
 *
 * The self-healing half of decisions 23 and 24. Each abandonable command records
 * its group id in a `/tmp/mh-*.pgid` file and removes it on the way out, so a
 * file that still exists for a command nobody is waiting on is a ghost, by
 * construction rather than by guesswork. `live` names the files whose commands
 * are still running, which the sweep must leave alone.
 *
 * This is deliberately not a process sweep. A kernel pod holds the kernel and
 * whatever the user's notebook spawned, and nothing distinguishes those from a
 * leak by looking at them. Only the files we wrote identify our own work, so
 * only they are swept, and a process without one is never touched.
 *
 * Prints one `file<TAB>group<TAB>outcome` record per file it dealt with, so the
 * caller can name what it killed and forget what it no longer needs to track,
 * and says nothing when the pod is clean.
 */
export function sweepGroupsCommand(live: readonly string[]): string {
	const keep: string =
		live.length === 0
			? ''
			: `case "$file" in ${live.map((file: string) => shellQuote(file)).join('|')}) continue;; esac; `;
	return (
		'for file in /tmp/mh-*.pgid; do [ -e "$file" ] || continue; ' +
		keep +
		'group=$(cat "$file" 2>/dev/null); rm -f "$file"; [ -n "$group" ] || continue; ' +
		// A group whose leader is already gone is reported as `gone` rather than
		// killed: the file simply outlived it, and removing it was the whole
		// repair. The caller needs to hear about it either way, to stop tracking it.
		'if kill -0 -"$group" 2>/dev/null && kill -TERM -"$group" 2>/dev/null; ' +
		'then outcome=killed; else outcome=gone; fi; ' +
		'printf \'%s\\t%s\\t%s\\n\' "$file" "$group" "$outcome"; done; exit 0'
	);
}

/** One file {@link sweepGroupsCommand} dealt with. */
export interface SweptGroup {
	groupFile: string;
	group: string;
	/** `killed` if something was still running, `gone` if only the file was left. */
	outcome: 'killed' | 'gone';
}

/** Parse what {@link sweepGroupsCommand} reported. */
export function parseSweptGroups(stdout: string): SweptGroup[] {
	const swept: SweptGroup[] = [];
	for (const line of stdout.split('\n')) {
		// A clean pod prints nothing, and the last line is empty either way.
		if (line.trim() === '') continue;
		const [groupFile, group, outcome] = line.split('\t');
		// Without a file there is nothing to stop tracking, and without a group
		// there was nothing to kill.
		if (groupFile === undefined || group === undefined) continue;
		swept.push({ groupFile, group, outcome: outcome?.trim() === 'killed' ? 'killed' : 'gone' });
	}
	return swept;
}
