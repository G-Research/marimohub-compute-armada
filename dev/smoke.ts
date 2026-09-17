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
import { ArmadaCompute } from '../src/provider.js';
import type { PodLocation } from '../src/armada.js';
import { AgentChannel } from '../src/channel.js';
import type { AgentEndpoint, CommandResult, ProcessStatus } from '../src/channel.js';
import { readConfig } from '../src/config.js';
import type { ArmadaConfig } from '../src/config.js';
import { QueueDirectory } from '../src/queues.js';
import { ArmadaSandbox } from '../src/sandbox.js';
import { parseStrayProcesses, strayProcessCommand } from '../src/shell.js';
import type { StrayProcess } from '../src/shell.js';
import type {
	ActiveSandbox,
	ExecResult,
	ListFilesResult,
	ReadFileResult,
	SandboxOwner,
	SandboxProcess,
} from '../src/types.js';

const config: ArmadaConfig = readConfig({
	ARMADA_URL: 'http://localhost:30001',
	ARMADA_QUEUE: 'marimohub',
	ARMADA_AGENT_IMAGE: 'marimohub-kernel-agent:local',
	// A secondary surface, so the pod declares a third port and the provider
	// advertises multiPort; the checks below look at that port's address.
	MARIMOHUB_SURFACES: 'vscode',
	...process.env,
});

const sandboxId: string = `smoke-${Date.now().toString(36)}`;
const armada: ArmadaClient = new ArmadaClient(config);

// Name an owner to exercise the queue map (`ARMADA_QUEUE_BY_PROJECT`,
// `ARMADA_QUEUE_BY_USER`): the job goes to the owner's queue, and a second
// provider that knows nothing but the id finds that queue again through Lookout.
const owner: SandboxOwner | undefined =
	process.env.SMOKE_OWNER_PROJECT === undefined
		? undefined
		: {
				projectId: process.env.SMOKE_OWNER_PROJECT,
				...(process.env.SMOKE_OWNER_USER === undefined
					? {}
					: { userId: process.env.SMOKE_OWNER_USER }),
			};
const queues: QueueDirectory = new QueueDirectory(config, async (id: string) =>
	armada.findQueue(id),
);
// Checked before anything is submitted: the owner check at the end needs a
// second provider that can enumerate, and a run that cannot must not leave a
// job behind.
if (owner !== undefined && config.lookoutUrl === undefined) {
	throw new Error('an owner check needs ARMADA_LOOKOUT_URL');
}

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
	queues,
	owner === undefined ? undefined : { owner },
);

console.log(
	`submitting ${sandboxId}${owner === undefined ? '' : ` for ${JSON.stringify(owner)}`} at ${config.url}`,
);
console.log(`  kernel image ${config.image}`);
console.log(`  agent image  ${config.agentImage}`);

const startedAt: number = Date.now();
await sandbox.ready();
const pod: PodLocation | undefined = sandbox.placement;
if (agent === undefined || pod === undefined) throw new Error('ready() returned without a pod');
const seconds: string = ((Date.now() - startedAt) / 1000).toFixed(1);
const queue: string = await sandbox.queue();

console.log(`\nrunning and answering after ${seconds}s`);
console.log(`  queue   ${queue}`);
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
// The readiness a surface asks for: an HTTP answer on a path, not just a TCP
// accept, and a one-shot look at it afterwards.
await serving.waitForPort(8123, { mode: 'http', path: '/', timeout: 10_000 });
check(
	await sandbox.isPortReady(8123, { path: '/' }),
	'isPortReady sees the server answer over http',
);
check(!(await sandbox.isPortReady(8125)), 'isPortReady is false for a port nothing listens on');
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

console.log('exposing the kernel port and a surface port');
const kernelUrl: string = (await sandbox.exposePort(config.port, { hostname: 'ignored' })).url;
const surfaceUrl: string = (await sandbox.exposePort(8443, { hostname: 'ignored' })).url;
const surfaceAgain: string = (await sandbox.exposePort(8443, { hostname: 'ignored' })).url;
console.log(`  kernel  ${kernelUrl}`);
console.log(`  surface ${surfaceUrl}`);
check(
	new ArmadaCompute(config).capabilities.multiPort &&
		surfaceUrl !== kernelUrl &&
		surfaceAgain === surfaceUrl,
	"multiPort: the surface port has its own stable address next to the kernel's",
);

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
// caller disconnects; a timed-out exec and a
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
	console.log(`  armadactl cancel --queue ${queue} --jobSet ${sandboxId}`);
} else if (owner === undefined) {
	await sandbox.destroy();
	console.log('\ncancelled');
} else {
	// A restart, in miniature: a provider with no memory of this sandbox must
	// enumerate it (listActive spans every mapped queue) and cancel it in the
	// right queue, which it can only learn from Lookout.
	console.log('\ndestroying through a provider that knows only the id');
	// The lookup by job set on its own, before listActive can remember anything.
	check(
		(await armada.findQueue(sandboxId)) === queue,
		`Lookout names queue "${queue}" for the job set, by the installation's mark`,
	);
	const fresh: ArmadaCompute = new ArmadaCompute(config);
	if (fresh.listActive === undefined) throw new Error('unreachable: Lookout was checked above');
	const before: ActiveSandbox[] = await fresh.listActive();
	check(
		before.some((active: ActiveSandbox) => active.id === sandboxId),
		`listActive sees it (${String(before.length)} active across ${queues.all.join(', ')})`,
	);
	await fresh.create(sandboxId).destroy();
	let gone = false;
	for (let attempt = 0; attempt < 15 && !gone; attempt += 1) {
		// oxlint-disable-next-line no-await-in-loop -- Lookout ingests the cancel a moment after the server accepts it
		await sleep(2_000);
		// oxlint-disable-next-line no-await-in-loop -- see above
		const after: ActiveSandbox[] = await fresh.listActive();
		gone = !after.some((active: ActiveSandbox) => active.id === sandboxId);
	}
	check(gone, `cancelled in queue "${queue}" by a provider that had to look it up`);
}
console.log(failures === 0 ? 'all checks passed' : `${String(failures)} check(s) FAILED`);
