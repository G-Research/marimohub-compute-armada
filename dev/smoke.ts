#!/usr/bin/env bun
/**
 * Submit one job to Armada, reach the agent in its pod, drive every kind of
 * request it answers, and check that nothing leaks.
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
import type { AgentEndpoint, CommandResult, ProcessStatus } from '../src/channel.js';
import { readConfig } from '../src/config.js';
import type { ArmadaConfig } from '../src/config.js';
import { ArmadaSandbox } from '../src/sandbox.js';
import { parseStrayProcesses, strayProcessCommand } from '../src/shell.js';
import type { StrayProcess } from '../src/shell.js';
import type { ExecResult, ListFilesResult, ReadFileResult, SandboxProcess } from '../src/types.js';

const config: ArmadaConfig = readConfig({
	ARMADA_URL: 'http://localhost:30001',
	ARMADA_QUEUE: 'marimohub',
	MARIMOHUB_COMPUTE_IMAGE: 'marimo-sandbox:local',
	ARMADA_AGENT_IMAGE: 'marimohub-kernel-agent:local',
	...process.env,
});

const sandboxId: string = `smoke-${Date.now().toString(36)}`;
const armada: ArmadaClient = new ArmadaClient(config);

let failures = 0;
function check(passed: boolean, message: string): void {
	console.log(`  ${passed ? 'ok' : 'FAILED'}: ${message}`);
	if (!passed) {
		failures += 1;
		process.exitCode = 1;
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve: (value: void) => void) => setTimeout(resolve, ms));
}

// The sandbox opens the channel; keep a hand on it for the protocol requests
// below, which the sandbox interface does not expose directly.
let agent: AgentChannel | undefined;
const sandbox: ArmadaSandbox = new ArmadaSandbox(
	sandboxId,
	config,
	armada,
	(endpoint: AgentEndpoint): AgentChannel => {
		console.log(`  agent   ${endpoint.url}`);
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
check(hello.success, 'exec through the agent');

// Bytes and paths cross the file endpoints raw: a path that would have needed
// quoting and content that base64 used to protect are the interesting case.
console.log('\nwriting, reading and listing files through the agent');
const filePath = "/tmp/smoke dir/it's.bin";
const fileBytes: Uint8Array = new Uint8Array([0, 159, 146, 150, 10]);
await sandbox.writeFiles([{ path: filePath, content: fileBytes }]);
const readBack: ReadFileResult = await sandbox.readFile(filePath);
check(
	readBack.success &&
		readBack.encoding === 'base64' &&
		Buffer.from(readBack.content, 'base64').equals(Buffer.from(fileBytes)),
	'binary bytes round-trip exactly, reported as base64',
);
const listed: ListFilesResult = await sandbox.listFiles('/tmp/smoke dir');
check(
	listed.success &&
		listed.files.length === 1 &&
		listed.files[0]?.name === "it's.bin" &&
		listed.files[0].size === fileBytes.length,
	'the listing names the file with its size',
);
const missing: ReadFileResult = await sandbox.readFile('/tmp/smoke dir/never-written');
check(!missing.success && missing.error.code === 'NOT_FOUND', 'an absent path is NOT_FOUND');

// A detached process: the agent parents it, waits for its port, and reports
// its death precisely. This is the kernel's lifecycle in miniature.
console.log('\nstarting a detached process and waiting for its port');
// The `echo` gives the log something to hold; http.server itself prints
// nothing until a request arrives, which this run never sends.
const serving: SandboxProcess = await sandbox.startProcess(
	'echo "serving on 8123"; python3 -m http.server 8123',
);
const servingPid: number = Number(serving.id.replace('armada-proc-', ''));
await serving.waitForPort(8123, { timeout: 30_000 });
console.log('  port 8123 answered');
const alive: ProcessStatus = await agent.processStatus(servingPid);
check(alive.running, 'the agent reports the server running');
await serving.kill();
let afterKill: ProcessStatus = { running: true };
for (let attempt = 0; attempt < 50 && afterKill.running; attempt++) {
	// oxlint-disable-next-line no-await-in-loop -- polling for the TERM to land
	await sleep(100);
	// oxlint-disable-next-line no-await-in-loop
	afterKill = await agent.processStatus(servingPid);
}
check(!afterKill.running, 'kill() really terminated it');
const logs: { stdout: string } = await serving.getLogs();
check(logs.stdout.length > 0, 'its log survived it');

console.log('starting a process that dies at once');
const crashing: SandboxProcess = await sandbox.startProcess('echo boom; exit 7');
let crashReport = '';
try {
	await crashing.waitForPort(8124, { timeout: 20_000 });
} catch (error) {
	crashReport = error instanceof Error ? error.message : String(error);
}
check(
	crashReport.includes('process exited before port 8124 opened') && crashReport.includes('boom'),
	'the wait reports a crash with the log, not a timeout',
);

// Abandon two commands on purpose, then look for what they left behind. The
// agent kills a command's process group when its deadline passes or its
// caller disconnects (decisions 23, 24 and 28); a timed-out exec and a
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
await sleep(2_000);

console.log('looking for processes nothing is waiting on');
const strays: CommandResult = await agent.run(['sh', '-c', strayProcessCommand()]);
const found: StrayProcess[] = parseStrayProcesses(strays.stdout);
for (const stray of found) {
	const what: string = stray.state === 'Z' ? 'zombie' : `state ${stray.state}`;
	console.log(`  pid ${stray.pid} (${what}) ${stray.command}`);
}
check(
	found.length === 0,
	'nothing is left behind, zombies included: the agent kills what its callers abandon and reaps the rest',
);

if (process.argv.includes('--keep')) {
	console.log(`\nleft running. cancel it with:`);
	console.log(`  armadactl cancel --queue ${config.queue} --jobSet ${sandboxId}`);
} else {
	await sandbox.destroy();
	console.log('\ncancelled');
}
console.log(failures === 0 ? 'all checks passed' : `${String(failures)} check(s) FAILED`);
