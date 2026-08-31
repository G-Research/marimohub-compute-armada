import { readConfig } from './config.js';
import { ArmadaCompute } from './provider.js';
import type { AdapterFactoryContext, ComputeAdapterModule } from './types.js';

const manifest: ComputeAdapterModule = {
	apiVersion: 1,
	kind: 'compute',
	create(context: AdapterFactoryContext) {
		return new ArmadaCompute(readConfig(context.env));
	},
};

export default manifest;
