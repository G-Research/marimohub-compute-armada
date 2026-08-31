/**
 * How the adapter authenticates to Armada.
 *
 * Armada offers basic, OIDC, Kubernetes-native and exec-based credentials
 * (`pkg/client/connection.go`), but on the wire they are all one header. The
 * server matches the scheme case-insensitively for both basic
 * (`internal/common/auth/basic.go`) and bearer (`internal/common/auth/oidc.go`),
 * and the REST gateway reads `Authorization` exactly like the gRPC path does.
 *
 * We implement basic and bearer. Kubernetes-native is deliberately absent: it
 * uses a custom `KubernetesAuth <base64>` scheme carrying a CA alongside the
 * token, and it exists for executors authenticating to the server, not for
 * clients like this one.
 *
 * OIDC flows are covered by pointing `ARMADA_AUTH_TOKEN_FILE` at a file some
 * other process keeps fresh. We re-read it per request rather than caching, so a
 * rotated token (a projected Kubernetes service account token, for example) is
 * picked up without restarting marimohub.
 */
import { readFile } from 'node:fs/promises';

export type ArmadaAuth =
	| { kind: 'anonymous' }
	| { kind: 'basic'; username: string; password: string }
	| { kind: 'bearer'; token: string }
	| { kind: 'bearerFile'; path: string };

/** The `Authorization` value, or nothing when the server allows anonymous access. */
export async function authorizationHeader(auth: ArmadaAuth): Promise<string | undefined> {
	switch (auth.kind) {
		case 'anonymous':
			return undefined;
		case 'basic': {
			const credentials: string = `${auth.username}:${auth.password}`;
			return `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
		}
		case 'bearer':
			return `Bearer ${auth.token}`;
		case 'bearerFile': {
			const token: string = (await readFile(auth.path, 'utf8')).trim();
			if (!token) throw new Error(`ARMADA_AUTH_TOKEN_FILE is empty: ${auth.path}`);
			return `Bearer ${token}`;
		}
		default: {
			const unhandled: never = auth;
			throw new Error(`Unhandled Armada auth kind: ${JSON.stringify(unhandled)}`);
		}
	}
}
