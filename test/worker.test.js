import { test } from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import worker, { sanitizeMessages } from "../src/worker.js";
import { MODELS } from "../src/models.js";

// Workers-only Web Crypto extension.
crypto.subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

const PASS = "test-pass";
const VISION = MODELS.find((m) => m.vision).id;
const TEXT_ONLY = MODELS.find((m) => !m.vision).id;
const IMG = "data:image/jpeg;base64,/9j/AAAA";

function makeEnv(overrides = {}) {
	const calls = [];
	return {
		calls,
		env: {
			PASSCODE: PASS,
			AI_GATEWAY_ID: "default",
			ASSETS: { fetch: () => new Response("asset") },
			AI: {
				run: async (model, input, options) => {
					calls.push({ model, input, options });
					return new ReadableStream({
						start(c) {
							c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'));
							c.close();
						},
					});
				},
			},
			...overrides,
		},
	};
}

const req = (path, { method = "GET", pass = PASS, body } = {}) =>
	new Request(`https://thread.test${path}`, {
		method,
		headers: { ...(pass ? { authorization: `Bearer ${pass}` } : {}), "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

test("non-API paths go to static assets", async () => {
	const { env } = makeEnv();
	const res = await worker.fetch(req("/", { pass: null }), env);
	assert.equal(await res.text(), "asset");
});

test("rejects missing or wrong passcode", async () => {
	const { env } = makeEnv();
	assert.equal((await worker.fetch(req("/api/models", { pass: null }), env)).status, 401);
	assert.equal((await worker.fetch(req("/api/models", { pass: "nope" }), env)).status, 401);
	assert.equal((await worker.fetch(req("/api/auth", { method: "POST" }), env)).status, 204);
});

test("fails closed when PASSCODE is unset", async () => {
	const { env } = makeEnv({ PASSCODE: undefined });
	assert.equal((await worker.fetch(req("/api/models", { pass: "" }), env)).status, 503);
});

test("lists curated models", async () => {
	const { env } = makeEnv();
	const data = await (await worker.fetch(req("/api/models"), env)).json();
	assert.equal(data.models.length, MODELS.length);
	assert.equal(data.default, MODELS[0].id);
});

test("streams chat through the gateway with an output cap", async () => {
	const { env, calls } = makeEnv();
	const res = await worker.fetch(
		req("/api/chat", { method: "POST", body: { model: VISION, messages: [{ role: "user", content: "hello" }] } }),
		env,
	);
	assert.equal(res.status, 200);
	assert.match(res.headers.get("content-type"), /text\/event-stream/);
	assert.match(await res.text(), /"content":"hi"/);
	assert.equal(calls[0].model, VISION);
	assert.equal(calls[0].input.stream, true);
	assert.equal(calls[0].input.max_completion_tokens, 16384);
	assert.deepEqual(calls[0].options, { gateway: { id: "default" } });
});

test("sends validated params and instructions as a system message", async () => {
	const { env, calls } = makeEnv();
	const res = await worker.fetch(
		req("/api/chat", {
			method: "POST",
			body: {
				model: VISION,
				messages: [{ role: "user", content: "hi" }],
				params: { temperature: 0.2, max_completion_tokens: 100 },
				instructions: "  Be brief.  ",
			},
		}),
		env,
	);
	assert.equal(res.status, 200);
	const input = calls[0].input;
	assert.deepEqual(input.messages[0], { role: "system", content: "Be brief." });
	assert.equal(input.temperature, 0.2);
	assert.equal(input.max_completion_tokens, 100);
	assert.equal(input.stream, true);
});

test("keeps max_tokens from params without adding the default cap", async () => {
	const { env, calls } = makeEnv();
	await worker.fetch(
		req("/api/chat", { method: "POST", body: { model: VISION, messages: [{ role: "user", content: "x" }], params: { max_tokens: 50 } } }),
		env,
	);
	assert.equal(calls[0].input.max_tokens, 50);
	assert.equal(calls[0].input.max_completion_tokens, undefined);
});

test("rejects invalid params and instructions with 400", async () => {
	const { env, calls } = makeEnv();
	const bad = [
		{ params: { temperature: 3 } },
		{ params: { stream: false } },
		{ params: "x" },
		{ instructions: 5 },
		{ instructions: "x".repeat(20001) },
	];
	for (const extra of bad) {
		const res = await worker.fetch(
			req("/api/chat", { method: "POST", body: { model: VISION, messages: [{ role: "user", content: "x" }], ...extra } }),
			env,
		);
		assert.equal(res.status, 400, JSON.stringify(extra).slice(0, 80));
		assert.ok((await res.json()).error);
	}
	assert.equal(calls.length, 0);
});

test("empty instructions add no system message", async () => {
	const { env, calls } = makeEnv();
	await worker.fetch(
		req("/api/chat", { method: "POST", body: { model: VISION, messages: [{ role: "user", content: "x" }], instructions: "   " } }),
		env,
	);
	assert.equal(calls[0].input.messages[0].role, "user");
});

test("omits gateway when AI_GATEWAY_ID is empty", async () => {
	const { env, calls } = makeEnv({ AI_GATEWAY_ID: "" });
	await worker.fetch(req("/api/chat", { method: "POST", body: { model: VISION, messages: [{ role: "user", content: "x" }] } }), env);
	assert.equal(calls[0].options, undefined);
});

test("rejects unknown models and bad bodies", async () => {
	const { env, calls } = makeEnv();
	const bad = [
		{ model: "@cf/meta/llama-3.1-8b-instruct-fp8", messages: [{ role: "user", content: "x" }] },
		{ model: VISION, messages: [] },
		{ model: VISION, messages: [{ role: "system", content: "x" }] },
		{ model: VISION, messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }] },
		{ model: VISION, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://evil/x.png" } }] }] },
	];
	for (const body of bad) {
		const res = await worker.fetch(req("/api/chat", { method: "POST", body }), env);
		assert.equal(res.status, 400, JSON.stringify(body));
	}
	assert.equal(calls.length, 0);
});

test("reports model failures as 502", async () => {
	const { env } = makeEnv({
		AI: {
			run: async () => {
				throw new Error("5007: No such model");
			},
		},
	});
	const res = await worker.fetch(req("/api/chat", { method: "POST", body: { model: VISION, messages: [{ role: "user", content: "x" }] } }), env);
	assert.equal(res.status, 502);
	assert.match((await res.json()).error, /5007/);
});

test("keeps images for vision models", () => {
	const out = sanitizeMessages(
		[{ role: "user", content: [{ type: "text", text: "what?" }, { type: "image_url", image_url: { url: IMG } }] }],
		true,
	);
	assert.deepEqual(out[0].content[1], { type: "image_url", image_url: { url: IMG } });
});

test("replaces images with a note for text-only models", () => {
	const out = sanitizeMessages(
		[{ role: "user", content: [{ type: "text", text: "what?" }, { type: "image_url", image_url: { url: IMG } }] }],
		MODELS.find((m) => m.id === TEXT_ONLY).vision,
	);
	assert.equal(typeof out[0].content, "string");
	assert.match(out[0].content, /^what\?\n\n\[An image was attached/);
});

test("strips unknown message fields", () => {
	const out = sanitizeMessages([{ role: "user", content: "x", name: "n", tool_calls: [] }], true);
	assert.deepEqual(out, [{ role: "user", content: "x" }]);
});

test("keeps only the most recent 24 images instead of failing", () => {
	const turns = [];
	for (let i = 0; i < 30; i++) {
		turns.push({ role: "user", content: [{ type: "text", text: `t${i}` }, { type: "image_url", image_url: { url: IMG } }] });
		turns.push({ role: "assistant", content: "ok" });
	}
	turns.pop();
	const out = sanitizeMessages(turns, true);
	const parts = out.filter((m) => m.role === "user").flatMap((m) => m.content);
	assert.equal(parts.filter((p) => p.type === "image_url").length, 24);
	assert.equal(parts.filter((p) => /earlier image was omitted/.test(p.text || "")).length, 6);
	assert.equal(out[0].content[1].type, "text");
	assert.equal(out.at(-1).content[1].type, "image_url");
});

test("accepts percent-encoded and non-Latin-1 passcodes", async () => {
	const { env } = makeEnv({ PASSCODE: "pässwörd 50%" });
	const encoded = encodeURIComponent("pässwörd 50%");
	assert.equal((await worker.fetch(req("/api/auth", { method: "POST", pass: encoded }), env)).status, 204);
	assert.equal((await worker.fetch(req("/api/auth", { method: "POST", pass: "x%E0%A4%A" }), env)).status, 401);
	const ascii = makeEnv({ PASSCODE: "4b8j-fn5s-t774" });
	assert.equal((await worker.fetch(req("/api/auth", { method: "POST", pass: "4b8j-fn5s-t774" }), ascii.env)).status, 204);
});

test("enforces the body limit without a Content-Length header", async () => {
	const { env, calls } = makeEnv();
	const chunk = new Uint8Array(1024 * 1024).fill(32);
	let sent = 0;
	const body = new ReadableStream({
		pull(c) {
			if (sent++ >= 21) c.close();
			else c.enqueue(chunk);
		},
	});
	const request = new Request("https://thread.test/api/chat", {
		method: "POST",
		headers: { authorization: `Bearer ${PASS}` },
		body,
		duplex: "half",
	});
	assert.equal(request.headers.get("content-length"), null);
	const res = await worker.fetch(request, env);
	assert.equal(res.status, 413);
	assert.equal(calls.length, 0);
});

test("tools: validated, need a chat id for python, and exclude Advanced JSON tools", async () => {
	const { env } = makeEnv();
	const post = (extra) =>
		worker.fetch(req("/api/chat", { method: "POST", body: { model: VISION, messages: [{ role: "user", content: "x" }], ...extra } }), env);
	assert.equal((await post({ tools: ["shell"] })).status, 400);
	assert.equal((await post({ tools: ["python"] })).status, 400);
	assert.equal((await post({ tools: ["python"], chatId: "../x" })).status, 400);
	assert.equal((await post({ tools: ["web"], params: { tools: [] } })).status, 400);
	const ok = await post({ tools: ["web"] });
	assert.equal(ok.status, 200);
	assert.match(ok.headers.get("content-type"), /event-stream/);
});

test("convert: rejects unsupported types and oversize files, returns markdown", async () => {
	const calls = [];
	const { env } = makeEnv({
		AI: {
			run: async () => new ReadableStream(),
			toMarkdown: async (files) => {
				calls.push(files);
				return [{ name: files[0].name, format: "markdown", data: "# Doc\ntext" }];
			},
		},
	});
	const up = (name, bytes) =>
		worker.fetch(
			new Request("https://thread.test/api/convert", {
				method: "POST",
				headers: { authorization: `Bearer ${PASS}`, "x-filename": encodeURIComponent(name) },
				body: bytes,
			}),
			env,
		);
	assert.equal((await up("a.exe", new Uint8Array(4))).status, 415);
	assert.equal((await up("a.pdf", new Uint8Array(0))).status, 400);
	assert.equal((await up("big.pdf", new Uint8Array(10 * 1024 * 1024 + 1))).status, 413);
	const res = await up("réport.pdf", new Uint8Array([37, 80, 68, 70]));
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { name: "réport.pdf", text: "# Doc\ntext", truncated: false });
	assert.equal(calls[0][0].name, "réport.pdf");
});

test("default output cap comes from the model entry: Llama stays inside its 24k context", async () => {
	const { env, calls } = makeEnv();
	const post = (model) => worker.fetch(req("/api/chat", { method: "POST", body: { model, messages: [{ role: "user", content: "x" }] } }), env);
	await post("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
	await post("@cf/qwen/qwen3.8-27b");
	assert.equal(calls[0].input.max_completion_tokens, 4096);
	assert.equal(calls[1].input.max_completion_tokens, 16384);
});

test("images reach Qwen 3.8 and become a note for Llama 3.3", async () => {
	const { env, calls } = makeEnv();
	const body = (model) => ({
		model,
		messages: [{ role: "user", content: [{ type: "text", text: "what?" }, { type: "image_url", image_url: { url: IMG } }] }],
	});
	await worker.fetch(req("/api/chat", { method: "POST", body: body("@cf/qwen/qwen3.8-27b") }), env);
	await worker.fetch(req("/api/chat", { method: "POST", body: body("@cf/meta/llama-3.3-70b-instruct-fp8-fast") }), env);
	assert.deepEqual(calls[0].input.messages[0].content[1], { type: "image_url", image_url: { url: IMG } });
	assert.match(calls[1].input.messages[0].content, /^what\?\n\n\[An image was attached/);
});
