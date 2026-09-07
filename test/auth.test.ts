import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { ArmadaClient } from '../src/armada.js';
import { authorizationHeader } from '../src/auth.js';
import type { ArmadaAuth } from '../src/auth.js';
import { readConfig } from '../src/config.js';

const baseEnv: Record<string, string | undefined> = {
	ARMADA_URL: 'https://armada.example.com',
	ARMADA_QUEUE: 'marimohub',
	MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
	ARMADA_AGENT_IMAGE: 'ghcr.io/example/kernel-agent:1',
};

function tokenFile(contents: string): string {
	const path: string = join(mkdtempSync(join(tmpdir(), 'armada-auth-')), 'token');
	writeFileSync(path, contents);
	return path;
}

describe('armada authorization', () => {
	it('defaults to anonymous, which the quickstart server accepts', async () => {
		expect(readConfig(baseEnv).auth).toEqual({ kind: 'anonymous' });
		expect(await authorizationHeader({ kind: 'anonymous' })).toBeUndefined();
	});

	it('encodes basic credentials the way the server decodes them', async () => {
		const auth: ArmadaAuth = readConfig({
			...baseEnv,
			ARMADA_AUTH_USERNAME: 'user',
			ARMADA_AUTH_PASSWORD: 'pass',
		}).auth;
		expect(auth).toEqual({ kind: 'basic', username: 'user', password: 'pass' });
		// base64("user:pass"), the same bytes as Go's base64.StdEncoding of user:pass.
		expect(await authorizationHeader(auth)).toBe('Basic dXNlcjpwYXNz');
	});

	it('sends a static token as a bearer', async () => {
		const auth: ArmadaAuth = readConfig({ ...baseEnv, ARMADA_AUTH_TOKEN: ' abc123 ' }).auth;
		expect(await authorizationHeader(auth)).toBe('Bearer abc123');
	});

	it('re-reads a token file per request, so rotation needs no restart', async () => {
		const path: string = tokenFile('first\n');
		const auth: ArmadaAuth = readConfig({ ...baseEnv, ARMADA_AUTH_TOKEN_FILE: path }).auth;
		expect(await authorizationHeader(auth)).toBe('Bearer first');

		writeFileSync(path, 'second\n');
		expect(await authorizationHeader(auth)).toBe('Bearer second');
	});

	it('rejects an unreadable or empty token file at startup', () => {
		expect(() => readConfig({ ...baseEnv, ARMADA_AUTH_TOKEN_FILE: '/nope/token' })).toThrow(
			'ARMADA_AUTH_TOKEN_FILE cannot be read',
		);
		expect(() => readConfig({ ...baseEnv, ARMADA_AUTH_TOKEN_FILE: tokenFile('  \n') })).toThrow(
			'ARMADA_AUTH_TOKEN_FILE is empty',
		);
	});

	it('rejects two mechanisms at once rather than picking one', () => {
		expect(() =>
			readConfig({ ...baseEnv, ARMADA_AUTH_TOKEN: 'abc', ARMADA_AUTH_USERNAME: 'user' }),
		).toThrow('Configure one Armada auth mechanism');
	});

	it('rejects half a basic credential', () => {
		expect(() => readConfig({ ...baseEnv, ARMADA_AUTH_USERNAME: 'user' })).toThrow(
			'must be set together',
		);
	});

	it('puts the header on every request, next to the content type', async () => {
		const anonymous: ArmadaClient = new ArmadaClient(readConfig(baseEnv));
		expect(await anonymous.requestHeaders()).toEqual({ 'content-type': 'application/json' });

		const authenticated: ArmadaClient = new ArmadaClient(
			readConfig({ ...baseEnv, ARMADA_AUTH_TOKEN: 'abc' }),
		);
		expect(await authenticated.requestHeaders()).toEqual({
			'content-type': 'application/json',
			authorization: 'Bearer abc',
		});
	});
});
