/**
 * Shell-building helpers for commands run through the agent's `/exec`.
 *
 * Semantics transcribed from marimohub's `@marimo-hub/compute-commons` (v0.4.2, unchanged since v0.3.12),
 * like `src/types.ts`, so this adapter behaves the same as marimohub's own
 * pod-exec backends. Replace with an import once the packages are published.
 *
 * Only `exec` and its relatives need a shell; files and processes go through
 * the agent's own endpoints (`src/channel.ts`). So this is the env prefix and
 * quoting that `exec` needs, the quoted clone, and the stray-process check the
 * smoke run uses.
 */

/**
 * Single-quote a value for safe interpolation into an `sh -c` string. An
 * embedded single quote becomes the classic `'\''` sequence, so the result is
 * injection-safe for arbitrary input (paths, repo URLs, env values).
 */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Prefix `cmd` with `export K='v'; …` for the accumulated env vars, because the
 * pod's environment is fixed once it starts. Values are {@link shellQuote}d.
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
 * Report every process in the pod except PID 1 and the shell doing the asking.
 *
 * A leak check, for `dev/smoke.ts`. It reads `/proc` rather than running `ps`
 * because the kernel image has no `procps`: `ps` prints nothing at all there,
 * which would make an empty result look like a clean pod. Records are
 * NUL-separated `pid<TAB>state<TAB>command`, and the state is reported so a
 * zombie left behind by a PID 1 that never reaps is visible rather than
 * indistinguishable from a live process.
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
