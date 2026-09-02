import { describe, expect, it } from 'bun:test';
import {
	assertEnvName,
	gitCloneCommand,
	killGroupCommand,
	listFilesCommand,
	parseListFilesOutput,
	parseStrayProcesses,
	parseSweptGroups,
	processGroupCommand,
	portWaitCommand,
	readFileCommand,
	shellQuote,
	strayProcessCommand,
	sweepGroupsCommand,
	withEnvPrefix,
} from '../src/shell.js';
import type { StrayProcess } from '../src/shell.js';
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

describe('process groups', () => {
	it("records the group id before the command and keeps the command's status", () => {
		expect(processGroupCommand('/tmp/g.pgid', 'make build')).toEqual([
			'setsid',
			'--wait',
			'sh',
			'-lc',
			"trap 'rm -f /tmp/g.pgid' EXIT; echo $$ > /tmp/g.pgid; make build",
		]);
	});

	it('kills the whole group, not just the shell, and says nothing when it is gone', () => {
		const command: string = killGroupCommand('/tmp/g.pgid');
		// The negated id is what reaches the `sleep` a shell loop is waiting on.
		expect(command).toContain('kill -TERM -"$group"');
		expect(command).toContain("cat '/tmp/g.pgid' 2>/dev/null");
		expect(command).toContain("rm -f '/tmp/g.pgid'");
		// A teardown has nobody to report to, so it always succeeds.
		expect(command.endsWith('exit 0')).toBe(true);
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

describe('group sweep', () => {
	it('only ever looks at files this adapter wrote', () => {
		const command: string = sweepGroupsCommand([]);
		// A process without one of our group files is never a candidate, which is
		// what makes an automatic kill safe next to a user's own subprocesses.
		expect(command).toContain('for file in /tmp/mh-*.pgid');
	});

	it('skips the commands still running', () => {
		const command: string = sweepGroupsCommand(['/tmp/mh-exec-1.pgid', '/tmp/mh-stream-2.pgid']);
		expect(command).toContain(
			`case "$file" in '/tmp/mh-exec-1.pgid'|'/tmp/mh-stream-2.pgid') continue;; esac`,
		);
	});

	it('removes the file even for a group that is already gone', () => {
		// The file outliving its process is the ordinary case; removing it is the
		// whole repair, and it is reported as `gone` rather than as a kill.
		const command: string = sweepGroupsCommand([]);
		expect(command).toContain('rm -f "$file"');
		expect(command).toContain('else outcome=gone; fi');
	});

	it('says which files it dealt with and which of them were still running', () => {
		expect(
			parseSweptGroups('/tmp/mh-exec-1.pgid\t412\tkilled\n/tmp/mh-stream-2.pgid\t907\tgone\n'),
		).toEqual([
			{ groupFile: '/tmp/mh-exec-1.pgid', group: '412', outcome: 'killed' },
			// Only the file was left, so there was nothing to kill and nothing to
			// report as a leak; the caller still stops tracking it.
			{ groupFile: '/tmp/mh-stream-2.pgid', group: '907', outcome: 'gone' },
		]);
	});

	it('reads a clean pod as nothing swept', () => {
		expect(parseSweptGroups('')).toEqual([]);
	});
});
