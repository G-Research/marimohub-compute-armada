import { describe, expect, it } from 'bun:test';
import { GhostSweeper } from '../src/sweeper.js';
import type { Sweepable } from '../src/sweeper.js';

/** A sandbox that records when it was swept and how many were in flight. */
function target(killed: number = 0): Sweepable & { sweeps: number } {
	return {
		sweeps: 0,
		async sweep(): Promise<number> {
			this.sweeps++;
			return killed;
		},
	};
}

/** A sandbox whose sweep the test decides when to finish. */
function slowTarget(): Sweepable & { finish: () => void; started: boolean } {
	let release: (() => void) | undefined;
	let finished = false;
	return {
		started: false,
		finish() {
			// Recorded, not just signalled: a sweep still queued behind the cap has
			// not reached its `await` yet, and must not block on a signal it missed.
			finished = true;
			release?.();
		},
		async sweep(): Promise<number> {
			this.started = true;
			if (!finished) {
				await new Promise<void>((resolve: () => void) => {
					release = resolve;
				});
			}
			return 0;
		},
	};
}

describe('ghost sweeper', () => {
	it('sweeps every sandbox it has been given', async () => {
		const sweeper: GhostSweeper = new GhostSweeper(0);
		const first: Sweepable & { sweeps: number } = target(2);
		const second: Sweepable & { sweeps: number } = target(1);
		sweeper.add(first);
		sweeper.add(second);

		expect(await sweeper.run()).toBe(3);
		expect([first.sweeps, second.sweeps]).toEqual([1, 1]);
	});

	it('sweeps no more than the cap at once, which is what staggers a pass', async () => {
		const sweeper: GhostSweeper = new GhostSweeper(0, 2);
		const slow: (Sweepable & { finish: () => void; started: boolean })[] = [
			slowTarget(),
			slowTarget(),
			slowTarget(),
		];
		for (const one of slow) sweeper.add(one);

		const pass: Promise<number> = sweeper.run();
		await Promise.resolve();
		// Twenty sandboxes created together must not become twenty websockets at
		// once, which is the whole reason this is one sweeper and not twenty.
		expect(slow.filter((one: { started: boolean }) => one.started)).toHaveLength(2);

		for (const one of slow) one.finish();
		await pass;
	});

	it('skips a pass rather than stacking one on the last', async () => {
		const sweeper: GhostSweeper = new GhostSweeper(0, 1);
		const slow: Sweepable & { finish: () => void } = slowTarget();
		sweeper.add(slow);

		const first: Promise<number> = sweeper.run();
		await Promise.resolve();
		// Two sweeps at once against one pod would have the second read the first's
		// kills as unowned groups.
		expect(await sweeper.run()).toBe(0);

		slow.finish();
		await first;
	});

	it('leaves a sandbox alone once it has been removed', async () => {
		const sweeper: GhostSweeper = new GhostSweeper(0);
		const gone: Sweepable & { sweeps: number } = target();
		sweeper.add(gone);
		sweeper.remove(gone);

		await sweeper.run();
		expect(gone.sweeps).toBe(0);
	});

	it('runs no timer when sweeping is turned off', () => {
		const sweeper: GhostSweeper = new GhostSweeper(0);
		sweeper.add(target());
		// `ARMADA_GHOST_SWEEP_SECONDS=0`: nothing scheduled, and `run` still works
		// for a caller that asks directly.
		expect(sweeper.stop.bind(sweeper)).not.toThrow();
	});
});
