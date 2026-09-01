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
