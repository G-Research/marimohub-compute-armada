/**
 * The one thing that sweeps every sandbox for abandoned process groups.
 *
 * A timer per sandbox was the obvious shape and the wrong one: sandboxes created
 * together sweep together, so twenty kernels started at nine o'clock fire twenty
 * exec websockets at the same API server in the same instant, every interval,
 * for the life of those sessions. The work is inherently per-pod and cannot be
 * batched, so the fix is not fewer round trips but fewer at once.
 *
 * Hence one timer and a concurrency cap. The cap is also what staggers the
 * passes: with four in flight, a hundred sandboxes are swept as a rolling queue
 * rather than a burst, and no jitter is needed to spread them out.
 */

/** What the sweeper needs of a sandbox. */
export interface Sweepable {
	/** Kill this sandbox's abandoned process groups, returning how many. */
	sweep(): Promise<number>;
}

/** Exec websockets in flight at once, across every sandbox. */
const SWEEP_CONCURRENCY = 4;

export class GhostSweeper {
	private readonly targets: Set<Sweepable> = new Set();
	private timer?: ReturnType<typeof setInterval> | undefined;
	private running = false;

	constructor(
		private readonly intervalMs: number,
		private readonly concurrency: number = SWEEP_CONCURRENCY,
	) {}

	/** Sweep this sandbox from now until it is removed. */
	add(target: Sweepable): void {
		this.targets.add(target);
		if (this.timer !== undefined || this.intervalMs <= 0) return;
		this.timer = setInterval(() => {
			void this.run();
		}, this.intervalMs);
		// Never a reason to hold marimohub's process open for a sweep.
		this.timer.unref?.();
	}

	/**
	 * Stop sweeping this sandbox. The timer goes with the last one, so an idle
	 * marimohub runs no timer at all rather than one that finds nothing.
	 */
	remove(target: Sweepable): void {
		this.targets.delete(target);
		if (this.targets.size > 0) return;
		this.stop();
	}

	stop(): void {
		if (this.timer === undefined) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/**
	 * One pass over every sandbox, at most `concurrency` at a time.
	 *
	 * A pass that outlives its interval is skipped rather than stacked: sweeps
	 * are repair work, and running two at once against the same pod would have
	 * the second see the first's kills as unowned.
	 */
	async run(): Promise<number> {
		if (this.running) return 0;
		this.running = true;
		try {
			const queue: Sweepable[] = [...this.targets];
			let killed = 0;
			const worker: () => Promise<void> = async () => {
				// oxlint-disable-next-line no-await-in-loop -- the loop is the cap
				for (
					let next: Sweepable | undefined = queue.pop();
					next !== undefined;
					next = queue.pop()
				) {
					// A sandbox destroyed mid-pass is no longer ours to exec into.
					if (!this.targets.has(next)) continue;
					// oxlint-disable-next-line no-await-in-loop -- one sweep at a time per worker
					const swept: number = await next.sweep();
					// Not `killed += await …`: that reads `killed` before awaiting, so
					// two workers finishing together lose one of the counts.
					killed += swept;
				}
			};
			await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker));
			return killed;
		} finally {
			this.running = false;
		}
	}
}
