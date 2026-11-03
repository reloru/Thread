import { test } from "node:test";
import assert from "node:assert/strict";
import { END, RETAIN_MS, ReplyLog, pieces, splitEvents } from "../src/replylog.js";

test("pieces never split a surrogate pair", () => {
	const text = "ab😀cd😀";
	for (const size of [1, 2, 3, 4]) {
		const parts = pieces(text, size);
		assert.equal(parts.join(""), text);
		assert.ok(parts.every((p) => p.length && !/[\uD800-\uDBFF]$/.test(p) && !/^[\uDC00-\uDFFF]/.test(p)), `size ${size}`);
	}
});

function memoryStore() {
	const s = { meta: undefined, rows: [], alarm: null, cleared: 0 };
	return {
		s,
		getMeta: async () => s.meta,
		setMeta: async (m) => void (s.meta = structuredClone(m)),
		append: async (text) => void s.rows.push(text),
		readAll: async () => s.rows.join(""),
		clear: async () => {
			s.meta = undefined;
			s.rows = [];
			s.alarm = null;
			s.cleared++;
		},
		setAlarm: async (t) => void (s.alarm = t),
	};
}

// A model stream the test feeds by hand.
function manualStream() {
	let ctl;
	const enc = new TextEncoder();
	const state = { cancelled: false };
	const stream = new ReadableStream({
		start(c) {
			ctl = c;
		},
		cancel() {
			state.cancelled = true;
		},
	});
	return {
		stream,
		state,
		send: (data) => ctl.enqueue(enc.encode(`data: ${data}\n\n`)),
		raw: (text) => ctl.enqueue(enc.encode(text)),
		end: () => ctl.close(),
	};
}

async function readAll(stream) {
	return splitEvents(await new Response(stream).text()).events;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test("splitEvents keeps data payloads, drops comments and returns the unfinished rest", () => {
	assert.deepEqual(splitEvents('data: {"a":1}\n\n: ping\n\ndata: [DONE]\n\ndata: {"b"'), { events: ['{"a":1}', "[DONE]"], rest: 'data: {"b"' });
});

test("a reply runs without anyone following it, and a late follower gets every event in order", async () => {
	const store = memoryStore();
	const log = new ReplyLog(store, { flushMs: 1 });
	const model = manualStream();
	assert.equal(await log.start(123, async () => model.stream), true);
	model.send('{"n":1}');
	model.raw('data: {"n":');
	await tick();
	model.raw("2}\n\n");
	model.send("[DONE]");
	model.end();
	await log.pumping;
	assert.deepEqual(await readAll(await log.follow(0)), ['{"n":1}', '{"n":2}', "[DONE]", END]);
	assert.deepEqual(await readAll(await log.follow(2)), ["[DONE]", END]);
	assert.equal(store.s.meta.status, "done");
	assert.equal(store.s.meta.started, 123);
	assert.equal(store.s.alarm, store.s.meta.ended + RETAIN_MS);
});

test("a follower that joins mid-reply gets the earlier events, then the live ones, then the end", async () => {
	const log = new ReplyLog(memoryStore(), { flushMs: 1 });
	const model = manualStream();
	await log.start(1, async () => model.stream);
	model.send('{"n":1}');
	await tick();
	const following = readAll(await log.follow(0));
	model.send('{"n":2}');
	model.end();
	assert.deepEqual(await following, ['{"n":1}', '{"n":2}', END]);
});

test("starting twice keeps the first reply", async () => {
	const log = new ReplyLog(memoryStore());
	const model = manualStream();
	let calls = 0;
	const gen = async () => (calls++, model.stream);
	assert.equal(await log.start(1, gen), true);
	assert.equal(await log.start(2, gen), false);
	model.end();
	await log.pumping;
	assert.equal(calls, 1);
	assert.equal(log.meta.started, 1);
});

test("cancel stops the model and ends the reply", async () => {
	const store = memoryStore();
	const log = new ReplyLog(store);
	const model = manualStream();
	let signal;
	await log.start(1, async (s) => ((signal = s), model.stream));
	model.send('{"n":1}');
	await tick();
	assert.equal(await log.cancel(), true);
	await log.pumping;
	assert.ok(model.state.cancelled);
	assert.ok(signal.aborted);
	assert.equal(store.s.meta.status, "cancelled");
	assert.deepEqual(await readAll(await log.follow(0)), ['{"n":1}', END]);
	assert.equal(await log.cancel(), false);
});

test("a model failure becomes an error event", async () => {
	const log = new ReplyLog(memoryStore());
	await log.start(1, async () => {
		throw new Error("3040: capacity");
	});
	await log.pumping;
	const events = await readAll(await log.follow(0));
	assert.match(JSON.parse(events[0]).error, /3040: capacity/);
	assert.equal(events[1], END);
});

test("a new instance reads the reply back from storage, in pieces small enough for a row", async () => {
	const store = memoryStore();
	const log = new ReplyLog(store, { flushMs: 1 });
	const model = manualStream();
	await log.start(1, async () => model.stream);
	const big = JSON.stringify({ thread: { type: "tool_result", result: { images: ["x".repeat(1200000)] } } });
	model.send(big);
	model.send("[DONE]");
	model.end();
	await log.pumping;
	assert.ok(store.s.rows.every((r) => r.length <= 500000));
	assert.ok(store.s.rows.length >= 3);
	const again = new ReplyLog(store);
	assert.deepEqual(await readAll(await again.follow(0)), [big, "[DONE]", END]);
});

test("a reply left running by an instance that died is reported as failed", async () => {
	const store = memoryStore();
	store.s.meta = { status: "running", started: 1 };
	store.s.rows = ['data: {"n":1}\n\n'];
	const log = new ReplyLog(store, { flushMs: 1 });
	const events = await readAll(await log.follow(0));
	assert.equal(events[0], '{"n":1}');
	assert.match(JSON.parse(events[1]).error, /stopped on the server/);
	assert.equal(events[2], END);
	assert.equal(store.s.meta.status, "failed");
});

test("follow is null for an unknown reply; expiry clears a finished one and waits for a running one", async () => {
	const store = memoryStore();
	const log = new ReplyLog(store);
	assert.equal(await log.follow(0), null);
	const model = manualStream();
	await log.start(1, async () => model.stream);
	await log.expire();
	assert.equal(store.s.cleared, 0);
	model.end();
	await log.pumping;
	await log.expire();
	assert.equal(store.s.cleared, 1);
	assert.equal(await log.follow(0), null);
});

test("live followers get pings while the reply is quiet", async () => {
	const log = new ReplyLog(memoryStore(), { pingMs: 10 });
	const model = manualStream();
	await log.start(1, async () => model.stream);
	const reader = (await log.follow(0)).getReader();
	const { value } = await reader.read();
	assert.equal(new TextDecoder().decode(value), ": ping\n\n");
	await reader.cancel();
	assert.equal(log.listeners.size, 0);
	model.end();
	await log.pumping;
});
