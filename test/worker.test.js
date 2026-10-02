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
