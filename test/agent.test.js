import { test } from "node:test";
import assert from "node:assert/strict";
import {
	BUDGET_SHARE,
	IMAGE_TOKENS,
	MAX_ARGS,
	MAX_ROUNDS,
	PAGE_REMOVED,
	agentStream,
	budgetFor,
	estimateTokens,
	longDate,
	relay,
	sanitizeTools,
	toolDefs,
	toolNote,
} from "../src/agent.js";
import { MODELS } from "../src/models.js";

const sse = (events) =>
	new ReadableStream({
		start(c) {
			for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`));
			c.close();
		},
	});
const delta = (d, finish = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
const toolCall = (name, args, id = "call_1") => [
	delta({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] }),
	delta({ tool_calls: [{ index: 0, function: { arguments: args } }] }),
	delta({}, "tool_calls"),
	"[DONE]",
];
const answer = (text) => [delta({ content: text }), delta({}, "stop"), "[DONE]"];

async function collect(stream) {
	const text = await new Response(stream).text();
	return text
		.split("\n\n")
		.filter(Boolean)
		.map((l) => l.replace(/^data: /, ""))
		.map((d) => (d === "[DONE]" ? d : JSON.parse(d)));
}

function makeEnv(rounds, { sandbox, browser } = {}) {
	const requests = [];
	return {
		requests,
		env: {
			AI: {
				run: async (model, input) => {
					requests.push(structuredClone(input));
					return sse(rounds.shift() || answer("done"));
				},
			},
			SANDBOX: {
				getByName: (name) => ({
					run: async (code) => (sandbox ? sandbox(code, name) : { stdout: "42\n", stderr: "", error: null, images: ["iVBOR"] }),
				}),
			},
			BROWSER: { quickAction: browser || (async () => "# Example\nHello") },
		},
	};
}

const CHAT = "123e4567-e89b-12d3-a456-426614174000";
const base = { input: { messages: [{ role: "user", content: "hi" }], stream: true }, model: "m", chatId: CHAT };

test("sanitizeTools accepts known names and rejects others", () => {
	assert.deepEqual(sanitizeTools(undefined), []);
	assert.deepEqual(sanitizeTools(["python", "web", "python"]), ["python", "web"]);
	assert.throws(() => sanitizeTools(["shell"]));
	assert.throws(() => sanitizeTools("python"));
});

test("relay forwards content, hides tool-call fragments, and assembles calls", async () => {
	const sent = [];
	const { calls, content } = await relay(sse([delta({ content: "Let me run it. " }), ...toolCall("run_python", '{"code":"1"}')]), (d) => sent.push(d));
	assert.equal(content, "Let me run it. ");
	assert.deepEqual(calls, [{ id: "call_1", name: "run_python", args: '{"code":"1"}' }]);
	assert.equal(sent.length, 2);
	assert.match(sent[0], /Let me run it/);
	assert.deepEqual(sent[1], { thread: { type: "tool_prepare", id: "call_1", name: "run_python" } });
});

// A model stream that keeps writing one call's arguments until it is cancelled.
function endless(name, id) {
	let n = 0;
	const state = { cancelled: false, chunks: 0 };
	const stream = new ReadableStream({
		pull(c) {
			const evt = n++ === 0
				? delta({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: '{"url":"https://e.com/' } }] })
				: delta({ tool_calls: [{ index: 0, function: { arguments: "a".repeat(100) } }] });
			state.chunks++;
			c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(evt)}\n\n`));
		},
		cancel() {
			state.cancelled = true;
		},
	});
	return { stream, state };
}

test("a call that runs past its argument limit cancels the model and ends the reply with an error", async () => {
	const { stream, state } = endless("fetch_url", "c9");
	let calls = 0;
	const env = { AI: { run: async () => (calls++, stream) }, BROWSER: { quickAction: async () => assert.fail("must not run") } };
	const events = await collect(agentStream({ env, tools: ["web"], ...base }));
	assert.ok(state.cancelled);
	assert.ok(state.chunks * 100 < MAX_ARGS.fetch_url + 400, "stopped soon after the limit");
	assert.equal(calls, 1, "the failure is not handed back to the model");
	assert.deepEqual(events[0], { thread: { type: "tool_prepare", id: "c9", name: "fetch_url" } });
	assert.equal(events[1].thread.type, "tool_result");
	assert.equal(events[1].thread.id, "c9");
	assert.equal(events[1].thread.result.error, "Not run: it grew past 4,000 characters.");
	assert.match(events[2].error, /past 4,000 characters/);
	assert.equal(events.length, 3);
});

test("a call cut off by the length limit is not run", async () => {
	const cut = [
		delta({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "run_python", arguments: '{"code":"pri' } }] }),
		delta({}, "length"),
		"[DONE]",
	];
	const { env, requests } = makeEnv([cut], { sandbox: async () => assert.fail("must not run") });
	const events = await collect(agentStream({ env, tools: ["python"], ...base }));
	assert.equal(requests.length, 1);
	assert.ok(events.some((e) => e.choices?.[0]?.finish_reason === "length"), "the app still learns the reply hit the limit");
	assert.equal(events.find((e) => e.thread?.type === "tool_result").thread.id, "c1");
	assert.match(events.at(-1).error, /length limit while the model was writing a tool call/);
	assert.ok(!events.some((e) => e.thread?.type === "tool_start"));
});

test("tool_prepare and tool_start share an id, including a generated one", async () => {
	const noId = [
		delta({ tool_calls: [{ index: 0, type: "function", function: { name: "run_python", arguments: '{"code":' } }] }),
		delta({ tool_calls: [{ index: 0, function: { arguments: '"1"}' } }] }, "stop"),
		"[DONE]",
	];
	const { env } = makeEnv([noId, answer("ok")]);
	const events = await collect(agentStream({ env, tools: ["python"], ...base }));
	const prepare = events.find((e) => e.thread?.type === "tool_prepare");
	const start = events.find((e) => e.thread?.type === "tool_start");
	// Mistral accepts only 9 letters and digits as a call id.
	assert.equal(prepare.thread.id, "call00000");
	assert.match(prepare.thread.id, /^[A-Za-z0-9]{9}$/);
	assert.equal(start.thread.id, prepare.thread.id);
	// The chunk that carried the last fragment and the finish reaches the app as the finish alone.
	const finish = events.find((e) => e.choices?.[0]?.finish_reason === "stop");
	assert.deepEqual(finish.choices[0].delta, {});
});

test("python tool round trip", async () => {
	const { env, requests } = makeEnv([toolCall("run_python", '{"code":"print(6*7)"}'), answer("It is 42.")]);
	const events = await collect(agentStream({ env, tools: ["python"], ...base }));
	const start = events.find((e) => e.thread?.type === "tool_start");
	const result = events.find((e) => e.thread?.type === "tool_result");
	assert.deepEqual(start.thread.args, { code: "print(6*7)" });
	assert.equal(result.thread.result.stdout, "42\n");
	assert.deepEqual(result.thread.result.images, ["iVBOR"]);
	assert.equal(events.at(-1), "[DONE]");
	assert.ok(events.some((e) => e.choices?.[0]?.delta?.content === "It is 42."));
	assert.equal(requests[0].tools[0].function.name, "run_python");
	const second = requests[1].messages;
	assert.equal(second.at(-2).role, "assistant");
	assert.equal(second.at(-2).tool_calls[0].function.name, "run_python");
	assert.equal(second.at(-1).role, "tool");
	assert.match(second.at(-1).content, /stdout:\n42/);
	assert.match(second.at(-1).content, /1 figure\(s\) were displayed/);
});

test("web tool returns markdown and rejects non-http URLs", async () => {
	const { env, requests } = makeEnv([toolCall("fetch_url", '{"url":"https://example.com"}'), toolCall("fetch_url", '{"url":"file:///etc/passwd"}', "c2"), answer("ok")]);
	const events = await collect(agentStream({ env, tools: ["web"], ...base }));
	const results = events.filter((e) => e.thread?.type === "tool_result").map((e) => e.thread.result);
	assert.equal(results[0].url, "https://example.com/");
	assert.match(results[1].error, /http\(s\) URL/);
	assert.match(requests[1].messages.at(-1).content, /# Example/);
});

test("browser binding Response and {result} shapes are both handled", async () => {
	for (const out of [new Response(JSON.stringify({ success: true, result: "page text" }), { headers: { "content-type": "application/json" } }), { result: "page text" }]) {
		const { env, requests } = makeEnv([toolCall("fetch_url", '{"url":"https://e.com"}'), answer("ok")], { browser: async () => out });
		await collect(agentStream({ env, tools: ["web"], ...base }));
		assert.equal(requests[1].messages.at(-1).content, "page text");
	}
});

test("disabled tools, bad JSON and tool errors are reported to the model", async () => {
	const { env, requests } = makeEnv(
		[toolCall("fetch_url", '{"url":"https://e.com"}'), toolCall("run_python", "{oops", "c2"), toolCall("run_python", '{"code":"x"}', "c3"), answer("ok")],
		{ sandbox: async () => { throw new Error("container down"); } },
	);
	await collect(agentStream({ env, tools: ["python"], ...base }));
	const toolMsgs = requests.at(-1).messages.filter((m) => m.role === "tool").map((m) => m.content);
	assert.deepEqual(toolMsgs, ["Tool fetch_url is not available. The tools you can call are: run_python.", "Tool arguments were not valid JSON.", "Tool failed: container down"]);
});

test("the loop stops after MAX_ROUNDS with a note, keeping tools defined", async () => {
	const rounds = Array.from({ length: MAX_ROUNDS + 2 }, (_, i) => toolCall("run_python", '{"code":"1"}', `c${i}`));
	const { env, requests } = makeEnv(rounds);
	const events = await collect(agentStream({ env, tools: ["python"], ...base }));
	assert.equal(requests.length, MAX_ROUNDS);
	assert.ok(requests.every((r) => r.tools.length === 1));
	assert.equal(events.filter((e) => e.thread?.type === "tool_result").length, MAX_ROUNDS - 1);
	assert.match(events.at(-2).choices[0].delta.content, /Stopped after 6 rounds/);
	assert.equal(events.at(-1), "[DONE]");
});

test("the sandbox is addressed by chat id", async () => {
	let used;
	const { env } = makeEnv([toolCall("run_python", '{"code":"1"}'), answer("ok")], { sandbox: async (code, name) => ((used = name), { stdout: "", images: [] }) });
	await collect(agentStream({ env, tools: ["python"], ...base }));
	assert.equal(used, CHAT);
});

test("model failures become an error event", async () => {
	const env = { AI: { run: async () => { throw new Error("3040: capacity"); } } };
	const events = await collect(agentStream({ env, tools: ["web"], ...base }));
	assert.match(events[0].error, /3040/);
});

test("an abort stops the tool loop: the model stream is cancelled and no tool runs", async () => {
	const { stream, state } = endless("run_python", "c1");
	const controller = new AbortController();
	let runs = 0;
	const env = { AI: { run: async () => (runs++, stream) }, SANDBOX: { getByName: () => ({ run: async () => assert.fail("must not run") }) } };
	const out = agentStream({ env, tools: ["python"], ...base, signal: controller.signal });
	setTimeout(() => controller.abort(), 5);
	const events = await collect(out);
	assert.ok(state.cancelled);
	assert.equal(runs, 1);
	assert.ok(!events.some((e) => e === "[DONE]" || e.thread?.type === "tool_start"));
});

// Several calls in one round, as parallel tool calls.
const toolCalls = (list) => [
	...list.map(([name, args, id], index) => delta({ tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }] })),
	delta({}, "tool_calls"),
	"[DONE]",
];
const spec = (id) => MODELS.find((m) => m.id === id);
const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
const LLAMA = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const OSS = "@cf/openai/gpt-oss-120b";

test("the Web chip gives web_search and fetch_url; show_page is offered to vision models only", () => {
	const names = (defs) => defs.map((d) => d.function.name);
	assert.deepEqual(names(toolDefs(["web"])), ["web_search", "fetch_url"]);
	assert.deepEqual(names(toolDefs(["python", "web"])), ["web_search", "fetch_url", "run_python"]);
	assert.deepEqual(names(toolDefs(["python"])), ["run_python"]);
	const fetch = (vision) => toolDefs(["web"], { vision }).find((d) => d.function.name === "fetch_url").function;
	assert.ok(fetch(true).parameters.properties.show_page);
	assert.equal(fetch(false).parameters.properties.show_page, undefined);
	assert.doesNotMatch(fetch(false).description, /show_page|There is no search/);
	const python = (tools) => toolDefs(tools).find((d) => d.function.name === "run_python").function.description;
	assert.match(python(["python", "web"]), /no internet access; get information from the web with web_search and fetch_url\.$/);
	assert.match(python(["python"]), /The sandbox itself has no internet access\.$/);
});

test("the tool note lists the enabled tools, what they reach, and the device's date", () => {
	const both = toolNote(["python", "web"], { date: "2026-11-10" });
	assert.match(both, /^You have tools: web_search, fetch_url and run_python\. They give you live internet access and code execution/);
	assert.match(both, /search with web_search unless you already know the exact URL, then read the most relevant results with fetch_url/);
	assert.match(both, /Today's date is Tuesday, November 10, 2026\.$/);
	assert.doesNotMatch(both, /show_page/);
	assert.match(toolNote(["web"], { vision: true, date: "2026-02-28" }), /show_page\). Today's date is Saturday, February 28, 2026\.$/);
	const code = toolNote(["python"], { date: "2026-11-10" });
	assert.match(code, /^You have tools: run_python\. run_python executes code in a sandbox/);
	assert.match(code, /it has no internet access\./);
	assert.doesNotMatch(code, /live internet|web_search/);
	assert.equal(toolNote([], { date: "2026-11-10" }), "");
	assert.match(toolNote(["web"], {}), /Today's date is \w+day, \w+ \d{1,2}, \d{4}\.$/, "the UTC date when the app sends none");
	assert.equal(longDate("2026-02-30"), null);
	assert.equal(longDate("2026-1-5"), null);
	assert.equal(longDate("2024-02-29"), "Thursday, February 29, 2024");
});

test("argument limits: 1,024 characters for a search; unknown names get the smallest limit", async () => {
	assert.equal(MAX_ARGS.web_search, 1024);
	const sent = [];
	const long = [delta({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "mystery", arguments: `{"q":"${"a".repeat(1100)}` } }] }), delta({}, "tool_calls"), "[DONE]"];
	const { failed } = await relay(sse(long), (d) => sent.push(d));
	assert.match(failed.error, /past 1,024 characters/);
});

test("a vision model's screenshots follow all of the round's tool results, in one user message", async () => {
	const shot = { result: { markdown: "# Page", screenshot: "/9j/AAAA" } };
	const { env, requests } = makeEnv(
		[toolCalls([["fetch_url", '{"url":"https://a.com","show_page":true}', "c1"], ["fetch_url", '{"url":"https://b.com","show_page":true}', "c2"]]), answer("ok")],
		{ browser: async (action) => (assert.equal(action, "snapshot"), shot) },
	);
	const events = await collect(agentStream({ env, tools: ["web"], ...base, model: GEMMA }));
	assert.ok(requests[0].tools.find((t) => t.function.name === "fetch_url").function.parameters.properties.show_page);
	const sent = requests[1].messages.slice(-4);
	assert.deepEqual(sent.map((m) => m.role), ["assistant", "tool", "tool", "user"]);
	assert.match(sent[1].content, /follows in a separate message/);
	assert.equal(sent[3].content[0].text, "Screenshots from fetch_url (show_page), sent by the tool, not typed by the user: https://a.com/, https://b.com/");
	assert.deepEqual(sent[3].content.slice(1), [
		{ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/AAAA" } },
		{ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/AAAA" } },
	]);
	const results = events.filter((e) => e.thread?.type === "tool_result");
	assert.equal(results[0].thread.result.screenshot, "/9j/AAAA");
});

test("web_search runs from the Web chip and its results go back to the model", async () => {
	const page = { success: true, result: [{ selector: "a.result__a", results: [{ text: "Example", top: 10, attributes: [{ name: "href", value: "https://example.com/" }] }] }], meta: { status: 200 } };
	const { env, requests } = makeEnv([toolCall("web_search", '{"query":"example"}'), answer("ok")], { browser: async () => page });
	const events = await collect(agentStream({ env, tools: ["web"], ...base }));
	assert.match(requests[1].messages.at(-1).content, /^Search results for “example” \(DuckDuckGo\):\n\n1\. Example\n {3}https:\/\/example\.com\//);
	assert.deepEqual(events.find((e) => e.thread?.type === "tool_result").thread.result, { query: "example", engine: "DuckDuckGo", results: [{ title: "Example", url: "https://example.com/" }] });
});

test("budget: tokens are characters / 3.5 plus a flat figure per image, whatever the image's size", () => {
	const big = `data:image/jpeg;base64,${"A".repeat(1_000_000)}`;
	const messages = [{ role: "user", content: [{ type: "text", text: "x".repeat(350) }, { type: "image_url", image_url: { url: big } }] }];
	assert.equal(estimateTokens(messages), Math.ceil((2 + 350) / 3.5) + IMAGE_TOKENS + 8);
	assert.deepEqual(budgetFor(spec(LLAMA), { max_completion_tokens: 4096 }), { soft: Math.floor((24000 - 4096) * BUDGET_SHARE), hard: 24000 - 4096 });
	assert.equal(budgetFor(spec(LLAMA), { max_completion_tokens: 24000 }), null, "no budget when the output cap leaves no room");
	assert.equal(budgetFor(undefined, {}), null);
});

// Three page reads per round until the round limit, with pages far longer than the cap.
async function readMany(model, pageLength) {
	const rounds = Array.from({ length: MAX_ROUNDS - 1 }, (_, r) =>
		toolCalls([0, 1, 2].map((i) => ["fetch_url", JSON.stringify({ url: `https://e.com/${r}-${i}` }), `r${r}c${i}`])),
	);
	const { env, requests } = makeEnv([...rounds, answer("done")], { browser: async (action, body) => `# ${body.url}\n${"w".repeat(pageLength)}` });
	const input = { ...base.input, max_completion_tokens: spec(model).defaultMaxTokens ?? 16384 };
	const events = await collect(agentStream({ env, tools: ["web"], ...base, model, input }));
	return { requests, events, budget: budgetFor(spec(model), input) };
}

for (const [model, cap] of [[LLAMA, 6000], [OSS, 20000]]) {
	test(`budget on ${spec(model).name}: pages are cut to ${cap.toLocaleString("en-US")} characters, the oldest are removed first, no request passes the budget`, async () => {
		const { requests, events, budget } = await readMany(model, 50000);
		assert.equal(requests.length, MAX_ROUNDS);
		assert.equal(events.at(-1), "[DONE]");
		const pages = (r) => r.messages.filter((m) => m.role === "tool");
		// Each page is "# <url>\n" (20 characters) and 50,000 more.
		assert.ok(pages(requests[1]).every((m) => m.content.startsWith("# https://e.com/0-") && m.content.endsWith(`\n… [truncated ${50020 - cap} characters]`)));
		for (const r of requests) assert.ok(estimateTokens(r.messages, r.tools) <= budget.soft, "within the budget");
		const last = pages(requests.at(-1));
		assert.equal(last.length, 3 * (MAX_ROUNDS - 1));
		const removed = last.map((m) => m.content === PAGE_REMOVED);
		const firstKept = removed.indexOf(false);
		assert.ok(firstKept > 0, "some pages were removed");
		assert.ok(removed.slice(firstKept).every((x) => !x), "only the oldest ones");
		assert.ok(removed.slice(-3).every((x) => !x), "the latest round is intact");
		assert.equal(requests.at(-1).messages[0].content, "hi", "the chat itself is untouched");
	});
}

test("budget: a chat that no longer fits with its tool results ends with an error instead of a failed model call", async () => {
	const { env, requests } = makeEnv([toolCall("fetch_url", '{"url":"https://e.com"}'), answer("never")], { browser: async () => "x".repeat(50000) });
	const input = { messages: [{ role: "user", content: "y".repeat(75000) }], stream: true, max_completion_tokens: 4096 };
	const events = await collect(agentStream({ env, tools: ["web"], ...base, model: LLAMA, input }));
	assert.equal(requests.length, 1, "the first round is sent as before; the second is not");
	assert.match(events.at(-1).error, /no longer fit in Llama 3\.3 70B's context window/);
});
