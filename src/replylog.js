// One reply's server-side life (the Reply Durable Object in reply.js is a thin wrapper around this). The model
// runs here, not in the request that asked for it, so the reply keeps going when the app is backgrounded or
// loses its connection; the app reconnects and asks for the events after the ones it has. Every SSE data event
// is kept, numbered from 0, in memory and in storage, until RETAIN_MS after the reply ends.

export const RETAIN_MS = 60 * 60 * 1000;
export const PING_MS = 15000;
const FLUSH_MS = 2000;
// Storage rows hold pieces of the event log's text; SQLite rows are capped at 2 MB.
const PIECE_CHARS = 500000;
// The last event of every reply, so the app can tell an ended reply from a dropped connection.
export const END = JSON.stringify({ thread: { type: "end" } });
const encoder = new TextEncoder();

/** Splits SSE text into data payloads. Returns { events, rest }, rest being an unfinished last line. */
export function splitEvents(text) {
	const events = [];
	let start = 0;
	let nl;
	while ((nl = text.indexOf("\n", start)) !== -1) {
		const line = text.slice(start, nl).replace(/\r$/, "");
		start = nl + 1;
		if (line.startsWith("data:")) events.push(line.slice(5).trim());
	}
	return { events, rest: text.slice(start) };
}

const frame = (data) => `data: ${data}\n\n`;

// Cuts text into row-sized pieces, never between the two halves of a surrogate pair (storage is UTF-8).
export function pieces(text, size = PIECE_CHARS) {
	const out = [];
	for (let i = 0; i < text.length; ) {
		let end = Math.min(text.length, i + size);
		const code = text.charCodeAt(end - 1);
		if (end < text.length && code >= 0xd800 && code <= 0xdbff) end = end - 1 > i ? end - 1 : end + 1;
		out.push(text.slice(i, end));
		i = end;
	}
	return out;
}

/**
 * store: { getMeta(), setMeta(meta), append(text), readAll(), clear(), setAlarm(time) }, all may be async.
 * meta: { status: "running" | "done" | "cancelled" | "failed", started, ended? }.
 */
export class ReplyLog {
	constructor(store, { now = Date.now, pingMs = PING_MS, flushMs = FLUSH_MS } = {}) {
		this.store = store;
		this.now = now;
		this.pingMs = pingMs;
		this.flushMs = flushMs;
		this.meta = null;
		this.events = null;
		this.listeners = new Set();
		this.running = false;
		this.controller = null;
		this.unsaved = "";
		this.flushTimer = 0;
		this.loading = null;
	}

	load() {
		this.loading ??= this.loadNow();
		return this.loading;
	}

	async loadNow() {
		this.meta = (await this.store.getMeta()) || null;
		this.events = this.meta ? splitEvents(await this.store.readAll()).events : [];
		// "running" in storage while nothing runs here means the instance restarted mid-reply.
		if (this.meta?.status === "running" && !this.running) {
			this.push(JSON.stringify({ error: "The reply stopped on the server before it finished. Regenerate to try again." }));
			this.push(END);
			await this.finish("failed");
		}
	}

	/** Starts the reply unless it already exists. generate(signal) resolves to an SSE byte stream. */
	async start(started, generate) {
		await this.load();
		if (this.meta) return false;
		this.meta = { status: "running", started };
		this.running = true;
		this.controller = new AbortController();
		await this.store.setMeta(this.meta);
		// Cleanup even if this instance dies before the reply ends.
		await this.store.setAlarm(this.now() + RETAIN_MS);
		this.pumping = this.pump(generate);
		return true;
	}

	async pump(generate) {
		const signal = this.controller.signal;
		const decoder = new TextDecoder();
		let rest = "";
		try {
			const stream = await generate(signal);
			const reader = stream.getReader();
			const stop = () => reader.cancel().catch(() => {});
			signal.addEventListener("abort", stop, { once: true });
			try {
				for (;;) {
					const { value, done } = await reader.read();
					const split = splitEvents(rest + (done ? decoder.decode() + "\n" : decoder.decode(value, { stream: true })));
					rest = split.rest;
					for (const data of split.events) this.push(data);
					if (done) break;
				}
			} finally {
				signal.removeEventListener("abort", stop);
			}
		} catch (err) {
			if (!signal.aborted) this.push(JSON.stringify({ error: `Model request failed: ${err?.message || String(err)}` }));
		}
		this.push(END);
		await this.finish(signal.aborted ? "cancelled" : "done");
	}

	push(data) {
		this.events.push(data);
		this.unsaved += frame(data);
		for (const listener of this.listeners) listener(data);
		if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush().catch(() => {}), this.flushMs);
	}

	// Flushes run one after another so rows stay in order.
	flush() {
		clearTimeout(this.flushTimer);
		this.flushTimer = 0;
		const text = this.unsaved;
		this.unsaved = "";
		this.flushing = (this.flushing || Promise.resolve()).then(async () => {
			for (const piece of pieces(text)) await this.store.append(piece);
		});
		return this.flushing;
	}

	async finish(status) {
		this.running = false;
		this.meta = { ...this.meta, status, ended: this.now() };
		await this.flush();
		await this.store.setMeta(this.meta);
		await this.store.setAlarm(this.now() + RETAIN_MS);
		for (const listener of this.listeners) listener(null);
	}

	/** Null when there is no such reply. Otherwise a stream of the events from index `after`, live until the end. */
	async follow(after = 0) {
		await this.load();
		if (!this.meta) return null;
		const log = this;
		let listener = null;
		let ping = 0;
		const close = () => {
			if (listener) log.listeners.delete(listener);
			clearInterval(ping);
		};
		const send = (c, text) => {
			try {
				c.enqueue(encoder.encode(text));
			} catch {
				close();
			}
		};
		return new ReadableStream({
			start(c) {
				for (const data of log.events.slice(Math.max(0, after))) c.enqueue(encoder.encode(frame(data)));
				if (!log.running) {
					c.close();
					return;
				}
				listener = (data) => {
					if (data !== null) return send(c, frame(data));
					close();
					try {
						c.close();
					} catch {}
				};
				log.listeners.add(listener);
				// Lets the app tell a quiet reply (a long tool run) from a dead connection.
				ping = setInterval(() => send(c, ": ping\n\n"), log.pingMs);
			},
			cancel: close,
		});
	}

	/** Stops the model. Returns false when there is no running reply here. */
	async cancel() {
		await this.load();
		if (!this.running) return false;
		this.controller.abort();
		return true;
	}

	/** Alarm: drops the reply once it has been over for RETAIN_MS. */
	async expire() {
		await this.load();
		if (this.running) {
			await this.store.setAlarm(this.now() + RETAIN_MS);
			return;
		}
		await this.store.clear();
		this.meta = null;
		this.events = [];
		this.loading = null;
	}
}
