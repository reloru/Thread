import { test } from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import worker, { sanitizeMessages } from "../src/worker.js";
import { MODELS } from "../src/models.js";
import { attempt } from "../src/lockout.js";
import { dropSubscription, listSubscriptions, saveSubscription } from "../src/push.js";
import { ALERTS, LAST_TRY } from "../src/alerts.js";

// Workers-only Web Crypto extension.
crypto.subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

const PASS = "test-pass";
const VISION = MODELS.find((m) => m.vision).id;
const TEXT_ONLY = MODELS.find((m) => !m.vision).id;
const IMG = "data:image/jpeg;base64,/9j/AAAA";

// Durable Object storage subset used by the passcode guard.
function memoryStorage() {
	const map = new Map();
	return {
		get: async (k) => map.get(k),
		put: async (k, v) => void map.set(k, structuredClone(v)),
		delete: async (keys) => [keys].flat().forEach((k) => map.delete(k)),
		list: async ({ prefix = "" } = {}) => new Map([...map].filter(([k]) => k.startsWith(prefix))),
	};
}

function makeEnv(overrides = {}) {
	const calls = [];
	const storage = memoryStorage();
	const guard = {
		attempts: 0,
		attempt: (ip, ok) => (guard.attempts++, attempt(storage, ip, ok)),
		subscribe: (device, sub) => saveSubscription(storage, device, sub),
		unsubscribe: (device) => dropSubscription(storage, device),
		subscriptions: () => listSubscriptions(storage),
	};
	return {
		calls,
		guard,
		env: {
			PASSCODE: PASS,
			SESSION_SECRET: "test-session-secret",
			GUARD: { getByName: () => guard },
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

const req = (path, { method = "GET", pass = PASS, body, ip } = {}) =>
	new Request(`https://thread.test${path}`, {
		method,
		headers: {
			...(pass ? { authorization: `Bearer ${pass}` } : {}),
			...(ip ? { "cf-connecting-ip": ip } : {}),
			"content-type": "application/json",
		},
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
	const auth = await worker.fetch(req("/api/auth", { method: "POST" }), env);
	assert.equal(auth.status, 200);
	assert.match((await auth.json()).token, /^t1\.[\w-]{22}\.[\w-]{43}$/);
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
	assert.equal((await worker.fetch(req("/api/auth", { method: "POST", pass: encoded }), env)).status, 200);
	assert.equal((await worker.fetch(req("/api/auth", { method: "POST", pass: "x%E0%A4%A" }), env)).status, 401);
	const ascii = makeEnv({ PASSCODE: "4b8j-fn5s-t774" });
	assert.equal((await worker.fetch(req("/api/auth", { method: "POST", pass: "4b8j-fn5s-t774" }), ascii.env)).status, 200);
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

test("voice mode turns thinking off, keeps other settings and adds the spoken-style instruction", async () => {
	const { env, calls } = makeEnv();
	const post = (model, extra) =>
		worker.fetch(req("/api/chat", { method: "POST", body: { model, messages: [{ role: "user", content: "hi" }], ...extra } }), env);

	const qwen = "@cf/qwen/qwen3.8-27b";
	await post("@cf/nvidia/nemotron-3-120b-a12b", {
		voice: { lang: "en" },
		instructions: "Be brief.",
		params: { temperature: 0.3, chat_template_kwargs: { enable_thinking: true, low_effort: true } },
	});
	assert.deepEqual(calls[0].input.chat_template_kwargs, { enable_thinking: false, low_effort: true });
	assert.equal(calls[0].input.temperature, 0.3);
	const system = calls[0].input.messages[0];
	assert.equal(system.role, "system");
	assert.match(system.content, /^Be brief\.\n\nYou are talking with the user by voice/);
	assert.match(system.content, /Reply in English\.$/);

	await post("@cf/moonshotai/kimi-k2.6", { voice: { lang: "es" }, params: { reasoning_effort: "high" } });
	assert.equal(calls[1].input.reasoning_effort, "none");
	assert.match(calls[1].input.messages[0].content, /^You are talking with the user by voice/);
	assert.match(calls[1].input.messages[0].content, /Reply in Spanish\.$/);

	await post("@cf/zai-org/glm-5.3-flash", { voice: { lang: "en" }, params: { reasoning_effort: "high" } });
	assert.equal(calls[2].input.reasoning_effort, "high", "models that cannot disable reasoning keep the user's setting");

	await post(qwen, { params: { chat_template_kwargs: { enable_thinking: true } } });
	assert.deepEqual(calls[3].input.chat_template_kwargs, { enable_thinking: true });
	assert.equal(calls[3].input.messages[0].role, "user", "no instruction outside voice mode");
});

test("voice mode rejects a malformed voice field", async () => {
	const { env, calls } = makeEnv();
	for (const voice of ["en", { lang: "fr" }, {}, [], 5]) {
		const res = await worker.fetch(
			req("/api/chat", { method: "POST", body: { model: VISION, messages: [{ role: "user", content: "x" }], voice } }),
			env,
		);
		assert.equal(res.status, 400, JSON.stringify(voice));
		assert.match((await res.json()).error, /voice\.lang must be one of en, es/);
	}
	assert.equal(calls.length, 0);
});

test("images reach the new vision models and become a note for Granite", async () => {
	const { env, calls } = makeEnv();
	const body = (model) => ({
		model,
		messages: [{ role: "user", content: [{ type: "text", text: "what?" }, { type: "image_url", image_url: { url: IMG } }] }],
	});
	for (const model of ["@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/moonshotai/kimi-k2.7-code", "@cf/ibm-granite/granite-4.0-h-micro"]) {
		await worker.fetch(req("/api/chat", { method: "POST", body: body(model) }), env);
	}
	assert.deepEqual(calls[0].input.messages[0].content[1], { type: "image_url", image_url: { url: IMG } });
	assert.deepEqual(calls[1].input.messages[0].content[1], { type: "image_url", image_url: { url: IMG } });
	assert.match(calls[2].input.messages[0].content, /^what\?\n\n\[An image was attached/);
});

test("Nemotron with Thinking off: the reply the service streams as reasoning arrives as content", async () => {
	const stream = () =>
		new ReadableStream({
			start(c) {
				c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"reasoning":"Hello"}}]}\n\ndata: [DONE]\n\n'));
				c.close();
			},
		});
	const { env } = makeEnv({ AI: { run: async () => stream() } });
	const post = async (model, extra) =>
		(await worker.fetch(req("/api/chat", { method: "POST", body: { model, messages: [{ role: "user", content: "hi" }], ...extra } }), env)).text();
	const nemotron = "@cf/nvidia/nemotron-3-120b-a12b";
	const off = { params: { chat_template_kwargs: { enable_thinking: false } } };
	assert.match(await post(nemotron, off), /"delta":\{"content":"Hello"\}/);
	assert.match(await post(nemotron, { voice: { lang: "en" } }), /"delta":\{"content":"Hello"\}/);
	assert.match(await post(nemotron, { ...off, tools: ["web"] }), /"delta":\{"content":"Hello"\}/);
	assert.match(await post(nemotron, { params: { chat_template_kwargs: { enable_thinking: true } } }), /"reasoning":"Hello"/);
	assert.match(await post(nemotron, {}), /"reasoning":"Hello"/);
	assert.match(await post("@cf/qwen/qwen3.8-27b", off), /"reasoning":"Hello"/, "only models flagged for it are rewritten");
});

const signIn = async (env, ip) => (await (await worker.fetch(req("/api/auth", { method: "POST", ip }), env)).json()).token;

test("tokens: the passcode buys a token that works everywhere, without touching the lockout counts", async () => {
	const { env, guard } = makeEnv();
	const token = await signIn(env);
	const before = guard.attempts;
	assert.equal((await worker.fetch(req("/api/models", { pass: token }), env)).status, 200);
	assert.equal(guard.attempts, before, "token requests skip the Durable Object");
	const [, id, sig] = token.split(".");
	const tampered = `t1.${id}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
	assert.equal((await worker.fetch(req("/api/models", { pass: tampered }), env)).status, 401);
	assert.equal((await worker.fetch(req("/api/models", { pass: token }), { ...env, PASSCODE: "new-pass" })).status, 401, "a new passcode signs devices out");
	assert.equal((await worker.fetch(req("/api/models", { pass: token }), { ...env, SESSION_SECRET: "other" })).status, 401);
	assert.equal((await worker.fetch(req("/api/models", { pass: token }), { ...env, SESSION_SECRET: undefined })).status, 503);
});

test("requests without credentials or with bad tokens are not counted as guesses", async () => {
	const { env, guard } = makeEnv();
	for (let i = 0; i < 6; i++) {
		assert.equal((await worker.fetch(req("/api/models", { pass: null }), env)).status, 401);
		assert.equal((await worker.fetch(req("/api/models", { pass: "t1.nope" }), env)).status, 401);
	}
	assert.equal(guard.attempts, 0);
	assert.equal((await worker.fetch(req("/api/auth", { method: "POST" }), env)).status, 200);
});

test("lockout: the 4th wrong passcode in an hour warns and alerts, the 5th freezes logins for 8 hours; tokens keep working", async (t) => {
	const { env } = makeEnv();
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	env.VAPID_JWK = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
	const token = await signIn(env);
	const subscription = {
		endpoint: "https://web.push.apple.com/abc",
		keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
	};
	const sub = await worker.fetch(new Request("https://thread.test/api/push/subscribe", {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(subscription),
	}), env);
	assert.equal(sub.status, 204);

	const pushes = [];
	t.mock.method(globalThis, "fetch", async (url, init) => {
		pushes.push({ url, init });
		return new Response(null, { status: 201 });
	});
	const waits = [];
	const ctx = { waitUntil: (p) => waits.push(p) };
	const guess = (ip) => worker.fetch(req("/api/auth", { method: "POST", pass: "wrong", ip }), env, ctx);

	for (let i = 1; i <= 3; i++) assert.equal((await guess(`203.0.113.${i}`)).status, 401);
	const fourth = await guess("203.0.113.4");
	assert.equal(fourth.status, 401);
	assert.equal((await fourth.json()).error, LAST_TRY);
	await Promise.all(waits);
	assert.equal(pushes.length, 1, "one alert for the one subscribed device");
	assert.equal(pushes[0].url, subscription.endpoint);
	assert.equal(pushes[0].init.headers["content-encoding"], "aes128gcm");
	assert.match(pushes[0].init.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);

	const fifth = await guess("203.0.113.5");
	assert.equal(fifth.status, 429);
	assert.equal(fifth.headers.get("retry-after"), "28800");
	assert.equal((await fifth.json()).error, "Too many wrong passcodes, so logins are frozen for 8 hours. Go touch grass. 🌱");
	await Promise.all(waits);
	assert.equal(pushes.length, 2, "and one when logins freeze");

	assert.equal((await worker.fetch(req("/api/auth", { method: "POST", ip: "198.51.100.4" }), env)).status, 429, "even the right passcode");
	assert.equal((await worker.fetch(req("/api/models", { pass: token }), env)).status, 200, "signed-in devices are unaffected");
	assert.ok(ALERTS.locked.body.includes("{until}"));
});

test("push: key needs VAPID_JWK, subscribing needs a token, push services that forget a device drop it", async (t) => {
	const { env, guard } = makeEnv();
	assert.equal((await worker.fetch(req("/api/push/key"), env)).status, 503);
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	env.VAPID_JWK = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
	const { key } = await (await worker.fetch(req("/api/push/key"), env)).json();
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	assert.equal(key, Buffer.from(raw).toString("base64url"));

	const body = {
		endpoint: "https://fcm.googleapis.com/fcm/send/x",
		keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
	};
	assert.equal((await worker.fetch(req("/api/push/subscribe", { method: "POST", body }), env)).status, 400, "passcode-only clients have no device id");
	const token = await signIn(env);
	const post = (path, payload) => worker.fetch(req(path, { method: "POST", pass: token, body: payload }), env);
	assert.equal((await post("/api/push/subscribe", { ...body, endpoint: "http://x" })).status, 400);
	assert.equal((await post("/api/push/subscribe", body)).status, 204);
	assert.equal((await guard.subscriptions()).length, 1);

	t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 410 }));
	const { notifyAll } = await import("../src/alerts.js");
	await notifyAll(env, guard, ALERTS.warning, "https://thread.test");
	assert.equal((await guard.subscriptions()).length, 0);

	assert.equal((await post("/api/push/subscribe", body)).status, 204);
	assert.equal((await post("/api/push/unsubscribe")).status, 204);
	assert.equal((await guard.subscriptions()).length, 0);
});

test("chat responses carry the request start time for the usage counter", async () => {
	const { env } = makeEnv();
	const before = Date.now();
	const res = await worker.fetch(req("/api/chat", { method: "POST", body: { model: VISION, messages: [{ role: "user", content: "x" }] } }), env);
	const started = Number(res.headers.get("x-thread-started"));
	assert.ok(started >= before && started <= Date.now());
	const tools = await worker.fetch(
		req("/api/chat", { method: "POST", body: { model: VISION, messages: [{ role: "user", content: "x" }], tools: ["web"] } }),
		env,
	);
	assert.ok(Number(tools.headers.get("x-thread-started")) >= before);
});

test("usage: 503 until configured, then this month's neurons per day from GraphQL", async (t) => {
	const { env } = makeEnv();
	assert.equal((await worker.fetch(req("/api/usage"), env)).status, 503);

	const sent = [];
	t.mock.method(globalThis, "fetch", async (url, init) => {
		sent.push({ url, init });
		return Response.json({
			data: {
				viewer: {
					accounts: [
						{
							days: [{ sum: { totalNeurons: 1234.5 }, dimensions: { date: "2026-10-01" } }],
							latest: [{ datetime: "2026-10-01T09:00:00Z" }],
						},
					],
				},
			},
		});
	});
	const configured = { ...env, USAGE_API_TOKEN: "token-1", USAGE_ACCOUNT_ID: "acct-usage-1" };
	const res = await worker.fetch(req("/api/usage"), configured);
	assert.equal(res.status, 200);
	const data = await res.json();
	assert.deepEqual(data.days, [{ date: "2026-10-01", neurons: 1234.5 }]);
	assert.equal(data.through, "2026-10-01T09:00:00Z");
	assert.equal(data.today, new Date().toISOString().slice(0, 10));
	assert.equal(data.freeNeuronsPerDay, 10000);
	assert.equal(data.usdPer1000Neurons, 0.011);
	assert.equal(sent[0].url, "https://api.cloudflare.com/client/v4/graphql");
	assert.equal(sent[0].init.headers.authorization, "Bearer token-1");
	const vars = JSON.parse(sent[0].init.body).variables;
	assert.equal(vars.account, "acct-usage-1");
	assert.equal(vars.from, `${data.today.slice(0, 8)}01`);

	await worker.fetch(req("/api/usage"), configured);
	assert.equal(sent.length, 1, "repeat requests within 30 s are served from memory");
});

test("usage: GraphQL errors become 502", async (t) => {
	const { env } = makeEnv({ USAGE_API_TOKEN: "token-2", USAGE_ACCOUNT_ID: "acct-usage-2" });
	t.mock.method(globalThis, "fetch", async () => Response.json({ data: null, errors: [{ message: "not authorized" }] }));
	const res = await worker.fetch(req("/api/usage"), env);
	assert.equal(res.status, 502);
	assert.match((await res.json()).error, /not authorized/);
});
