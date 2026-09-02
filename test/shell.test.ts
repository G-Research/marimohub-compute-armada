import { describe, expect, it } from 'bun:test';
import {
	assertEnvName,
	listFilesCommand,
	parseListFilesOutput,
	portWaitCommand,
	readFileCommand,
	shellQuote,
	withEnvPrefix,
} from '../src/shell.js';
import type { FileInfo } from '../src/types.js';

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

describe('read command', () => {
	it('feeds the path in by redirection, so a leading dash needs no `--`', () => {
		expect(readFileCommand('-weird.py')).toContain("base64 < '-weird.py'");
	});

	it('quotes the path in every branch of the existence probe', () => {
		const command: string = readFileCommand("/work/it's.py");
		expect(command).toBe(
			"if [ -e '/work/it'\\''s.py' ] || [ -L '/work/it'\\''s.py' ]; " +
				"then base64 < '/work/it'\\''s.py'; else exit 44; fi",
		);
	});
});

describe('list command', () => {
	it('stays in the directory unless recursion is asked for', () => {
		expect(listFilesCommand('/work')).toContain("find '/work' -mindepth 1 -maxdepth 1 -printf");
		expect(listFilesCommand('/work', { recursive: true })).toContain(
			"find '/work' -mindepth 1 -printf",
		);
	});

	it('exits 20 for a path that exists but is not a directory, and 1 for one that does not', () => {
		const command: string = listFilesCommand('/work/notebook.py');
		expect(command).toContain('exit 20');
		expect(command).toContain('else exit 1; fi');
		expect(command).toContain('MARIMOHUB_NOT_A_DIRECTORY');
	});
});

describe('list parsing', () => {
	const records: string =
		'f\t12\t/work/notebook.py\0d\t4096\t/work/data\0l\t7\t/work/link\0s\t0\t/work/sock\0';

	it('reads the type, size and path of every record', () => {
		const files: FileInfo[] = parseListFilesOutput(records, '/work');
		expect(files.map((file: FileInfo) => file.type)).toEqual([
			'file',
			'directory',
			'symlink',
			'other',
		]);
		expect(files[0]).toEqual({
			name: 'notebook.py',
			absolutePath: '/work/notebook.py',
			relativePath: 'notebook.py',
			type: 'file',
			size: 12,
		});
	});

	it('keeps a tab inside a path, because only the NUL separates records', () => {
		const files: FileInfo[] = parseListFilesOutput('f\t3\t/work/a\tb.py\0', '/work');
		expect(files[0]?.absolutePath).toBe('/work/a\tb.py');
		expect(files[0]?.name).toBe('a\tb.py');
	});

	it('hides dotfiles unless asked, and hides nothing else', () => {
		const hidden: string = 'f\t1\t/work/.env\0f\t2\t/work/notebook.py\0';
		expect(parseListFilesOutput(hidden, '/work').map((file: FileInfo) => file.name)).toEqual([
			'notebook.py',
		]);
		expect(
			parseListFilesOutput(hidden, '/work', { includeHidden: true }).map(
				(file: FileInfo) => file.name,
			),
		).toEqual(['.env', 'notebook.py']);
	});

	it('reports a path outside the root as its own relative path', () => {
		const files: FileInfo[] = parseListFilesOutput('f\t1\t/elsewhere/x.py\0', '/work');
		expect(files[0]?.relativePath).toBe('/elsewhere/x.py');
	});

	it('reads an empty listing as no files', () => {
		expect(parseListFilesOutput('', '/work')).toEqual([]);
	});
});
