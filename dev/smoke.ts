#!/usr/bin/env bun
/**
 * Submit one job to Armada, reach the agent in its pod, run a command, and
 * check that nothing leaks.
 *
 * The smallest thing that proves both halves work: config, auth header, podspec,
 * submit and the event stream against a real Armada, then the agent that the
 * pod runs as PID 1, reached at the address Armada reported for it, with
 * no Kubernetes credential anywhere. Defaults point at the local kind cluster
 * from docs/CONTRIBUTING.md; every value can be overridden through the environment.
 *
 *   bun run smoke            # submit, report, cancel
 *   bun run smoke -- --keep  # leave the job running to poke at
 */
import { ArmadaClient } from '../src/armada.js';
import type { PodLocation } from '../src/armada.js';
import { AgentChannel } from '../src/channel.js';
import type { AgentEndpoint, CommandResult } from '../src/channel.js';
import { readConfig } from '../src/config.js';
import type { ArmadaConfig } from '../src/config.js';
import { ArmadaSandbox } from '../src/sandbox.js';
import { parseStrayProcesses, strayProcessCommand } from '../src/shell.js';
import type { StrayProcess } from '../src/shell.js';
import type { ExecResult } from '../src/types.js';

const config: ArmadaConfig = readConfig({
	ARMADA_URL: 'http://localhost:30001',
	ARMADA_QUEUE: 'marimohub',
	MARIMOHUB_COMPUTE_IMAGE: 'marimo-sandbox:local',
	ARMADA_AGENT_IMAGE: 'marimohub-kernel-agent:local',
	...process.env,
});

const sandboxId: string = `smoke-${Date.now().toString(36)}`;
const armada: ArmadaClient = new ArmadaClient(config);

// The sandbox opens the channel; keep a hand on it for the protocol commands
// below, which must not go through a login shell.
let agent: AgentChannel | undefined;
const sandbox: ArmadaSandbox = new ArmadaSandbox(
	sandboxId,
	config,
	armada,
	(endpoint: AgentEndpoint): AgentChannel => {
		console.log(`  agent   ${endpoint.address}`);
		agent = new AgentChannel(endpoint);
		return agent;
	},
);

console.log(`submitting ${sandboxId} to queue "${config.queue}" at ${config.url}`);
console.log(`  kernel image ${config.image}`);
console.log(`  agent image  ${config.agentImage}`);

const startedAt: number = Date.now();
await sandbox.ready();
const pod: PodLocation | undefined = sandbox.placement;
if (agent === undefined || pod === undefined) throw new Error('ready() returned without a pod');
const seconds: string = ((Date.now() - startedAt) / 1000).toFixed(1);

console.log(`\nrunning and answering after ${seconds}s`);
console.log(`  cluster ${pod.clusterId}`);
console.log(`  pod     ${pod.podNamespace}/${pod.podName}`);
console.log(`  node    ${pod.nodeName ?? 'unknown'}`);

console.log('\nrunning a command in it');
const hello: ExecResult = await sandbox.exec(
	'echo "hello from $(hostname)"; python3 -V; echo "PID 1 is $(tr -d \'\\0\' < /proc/1/cmdline | head -c 40)"',
);
for (const line of hello.stdout.trimEnd().split('\n')) console.log(`  ${line}`);
if (hello.stderr !== '') console.log(`  stderr: ${hello.stderr.trimEnd()}`);
console.log(`  ${hello.success ? 'ok' : 'failed'}`);
if (!hello.success) process.exitCode = 1;

// Abandon two commands on purpose, then look for what they left behind.
//
// The agent kills a command's process group when its deadline passes or its
// caller disconnects (decisions 23, 24 and 28), and a timed-out exec and a
// cancelled stream are the two ways the adapter abandons one. Both are
// provoked here before the leak check runs, because a check that never
// provokes the failure it looks for reports a clean pod either way.
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

// Killing is asynchronous, so give it a moment to land before concluding anything.
await new Promise((resolve: (value: unknown) => void) => setTimeout(resolve, 2_000));

// Both of those were killed by the agent, so the sweep would find nothing and
// prove nothing. Plant what a kill that never happened leaves behind: a process
// group with a group file that no sandbox is waiting on. This is exactly the
// state a marimohub restart leaves a pod in.
console.log('planting a ghost that no kill ever reached');
await agent.run([
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
const strays: CommandResult = await agent.run(['sh', '-c', strayProcessCommand()]);
const found: StrayProcess[] = parseStrayProcesses(strays.stdout);
for (const stray of found) {
	const what: string = stray.state === 'Z' ? 'zombie' : `state ${stray.state}`;
	console.log(`  pid ${stray.pid} (${what}) ${stray.command}`);
}
if (found.length === 0) {
	console.log('  none, and no zombies: PID 1 reaps what the kills left');
} else {
	// A zombie here means the agent's reaper is not doing its job; anything
	// else outlived the call that started it.
	console.log(`  ${String(found.length)} process(es) left behind`);
	process.exitCode = 1;
}

if (process.argv.includes('--keep')) {
	console.log(`\nleft running. cancel it with:`);
	console.log(`  armadactl cancel --queue ${config.queue} --jobSet ${sandboxId}`);
} else {
	await sandbox.destroy();
	console.log('\ncancelled');
}
