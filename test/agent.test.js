import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ROUNDS, agentStream, relay, sanitizeTools } from "../src/agent.js";

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
	assert.equal(sent.length, 1);
	assert.match(sent[0], /Let me run it/);
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
	assert.deepEqual(toolMsgs, ["Tool fetch_url is not available.", "Tool arguments were not valid JSON.", "Tool failed: container down"]);
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
