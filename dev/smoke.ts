#!/usr/bin/env bun
/**
 * Submit one job to Armada, wait for its pod to run, print where it landed.
 *
 * The smallest thing that proves the placement half works: config, auth header,
 * podspec, submit, and the event stream, against a real server. Defaults point at
 * the local kind cluster from README.md; every value can be overridden through
 * the environment.
 *
 *   bun run smoke            # submit, report, cancel
 *   bun run smoke -- --keep  # leave the job running to poke at
 */
import { ArmadaClient } from '../src/armada.js';
import type { PodLocation, SubmittedJob } from '../src/armada.js';
import { readConfig } from '../src/config.js';
import type { ArmadaConfig } from '../src/config.js';
import { buildPodSpec } from '../src/podspec.js';

const config: ArmadaConfig = readConfig({
	ARMADA_URL: 'http://localhost:30001',
	ARMADA_QUEUE: 'marimohub',
	MARIMOHUB_COMPUTE_IMAGE: 'marimo-sandbox:local',
	...process.env,
});

const sandboxId: string = `smoke-${Date.now().toString(36)}`;
const armada: ArmadaClient = new ArmadaClient(config);

console.log(`submitting ${sandboxId} to queue "${config.queue}" at ${config.url}`);
console.log(`  image ${config.image}`);

const startedAt: number = Date.now();
const job: SubmittedJob = await armada.submit(sandboxId, buildPodSpec(config));
console.log(`  job ${job.jobId}, waiting for it to run`);

const pod: PodLocation = await armada.waitForRunning(job);
const seconds: string = ((Date.now() - startedAt) / 1000).toFixed(1);

console.log(`\nrunning after ${seconds}s`);
console.log(`  cluster ${pod.clusterId}`);
console.log(`  pod     ${pod.podNamespace}/${pod.podName}`);
console.log(`  node    ${pod.nodeName ?? 'unknown'}`);
console.log(`\n  kubectl exec -n ${pod.podNamespace} ${pod.podName} -- echo hello`);

if (process.argv.includes('--keep')) {
	console.log(`\nleft running. cancel it with:`);
	console.log(`  armadactl cancel --queue ${config.queue} --jobSet ${sandboxId}`);
} else {
	await armada.cancel(job);
	console.log('\ncancelled');
}
