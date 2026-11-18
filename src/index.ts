import { readConfig } from './config.js';
import { ArmadaCompute } from './provider.js';
import type { AdapterFactoryContext, ComputeAdapterModule } from './types.js';

const manifest: ComputeAdapterModule = {
	apiVersion: 1,
	kind: 'compute',
	create(context: AdapterFactoryContext) {
		// Typed as always there, as from 0.7.1, but an older marimohub hands over none.
		const errors: Partial<AdapterFactoryContext['errors']> = context.errors;
		if (errors.notFound === undefined) {
			throw new Error(
				'The Armada compute adapter needs marimohub 0.7.1 or later: older releases give library adapters no errors.notFound, so a lost pod would keep its notebook locked',
			);
		}
		return new ArmadaCompute(readConfig(context.env, context.compute), errors.notFound);
	},
};

export default manifest;
