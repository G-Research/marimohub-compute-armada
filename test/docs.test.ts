/**
 * The configuration reference ships in the npm package and is what people and agents
 * configure the adapter from, so it must match the code: every variable `readConfig`
 * reads is documented, nothing it does not read is, the example template is one the
 * adapter accepts, and every link in a shipped document leads somewhere the package or
 * the repository has.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { RESERVED_NAMES } from '../src/podspec.js';
import { parsePodTemplate } from '../src/podtemplate.js';

const ROOT: string = join(import.meta.dir, '..');
const REPO_BLOB: string = 'https://github.com/G-Research/marimohub-compute-armada/blob/main/';

function read(path: string): string {
	return readFileSync(join(ROOT, path), 'utf8');
}

const VARIABLE: RegExp = /(?:ARMADA|MARIMOHUB)_[A-Z0-9_]+/g;

/**
 * Every variable the source reads: `env.NAME`, or `'NAME'` passed to a reader. All of
 * `src/` is scanned, so a variable read outside `readConfig` is caught too. The
 * formatter allows single quotes only, so a double-quoted name cannot slip past.
 */
function variablesRead(): Set<string> {
	const source: string = readdirSync(join(ROOT, 'src'))
		.filter((file: string) => file.endsWith('.ts'))
		.map((file: string) => read(`src/${file}`))
		.join('\n');
	const names: Set<string> = new Set();
	for (const match of source.matchAll(/env\.((?:ARMADA|MARIMOHUB)_[A-Z0-9_]+)/g)) {
		names.add(match[1] ?? '');
	}
	for (const match of source.matchAll(/'((?:ARMADA|MARIMOHUB)_[A-Z0-9_]+)'/g)) {
		names.add(match[1] ?? '');
	}
	return names;
}

const reference: string = read('docs/CONFIGURATION.md');

/** Variables named in a heading of the reference, which is where each is defined. */
function variablesWithHeading(): Set<string> {
	const names: Set<string> = new Set();
	for (const line of reference.split('\n')) {
		if (!line.startsWith('#')) continue;
		for (const name of line.matchAll(/`([^`]+)`/g)) {
			if ((name[1] ?? '').match(VARIABLE)?.[0] === name[1]) names.add(name[1] ?? '');
		}
	}
	return names;
}

/** Variables with a row in the reference's summary table. */
function variablesInTable(): Set<string> {
	const names: Set<string> = new Set();
	for (const match of reference.matchAll(/^\| `((?:ARMADA|MARIMOHUB)_[A-Z0-9_]+)` /gm)) {
		names.add(match[1] ?? '');
	}
	return names;
}

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
	return heading
		.toLowerCase()
		.replace(/[^\p{L}\p{N} _-]/gu, '')
		.replace(/ /g, '-');
}

function anchors(markdown: string): Set<string> {
	const found: Set<string> = new Set();
	for (const match of markdown.matchAll(/^#+ (.+)$/gm)) found.add(slug(match[1] ?? ''));
	return found;
}

/** What `npm pack` includes: the `files` entries, plus what npm always adds. */
function shipped(path: string): boolean {
	const manifest: unknown = JSON.parse(read('package.json'));
	const files: unknown =
		typeof manifest === 'object' && manifest !== null && 'files' in manifest ? manifest.files : [];
	const entries: string[] = Array.isArray(files)
		? files.filter((entry: unknown) => typeof entry === 'string')
		: [];
	return ['README.md', 'LICENSE', 'package.json', ...entries].some(
		(entry: string) => path === entry || path.startsWith(`${entry}/`),
	);
}

describe('docs/CONFIGURATION.md', () => {
	const inSource: Set<string> = variablesRead();

	it('finds the variables in the source at all', () => {
		expect(inSource.has('ARMADA_URL')).toBe(true);
		expect(inSource.has('ARMADA_POD_TEMPLATE_FILE')).toBe(true);
		expect(inSource.has('MARIMOHUB_SURFACE_VSCODE_PORT')).toBe(true);
	});

	it('has a heading for every variable the adapter reads', () => {
		const documented: Set<string> = variablesWithHeading();
		expect([...inSource].filter((name: string) => !documented.has(name))).toEqual([]);
	});

	it('lists every variable the adapter reads in its table', () => {
		const listed: Set<string> = variablesInTable();
		expect([...inSource].filter((name: string) => !listed.has(name))).toEqual([]);
	});

	it('documents no variable the adapter does not read', () => {
		const documented: string[] = [...variablesWithHeading(), ...variablesInTable()];
		expect(documented.filter((name: string) => !inSource.has(name))).toEqual([]);
	});
});

describe('examples/kernel-pod.yaml', () => {
	it('is a template the adapter accepts', () => {
		expect(() => parsePodTemplate(read('examples/kernel-pod.yaml'), RESERVED_NAMES)).not.toThrow();
	});
});

describe('links in the documents the package ships', () => {
	for (const document of ['README.md', 'docs/CONFIGURATION.md', 'CHANGELOG.md']) {
		it(`${document} links only to what exists`, () => {
			expect(shipped(document)).toBe(true);
			const text: string = read(document);
			const broken: string[] = [];
			for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
				const target: string = match[1] ?? '';
				if (target.startsWith('#')) {
					if (!anchors(text).has(target.slice(1))) broken.push(target);
					continue;
				}
				const local: string | undefined = target.startsWith(REPO_BLOB)
					? target.slice(REPO_BLOB.length)
					: /^[a-z]+:/.test(target)
						? undefined
						: relative(ROOT, normalize(join(ROOT, dirname(document), target)));
				if (local === undefined) continue;
				const [path = '', anchor] = local.split('#');
				if (!existsSync(join(ROOT, path))) {
					broken.push(target);
				} else if (!target.startsWith(REPO_BLOB) && !shipped(path)) {
					// A relative link must reach a file in the package too, or it is dead
					// in node_modules; link the repository instead.
					broken.push(`${target} (not in the npm package)`);
				} else if (anchor !== undefined && !anchors(read(path)).has(anchor)) {
					broken.push(target);
				}
			}
			expect(broken).toEqual([]);
		});
	}
});
