import { describe, expect, it } from 'bun:test';
import { assertEnvName, portWaitCommand, shellQuote, withEnvPrefix } from '../src/shell.js';

describe('shell quoting', () => {
	it('wraps a value in single quotes', () => {
		expect(shellQuote('/work/notebook.py')).toBe("'/work/notebook.py'");
	});

	it('escapes an embedded single quote', () => {
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});

	it('neutralises shell metacharacters', () => {
		expect(shellQuote('$(rm -rf /);`x`')).toBe("'$(rm -rf /);`x`'");
	});
});

describe('env prefix', () => {
	it('leaves a command alone when nothing is set', () => {
		expect(withEnvPrefix('echo hi', {})).toBe('echo hi');
	});

	it('exports forced vars ahead of the command', () => {
		expect(withEnvPrefix('echo hi', { API_KEY: 'secret' })).toBe(
			"export API_KEY='secret'; echo hi",
		);
	});

	it('guards defaults so an existing value wins', () => {
		expect(withEnvPrefix('echo hi', {}, { HOME_DIR: '/work' })).toBe(
			'[ -n "${HOME_DIR:-}" ] || export HOME_DIR=\'/work\'; echo hi',
		);
	});

	it('puts the guard after the forced export, so forced wins for a shared key', () => {
		expect(withEnvPrefix('run', { K: 'forced' }, { K: 'default' })).toBe(
			"export K='forced'; [ -n \"${K:-}\" ] || export K='default'; run",
		);
	});

	it('quotes values, not names', () => {
		expect(withEnvPrefix('run', { GREETING: "it's" })).toBe("export GREETING='it'\\''s'; run");
	});
});

describe('port waiter', () => {
	it('embeds the port and the fractional deadline', () => {
		const command: string = portWaitCommand(2718, 1.5);
		expect(command.startsWith("python3 -c '")).toBe(true);
		expect(command).toContain('("127.0.0.1",2718)');
		expect(command).toContain('end=time.monotonic()+1.5');
	});
});

describe('env names', () => {
	it('accepts what sh accepts', () => {
		expect(assertEnvName('_UNDER_score1')).toBe('_UNDER_score1');
	});

	it('rejects a name sh would choke on, before it reaches a shell', () => {
		expect(() => assertEnvName('1BAD')).toThrow('Invalid environment variable name');
		expect(() => assertEnvName('A B')).toThrow('"A B"');
		expect(() => assertEnvName('X;rm -rf /')).toThrow('Invalid environment variable name');
	});
});
