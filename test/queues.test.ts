import { describe, expect, it } from 'bun:test';
import { readConfig } from '../src/config.js';
import type { ArmadaConfig } from '../src/config.js';
import { QueueDirectory, QueueUnknownError } from '../src/queues.js';

const baseEnv: Record<string, string> = {
	ARMADA_URL: 'http://armada.example.com',
	ARMADA_QUEUE: 'marimohub',
	MARIMOHUB_COMPUTE_IMAGE: 'ghcr.io/example/marimo-sandbox:latest',
	ARMADA_AGENT_IMAGE: 'ghcr.io/example/kernel-agent:1',
	ARMADA_AGENT_TOKEN_SECRET: 'test-secret-of-at-least-32-characters',
};

const mapped: ArmadaConfig = readConfig({
	...baseEnv,
	ARMADA_LOOKOUT_URL: 'http://lookout.example.com',
	ARMADA_QUEUE_BY_USER: '{"user-a": "team-a"}',
	ARMADA_QUEUE_BY_PROJECT: '{"proj-b": "team-b", "proj-a": "team-a"}',
});

/** A Lookout that holds no job for any set, counting what it was asked. */
function emptyLookout(asked: string[]): (id: string) => Promise<undefined> {
	return async (id: string): Promise<undefined> => {
		asked.push(id);
		return undefined;
	};
}

describe('QueueDirectory', () => {
	it('lists the default queue first and every mapped queue once', () => {
		expect(new QueueDirectory(mapped, undefined).all).toEqual(['marimohub', 'team-a', 'team-b']);
		expect(new QueueDirectory(readConfig(baseEnv), undefined).all).toEqual(['marimohub']);
	});

	it('maps an owner by user first, then project, then the default', () => {
		const queues: QueueDirectory = new QueueDirectory(mapped, undefined);
		expect(queues.forOwner({ projectId: 'proj-b', userId: 'user-a' })).toBe('team-a');
		expect(queues.forOwner({ projectId: 'proj-b', userId: 'user-x' })).toBe('team-b');
		expect(queues.forOwner({ projectId: 'proj-b' })).toBe('team-b');
		expect(queues.forOwner({ projectId: 'proj-x', userId: 'user-x' })).toBe('marimohub');
	});

	it('places a sandbox Lookout holds nothing for by its owner, and remembers the answer', async () => {
		const asked: string[] = [];
		const queues: QueueDirectory = new QueueDirectory(mapped, emptyLookout(asked));
		expect(await queues.resolve('sb-1', { projectId: 'proj-b' })).toBe('team-b');
		expect(await queues.resolve('sb-1', undefined)).toBe('team-b');
		expect(asked).toEqual(['sb-1']);
	});

	it('takes the queue Lookout reports over the one the owner maps to now', async () => {
		// The map moved proj-b to team-b while the job runs in team-a: the job
		// is where it is, and that is where a cancel must go.
		const queues: QueueDirectory = new QueueDirectory(mapped, async () => 'team-a');
		expect(await queues.resolve('sb-2', { projectId: 'proj-b' })).toBe('team-a');
	});

	it('asks Lookout for a sandbox it has never seen, once', async () => {
		const asked: string[] = [];
		const queues: QueueDirectory = new QueueDirectory(mapped, async (id: string) => {
			asked.push(id);
			return 'team-a';
		});
		expect(await queues.resolve('sb-3', undefined)).toBe('team-a');
		expect(await queues.resolve('sb-3', undefined)).toBe('team-a');
		expect(asked).toEqual(['sb-3']);
	});

	it('falls back to the default queue for an unowned set Lookout does not know', async () => {
		const queues: QueueDirectory = new QueueDirectory(mapped, emptyLookout([]));
		expect(await queues.resolve('sb-4', undefined)).toBe('marimohub');
	});

	it('never asks Lookout when nothing maps away from the default queue', async () => {
		let asked = 0;
		const queues: QueueDirectory = new QueueDirectory(readConfig(baseEnv), async () => {
			asked += 1;
			return 'elsewhere';
		});
		expect(await queues.resolve('sb-5', { projectId: 'proj-b' })).toBe('marimohub');
		expect(asked).toBe(0);
	});

	it('takes what listActive remembered over Lookout and over the owner', async () => {
		let asked = 0;
		const queues: QueueDirectory = new QueueDirectory(mapped, async () => {
			asked += 1;
			return 'elsewhere';
		});
		queues.remember('sb-6', 'team-a');
		expect(await queues.resolve('sb-6', { projectId: 'proj-b' })).toBe('team-a');
		expect(asked).toBe(0);
	});

	it('fails, naming Lookout, rather than guess when Lookout cannot be asked', async () => {
		const queues: QueueDirectory = new QueueDirectory(mapped, async () => {
			throw new Error('503 Service Unavailable');
		});
		const failure: unknown = await queues
			.resolve('sb-7', { projectId: 'proj-b' })
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(QueueUnknownError);
		if (failure instanceof QueueUnknownError) {
			expect(failure.message).toContain('Lookout did not answer');
			expect(failure.message).toContain('503');
		}
	});

	it('forgets a sandbox, so the next question goes to Lookout again', async () => {
		const asked: string[] = [];
		const queues: QueueDirectory = new QueueDirectory(mapped, emptyLookout(asked));
		queues.remember('sb-8', 'team-a');
		queues.forget('sb-8');
		expect(await queues.resolve('sb-8', undefined)).toBe('marimohub');
		expect(asked).toEqual(['sb-8']);
	});
});
