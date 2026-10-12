/**
 * Reads `CHANGELOG.md`, which drives releases: a new version heading on main is what
 * `.github/workflows/release.yml` publishes (see docs/CONTRIBUTING.md, "Releasing").
 *
 *   bun run scripts/changelog.ts version          the newest released version, or nothing
 *   bun run scripts/changelog.ts notes <version>  that version's changes, for the GitHub release
 *
 * Both fail on a changelog the release could not use, which is what CI checks on every
 * pull request.
 */
import { readFileSync } from 'node:fs';
import { parser } from 'keep-a-changelog';
import type { Changelog, Release } from 'keep-a-changelog';

const text: string = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
// Throws on a version heading without a date.
const changelog: Changelog = parser(text);
// The parser keeps releases newest first, `[Unreleased]` (no version) ahead of them.
const released: Release[] = changelog.releases.filter(
	(release: Release) => release.version !== undefined,
);
// A heading that is not semver parses as one more unversioned release, so a typo would
// skip the release without a word. Every heading but `[Unreleased]` must be a version.
for (const [, name] of text.matchAll(/^## \[([^\]]*)\]/gm)) {
	if (name?.toLowerCase() !== 'unreleased' && !released.some((r: Release) => r.version === name)) {
		throw new Error(`CHANGELOG.md: [${name}] is not a semantic version`);
	}
}

const [command, version] = process.argv.slice(2);
if (command === 'version') {
	console.log(released[0]?.version ?? '');
} else if (command === 'notes' && version !== undefined) {
	const release: Release | undefined = released.find((r: Release) => r.version === version);
	if (release === undefined) throw new Error(`CHANGELOG.md has no [${version}]`);
	// Drop the `## [x.y.z] - date` heading: the GitHub release has a title of its own.
	console.log(release.toString(changelog).split('\n').slice(1).join('\n').trim());
} else {
	console.error('usage: changelog.ts version | notes <version>');
	process.exit(2);
}
