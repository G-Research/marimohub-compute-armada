/**
 * Which Armada queue a sandbox belongs to.
 *
 * Armada tells tenants apart by queue: fair share and priority are computed per
 * queue, so the queue is the fairness model for a multi-tenant notebook server.
 * marimohub names a sandbox's owner (project, and user when it has one) on the
 * calls where it holds a record; `ARMADA_QUEUE_BY_USER` and
 * `ARMADA_QUEUE_BY_PROJECT` map those to queues, and `ARMADA_QUEUE` takes the
 * rest.
 *
 * The queue must be known again later, because every call that touches a job
 * (the event stream, cancel, even "cancel whatever is in this job set") is
 * addressed by queue and job set. The queue a job is in is state; the owner
 * map is configuration, and the two disagree the moment an operator moves a
 * project while its sessions run. So state is asked first, and the map only
 * places a sandbox that does not exist yet:
 *
 * 1. What this process has seen: a queue chosen at `create`, or reported by
 *    Lookout during `listActive`.
 * 2. Lookout, asked for the job set by name. marimohub creates sandboxes by id
 *    alone on paths that exec and destroy (surfaces, the reconciler, job
 *    cleanup), so after a restart this is the only source for those, on every
 *    marimohub version. A queue map therefore requires `ARMADA_LOOKOUT_URL`,
 *    which `readConfig` enforces.
 * 3. The owner map, for a job set Lookout says holds nothing: this is a submit
 *    that has not happened yet, and the owner decides where it goes.
 *
 * With no map configured every sandbox is in `ARMADA_QUEUE`, and none of this
 * costs a request.
 */
import type { ArmadaConfig } from './config.js';
import type { SandboxId, SandboxOwner } from './types.js';

/** Asks Lookout which queue holds a job set; `undefined` when it holds none. */
export type QueueLookup = (jobSetId: SandboxId) => Promise<string | undefined>;

/**
 * Lookout could not be asked, so the sandbox's queue is unknown. A guess would
 * cancel in the wrong queue and report success, or submit a second kernel next
 * to the first (Armada dedupes the client id per queue), so the call fails
 * instead. Every marimohub caller retries a failed create or destroy.
 */
export class QueueUnknownError extends Error {
	constructor(id: SandboxId, cause: unknown) {
		super(
			`cannot tell which queue sandbox ${id} is in: Lookout did not answer (${cause instanceof Error ? cause.message : String(cause)})`,
			{ cause },
		);
		this.name = 'QueueUnknownError';
	}
}

export class QueueDirectory {
	/** Every queue a sandbox of this deployment can be in, the default first. */
	readonly all: readonly string[];
	/** Whether any owner maps anywhere but the default queue. */
	readonly mapped: boolean;
	private readonly remembered: Map<SandboxId, string> = new Map();

	constructor(
		private readonly config: ArmadaConfig,
		private readonly lookup: QueueLookup | undefined,
	) {
		this.all = [
			...new Set([
				config.queue,
				...Object.values(config.queueByUser),
				...Object.values(config.queueByProject),
			]),
		];
		this.mapped = this.all.length > 1;
	}

	/** The queue an owner maps to: the user's, else the project's, else the default. */
	forOwner(owner: SandboxOwner): string {
		const byUser: string | undefined =
			owner.userId === undefined ? undefined : this.config.queueByUser[owner.userId];
		return byUser ?? this.config.queueByProject[owner.projectId] ?? this.config.queue;
	}

	remember(id: SandboxId, queue: string): void {
		this.remembered.set(id, queue);
	}

	/** Drops what was remembered for a sandbox whose job set is cancelled. */
	forget(id: SandboxId): void {
		this.remembered.delete(id);
	}

	/**
	 * The queue for a sandbox, by the three sources above. Fails only with
	 * {@link QueueUnknownError}, when a map is configured and Lookout cannot say.
	 */
	async resolve(id: SandboxId, owner: SandboxOwner | undefined): Promise<string> {
		const known: string | undefined = this.remembered.get(id);
		if (known !== undefined) return known;
		if (!this.mapped) return this.config.queue;
		if (this.lookup !== undefined) {
			let found: string | undefined;
			try {
				found = await this.lookup(id);
			} catch (cause: unknown) {
				throw new QueueUnknownError(id, cause);
			}
			if (found !== undefined) {
				this.remembered.set(id, found);
				return found;
			}
		}
		const queue: string = owner === undefined ? this.config.queue : this.forOwner(owner);
		this.remembered.set(id, queue);
		return queue;
	}
}
