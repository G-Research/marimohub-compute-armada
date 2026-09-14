import { describe, expect, it } from 'bun:test';
import { readNdjson } from '../src/ndjson.js';

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
	const encoder: TextEncoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller: ReadableStreamDefaultController<Uint8Array>) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

async function collect(chunks: readonly string[]): Promise<unknown[]> {
	const values: unknown[] = [];
	for await (const value of readNdjson(streamOf(chunks))) values.push(value);
	return values;
}

describe('ndjson', () => {
	it('reads one value per line', async () => {
		expect(await collect(['{"a":1}\n{"a":2}\n'])).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it('joins lines split across chunks, which is the whole point', async () => {
		expect(await collect(['{"a":', '1}\n{"a"', ':2}\n'])).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it('yields a trailing line that never got its newline', async () => {
		expect(await collect(['{"a":1}'])).toEqual([{ a: 1 }]);
	});

	it('ignores blank lines and an empty stream', async () => {
		expect(await collect(['\n\n{"a":1}\n\n'])).toEqual([{ a: 1 }]);
		expect(await collect([])).toEqual([]);
	});

	it('cancels the body when its consumer stops early, so the connection is released', async () => {
		// A watch stream: it never closes by itself, as a job-set event stream does not.
		let cancelled = false;
		const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
			start(controller: ReadableStreamDefaultController<Uint8Array>) {
				controller.enqueue(new TextEncoder().encode('{"n":1}\n{"n":2}\n'));
			},
			cancel(): void {
				cancelled = true;
			},
		});
		for await (const value of readNdjson(body)) {
			expect(value).toEqual({ n: 1 });
			break; // the event it wanted
		}
		expect(cancelled).toBe(true);
	});
});
