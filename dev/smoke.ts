#!/usr/bin/env bun
/**
 * Submit one job to Armada, wait for its pod to run, print where it landed.
 *
 * The smallest thing that proves both halves work: config, auth header, podspec,
 * submit and the event stream against a real Armada, then a command run inside
 * the pod it placed. Defaults point at the local kind cluster from README.md;
 * every value can be overridden through the environment.
 *
 *   bun run smoke            # submit, report, cancel
 *   bun run smoke -- --keep  # leave the job running to poke at
 */
import { ArmadaClient } from '../src/armada.js';
import type { PodLocation, SubmittedJob } from '../src/armada.js';
import { ClusterAccess } from '../src/clusters.js';
import { readConfig } from '../src/config.js';
import type { ArmadaConfig } from '../src/config.js';
import { PodExec } from '../src/exec.js';
import type { PodExecResult } from '../src/exec.js';
import { buildPodSpec } from '../src/podspec.js';
import { ArmadaSandbox } from '../src/sandbox.js';
import { parseStrayProcesses, strayProcessCommand } from '../src/shell.js';
import type { StrayProcess } from '../src/shell.js';
import type { ExecResult } from '../src/types.js';

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
console.log('\nrunning a command in it');
const podExec: PodExec = new PodExec(new ClusterAccess(config.kubeconfigPattern));
const hello: PodExecResult = await podExec.run(pod, [
	'sh',
	'-c',
	'echo "hello from $(hostname)"; python3 -V',
]);
for (const line of hello.stdout.trimEnd().split('\n')) console.log(`  ${line}`);
if (hello.stderr !== '') console.log(`  stderr: ${hello.stderr.trimEnd()}`);
console.log(`  exit ${String(hello.exitCode)}`);

// Abandon two commands on purpose, then look for what they left behind.
//
// Closing an exec websocket does not stop the command it started (decisions 23
// and 24), so a timed-out exec and a cancelled stream are the two ways the
// adapter can leak a process into a live pod. Both are abandoned here before the
// ghost check runs, because a check that never provokes the failure it looks for
// reports a clean pod whether or not the kill still works.
const sandbox: ArmadaSandbox = new ArmadaSandbox(sandboxId, config, armada, podExec);
await sandbox.ready();

console.log('\nabandoning a command that outruns its timeout');
const spin = 'while true; do echo tick; sleep 0.2; done';
const timedOut: ExecResult = await sandbox.exec(spin, { timeout: 1_500 });
console.log(`  ${timedOut.success ? 'returned' : 'failed'}: ${timedOut.stderr.trim()}`);

console.log('cancelling a stream while its command is still running');
const stream: ReadableStream<Uint8Array> = await sandbox.execStream(spin);
const reader: ReadableStreamDefaultReader<Uint8Array> = stream.getReader();
await reader.read();
await reader.cancel();
console.log('  cancelled after the first chunk');

// Killing is best effort and asynchronous, so give it a moment to land before
// concluding anything.
await new Promise((resolve: (value: unknown) => void) => setTimeout(resolve, 2_000));

// Both of those are killed by `onStop`, so the sweep would find nothing and
// prove nothing. Plant what a kill that never happened leaves behind: a process
// group with a group file that no sandbox is waiting on. This is exactly the
// state a marimohub restart leaves a pod in.
console.log('planting a ghost that no kill ever reached');
await podExec.run(pod, [
	'sh',
	'-c',
	"setsid sh -c 'echo $$ > /tmp/mh-planted.pgid; sleep 300' >/dev/null 2>&1 & sleep 0.3; " +
		'cat /tmp/mh-planted.pgid',
]);

// The periodic sweep, run once by hand rather than waiting a minute for its
// timer: it is what repairs a kill that never happened.
const swept: number = await sandbox.sweep();
console.log(`  sweep killed ${String(swept)} abandoned group(s)`);
if (swept === 0) {
	console.log('  expected the planted ghost to be killed; the sweep is not working');
	process.exitCode = 1;
}

console.log('looking for processes nothing is waiting on');
const strays: PodExecResult = await podExec.run(pod, ['sh', '-c', strayProcessCommand()]);
const found: StrayProcess[] = parseStrayProcesses(strays.stdout);
const alive: StrayProcess[] = found.filter((stray: StrayProcess) => stray.state !== 'Z');
for (const stray of found) {
	const what: string = stray.state === 'Z' ? 'zombie' : `state ${stray.state}`;
	console.log(`  pid ${stray.pid} (${what}) ${stray.command}`);
}
if (alive.length === 0) {
	// Zombies are expected: the pod's PID 1 is `sleep infinity` and never reaps.
	console.log(`  no live strays${found.length === 0 ? '' : ', only zombies PID 1 never reaped'}`);
} else {
	console.log(`  ${String(alive.length)} process(es) outlived the call that started them`);
	process.exitCode = 1;
}

if (process.argv.includes('--keep')) {
	console.log(`\nleft running. cancel it with:`);
	console.log(`  armadactl cancel --queue ${config.queue} --jobSet ${sandboxId}`);
} else {
	await armada.cancel(job);
	console.log('\ncancelled');
}
