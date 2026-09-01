/**
 * Shell-building helpers for commands run through pod exec.
 *
 * Semantics transcribed from marimohub's `@marimo-hub/compute-commons` (v0.3.12),
 * like `src/types.ts`, so this adapter behaves the same as marimohub's own
 * pod-exec backends. Replace with an import once the packages are published.
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
 * Names are interpolated unquoted, so anything `sh` would not accept as a
 * variable name must fail here, as a clear error instead of in-pod shell noise.
 */
export function assertEnvName(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new Error(`Invalid environment variable name: ${JSON.stringify(name)}`);
	}
	return name;
}
