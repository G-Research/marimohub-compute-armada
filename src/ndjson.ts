/**
 * Reader for the `application/ndjson-stream` responses grpc-gateway produces for
 * a streaming RPC: one JSON object per line, and a line is only complete at its
 * newline, which a chunk boundary does not respect.
 */

/** Yields one parsed value per line, ignoring blank lines. */
export async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator {
	const decoder: TextDecoder = new TextDecoder();
	const reader: ReadableStreamDefaultReader = body.getReader();
	let buffered = '';

	try {
		for (;;) {
			// Sequential by nature: the next chunk does not exist until this one is read.
			// oxlint-disable-next-line no-await-in-loop
			const { done, value } = await reader.read();
			if (done) break;

			buffered += decoder.decode(value, { stream: true });
			let newline: number = buffered.indexOf('\n');
			while (newline !== -1) {
				const line: string = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				if (line !== '') yield JSON.parse(line);
				newline = buffered.indexOf('\n');
			}
		}

		const last: string = buffered.trim();
		if (last !== '') yield JSON.parse(last);
	} finally {
		// A consumer that stops early, on the event it wanted or an abort, leaves
		// the rest unread. Cancelling releases the connection; releasing the lock
		// alone would leave a watch stream open for as long as the server keeps
		// it, one socket per sandbox start in a long-lived process.
		await reader.cancel().catch((): undefined => undefined);
	}
}
