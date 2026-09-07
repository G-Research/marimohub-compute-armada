import { describe, expect, it } from 'bun:test';
import {
	assertEnvName,
	gitCloneCommand,
	parseStrayProcesses,
	shellQuote,
	strayProcessCommand,
	withEnvPrefix,
} from '../src/shell.js';
import type { StrayProcess } from '../src/shell.js';

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

describe('git clone command', () => {
	it('clones into the working directory when no target is given', () => {
		expect(gitCloneCommand('https://x/y')).toBe("git clone 'https://x/y' '.'");
	});

	it('includes the branch flag when given', () => {
		expect(gitCloneCommand('https://x/y', { branch: 'main', targetDir: 'w' })).toBe(
			"git clone --branch 'main' 'https://x/y' 'w'",
		);
	});

	it('quotes every interpolated argument, so nothing injects', () => {
		expect(gitCloneCommand('https://x/y; rm -rf /', { targetDir: '$(touch pwn)' })).toBe(
			"git clone 'https://x/y; rm -rf /' '$(touch pwn)'",
		);
	});
});

describe('stray processes', () => {
	it('reads /proc rather than running ps, which the kernel image does not have', () => {
		const command: string = strayProcessCommand();
		expect(command).toContain('/proc/[0-9]*');
		expect(command).not.toContain('ps ');
	});

	it('skips PID 1 and the asking shell', () => {
		const command: string = strayProcessCommand();
		expect(command).toContain('[ "$pid" = 1 ] && continue');
		expect(command).toContain('[ "$pid" = "$self" ] && continue');
		expect(command).toContain('[ "$2" = "$self" ] && continue');
	});

	it('parses pid, state and command line', () => {
		// The trailing space is what `tr '\\0' ' '` leaves on a command line.
		const found: StrayProcess[] = parseStrayProcesses('42\tS\tsleep 30 \x0091\tZ\t\x00');
		expect(found).toEqual([
			{ pid: '42', state: 'S', command: 'sleep 30' },
			// A zombie has no command line left, which is how it reads as one.
			{ pid: '91', state: 'Z', command: '' },
		]);
	});

	it('reads a clean pod as no strays', () => {
		expect(parseStrayProcesses('')).toEqual([]);
	});
});
