/**
 * Kubernetes credentials for the cluster a job landed on.
 *
 * Armada tells us where a pod is running as a `clusterId` string and offers no
 * way to turn that into an API server address. That is by design: its own
 * components solve it with operator configuration. Lookout reaches the binoculars
 * instance in each cluster through a URL pattern with `{CLUSTER_ID}` substituted
 * in (`internal/lookoutui/src/services/apiClients/context.tsx`), and this is the
 * same idea applied to kubeconfigs.
 *
 * With no pattern configured we fall back to the ambient credentials, which is
 * what a single-cluster deployment and a developer's laptop both want.
 */
import type { KubeConfig } from '@kubernetes/client-node';

export class ClusterAccess {
	/** One `KubeConfig` per cluster; they are immutable once loaded. */
	private readonly loaded: Map<string, KubeConfig> = new Map();

	constructor(private readonly pattern?: string) {}

	/** Path this cluster's credentials come from, or nothing for ambient ones. */
	pathFor(clusterId: string): string | undefined {
		return this.pattern?.replaceAll('{CLUSTER_ID}', clusterId);
	}

	async configFor(clusterId: string): Promise<KubeConfig> {
		const cached: KubeConfig | undefined = this.loaded.get(clusterId);
		if (cached !== undefined) return cached;

		// Loaded lazily: importing the Kubernetes client is what makes this bundle
		// megabytes rather than kilobytes, so a config error never pays for it.
		const { KubeConfig: KubeConfigClass } = await import('@kubernetes/client-node');
		const config: KubeConfig = new KubeConfigClass();
		const path: string | undefined = this.pathFor(clusterId);

		try {
			if (path === undefined) config.loadFromDefault();
			else config.loadFromFile(path);
		} catch (cause) {
			const from: string = path === undefined ? 'the ambient configuration' : path;
			throw new Error(`No Kubernetes credentials for Armada cluster ${clusterId} from ${from}`, {
				cause,
			});
		}

		this.loaded.set(clusterId, config);
		return config;
	}
}
