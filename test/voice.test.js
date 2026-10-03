import { test } from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/worker.js";
import { VOICES, VOICE_MODELS, DEFAULT_VOICE, voiceById } from "../src/voices.js";
import { parseWav, MAX_SPEECH_CHARS, SAMPLE_RATE } from "../src/voice.js";

crypto.subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

const PASS = "test-pass";

function wav(samples, { rate = SAMPLE_RATE, channels = 1, bits = 16, dataSize, extraChunk = false } = {}) {
	const pcm = new Int16Array(samples);
	const extra = extraChunk ? 12 : 0;
	const bytes = new Uint8Array(44 + extra + pcm.byteLength);
	const view = new DataView(bytes.buffer);
	const put = (o, s) => [...s].forEach((c, i) => (bytes[o + i] = c.charCodeAt(0)));
	put(0, "RIFF");
	view.setUint32(4, bytes.byteLength - 8, true);
	put(8, "WAVE");
	put(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, rate, true);
	view.setUint32(28, rate * channels * (bits / 8), true);
	view.setUint16(32, channels * (bits / 8), true);
	view.setUint16(34, bits, true);
	let o = 36;
	if (extraChunk) {
		put(o, "LIST");
		view.setUint32(o + 4, 4, true);
		put(o + 8, "INFO");
		o += 12;
	}
	put(o, "data");
	view.setUint32(o + 4, dataSize ?? pcm.byteLength, true);
	bytes.set(new Uint8Array(pcm.buffer), o + 8);
	return bytes;
}

const ramp = (n) => Int16Array.from({ length: n }, (_, i) => (i % 2000) * 16 - 16000);

function makeEnv(handlers = {}, overrides = {}) {
	const calls = [];
	return {
		calls,
		env: {
			PASSCODE: PASS,
			AI_GATEWAY_ID: "",
			ASSETS: { fetch: () => new Response("asset") },
			AI: {
				run: async (model, input, options) => {
					calls.push({ model, input, options });
					const handler = handlers[model];
					if (!handler) throw new Error(`unexpected model ${model}`);
					return handler(input);
				},
			},
			...overrides,
		},
	};
}

const sttOk = (text) => () => ({ results: { channels: [{ alternatives: [{ transcript: text }] }] } });
const mp3 = () => new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array([0xff, 0xf3, 0x64])), c.close()) });

const post = (env, path, body, headers = {}) =>
	worker.fetch(
		new Request(`https://thread.test${path}`, { method: "POST", headers: { authorization: `Bearer ${PASS}`, ...headers }, body }),
		env,
	);
const postJson = (env, path, body) => post(env, path, JSON.stringify(body), { "content-type": "application/json" });

test("voice list: 40 English and 10 Spanish Aura-2 voices, each routed to its model", () => {
	assert.equal(VOICES.length, 50);
	assert.equal(new Set(VOICES.map((v) => v.id)).size, 50);
	assert.equal(VOICES.filter((v) => v.lang === "en").length, 40);
	assert.equal(VOICES.filter((v) => v.lang === "es").length, 10);
	assert.deepEqual(VOICE_MODELS, { en: "@cf/deepgram/aura-2-en", es: "@cf/deepgram/aura-2-es" });
	for (const v of VOICES) {
		assert.ok(VOICE_MODELS[v.lang], v.id);
		assert.ok(["feminine", "masculine"].includes(v.gender), v.id);
		assert.ok(v.traits.length > 0 && v.accent && v.age, v.id);
	}
	assert.ok(voiceById(DEFAULT_VOICE));
	assert.equal(voiceById("selene"), undefined, "the service rejects voices Cloudflare does not list");
});

test("GET /api/voices returns voices and limits", async () => {
	const { env } = makeEnv();
	const res = await worker.fetch(new Request("https://thread.test/api/voices", { headers: { authorization: `Bearer ${PASS}` } }), env);
	const data = await res.json();
	assert.equal(res.status, 200);
	assert.equal(data.voices.length, 50);
	assert.equal(data.default, DEFAULT_VOICE);
	assert.equal(data.sampleRate, 16000);
	assert.equal(data.turnWindowSeconds, 8);
	assert.equal(data.maxSpeechChars, 2000);
});

test("voice routes need the passcode and the right method", async () => {
	const { env, calls } = makeEnv();
	const anon = await worker.fetch(new Request("https://thread.test/api/voice/speak", { method: "POST", body: "{}" }), env);
	assert.equal(anon.status, 401);
	const get = await worker.fetch(new Request("https://thread.test/api/voice/transcribe", { headers: { authorization: `Bearer ${PASS}` } }), env);
	assert.equal(get.status, 405);
	const put = await worker.fetch(new Request("https://thread.test/api/voices", { method: "POST", headers: { authorization: `Bearer ${PASS}` } }), env);
	assert.equal(put.status, 405);
	assert.equal(calls.length, 0);
});

test("parseWav reads the PCM payload, skips extra chunks and tolerates a streamed size", () => {
	const samples = ramp(1600);
	const a = parseWav(wav(samples));
	assert.equal(a.samples, 1600);
	assert.equal(a.view.getInt16(2, true), samples[1]);
	const b = parseWav(wav(samples, { extraChunk: true }));
	assert.equal(b.samples, 1600);
	assert.equal(b.view.getInt16(2 * 1599, true), samples[1599]);
	const c = parseWav(wav(samples, { dataSize: 0xffffffff }));
	assert.equal(c.samples, 1600);
});

test("parseWav rejects anything but 16 kHz mono 16-bit PCM WAV", () => {
	assert.throws(() => parseWav(new Uint8Array(100)), /WAV file/);
	assert.throws(() => parseWav(wav(ramp(100), { rate: 44100 })), /16000 Hz mono 16-bit/);
	assert.throws(() => parseWav(wav(ramp(100), { channels: 2 })), /16000 Hz mono 16-bit/);
	assert.throws(() => parseWav(wav(ramp(100), { bits: 8 })), /16000 Hz mono 16-bit/);
	assert.throws(() => parseWav(wav(ramp(100)).subarray(0, 36)), /no audio data/);
});

test("transcribe sends Nova-3 a WAV stream with multilingual smart formatting", async () => {
	const { env, calls } = makeEnv({ "@cf/deepgram/nova-3": sttOk("  Hola, ¿qué tal?  ") }, { AI_GATEWAY_ID: "gw" });
	const res = await post(env, "/api/voice/transcribe", wav(ramp(16000)), { "content-type": "audio/wav" });
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { text: "Hola, ¿qué tal?" });
	const { input, options } = calls[0];
	assert.equal(input.audio.contentType, "audio/wav");
	assert.ok(input.audio.body instanceof ReadableStream);
	assert.equal(input.language, "multi");
	assert.equal(input.smart_format, true);
	assert.deepEqual(options, { gateway: { id: "gw" } });
});

test("transcribe returns an empty string for silence and rejects bad audio", async () => {
	const { env, calls } = makeEnv({ "@cf/deepgram/nova-3": sttOk("") });
	assert.deepEqual(await (await post(env, "/api/voice/transcribe", wav(ramp(16000)))).json(), { text: "" });
	calls.length = 0;
	assert.equal((await post(env, "/api/voice/transcribe", new Uint8Array([1, 2, 3]))).status, 415);
	assert.equal((await post(env, "/api/voice/transcribe", wav(ramp(100)))).status, 400);
	assert.equal((await post(env, "/api/voice/transcribe", wav(ramp(100), { rate: 8000 }))).status, 415);
	assert.equal((await post(env, "/api/voice/transcribe", wav(new Int16Array(16000 * 121)))).status, 413);
	assert.equal(calls.length, 0);
});

test("transcribe maps model failures and odd results to 502", async () => {
	const failing = makeEnv({
		"@cf/deepgram/nova-3": () => {
			throw new Error("5006: bad input");
		},
	});
	const res = await post(failing.env, "/api/voice/transcribe", wav(ramp(16000)));
	assert.equal(res.status, 502);
	assert.match((await res.json()).error, /5006/);
	const odd = makeEnv({ "@cf/deepgram/nova-3": () => ({ results: {} }) });
	assert.equal((await post(odd.env, "/api/voice/transcribe", wav(ramp(16000)))).status, 502);
});

test("turn sends the last 8 seconds as base64 float32 and maps the result", async () => {
	const { env, calls } = makeEnv({ "@cf/pipecat-ai/smart-turn-v2": () => ({ is_complete: false, probability: 0.0128 }) });
	const samples = ramp(16000 * 10);
	const res = await post(env, "/api/voice/turn", wav(samples));
	assert.deepEqual(await res.json(), { complete: false, probability: 0.0128 });
	const { input } = calls[0];
	assert.equal(input.dtype, "float32");
	const raw = Uint8Array.from(atob(input.audio), (c) => c.charCodeAt(0));
	const floats = new Float32Array(raw.buffer);
	assert.equal(floats.length, 16000 * 8);
	const first = 16000 * 2;
	assert.equal(floats[0], samples[first] / 32768);
	assert.equal(floats[floats.length - 1], samples[samples.length - 1] / 32768);
});

test("turn passes short clips whole and rejects malformed results", async () => {
	const { env, calls } = makeEnv({ "@cf/pipecat-ai/smart-turn-v2": () => ({ is_complete: true, probability: 0.9 }) });
	await post(env, "/api/voice/turn", wav(ramp(8000)));
	assert.equal(new Float32Array(Uint8Array.from(atob(calls[0].input.audio), (c) => c.charCodeAt(0)).buffer).length, 8000);
	const odd = makeEnv({ "@cf/pipecat-ai/smart-turn-v2": () => ({ probability: 0.9 }) });
	assert.equal((await post(odd.env, "/api/voice/turn", wav(ramp(8000)))).status, 502);
});

test("speak streams Aura-2 audio from the model that serves the voice", async () => {
	const { env, calls } = makeEnv({ "@cf/deepgram/aura-2-en": mp3, "@cf/deepgram/aura-2-es": mp3 });
	const en = await postJson(env, "/api/voice/speak", { text: "  Hello there.  ", voice: "orion" });
	assert.equal(en.status, 200);
	assert.equal(en.headers.get("content-type"), "audio/mpeg");
	assert.deepEqual([...new Uint8Array(await en.arrayBuffer())], [0xff, 0xf3, 0x64]);
	await postJson(env, "/api/voice/speak", { text: "Hola.", voice: "javier" });
	await postJson(env, "/api/voice/speak", { text: "Default voice." });
	assert.deepEqual(calls.map((c) => [c.model, c.input.speaker]), [
		["@cf/deepgram/aura-2-en", "orion"],
		["@cf/deepgram/aura-2-es", "javier"],
		["@cf/deepgram/aura-2-en", DEFAULT_VOICE],
	]);
	assert.deepEqual(calls[0].input, { text: "Hello there.", speaker: "orion", encoding: "mp3" });
});

test("every listed voice is accepted by speak", async () => {
	const { env, calls } = makeEnv({ "@cf/deepgram/aura-2-en": mp3, "@cf/deepgram/aura-2-es": mp3 });
	for (const v of VOICES) assert.equal((await postJson(env, "/api/voice/speak", { text: "Hi", voice: v.id })).status, 200, v.id);
	assert.equal(calls.length, 50);
});

test("speak validates text and voice before calling the model", async () => {
	const { env, calls } = makeEnv({ "@cf/deepgram/aura-2-en": mp3 });
	const bad = [
		{ text: "" },
		{ text: "   " },
		{ text: "...", voice: "luna" },
		{ text: "😀" },
		{ text: 5 },
		{ text: "x".repeat(MAX_SPEECH_CHARS + 1) },
		{ text: "Hi", voice: "selene" },
		{ text: "Hi", voice: 7 },
	];
	for (const body of bad) assert.equal((await postJson(env, "/api/voice/speak", body)).status, 400, JSON.stringify(body).slice(0, 60));
	assert.equal((await post(env, "/api/voice/speak", "not json")).status, 400);
	assert.equal((await post(env, "/api/voice/speak", JSON.stringify({ text: "x".repeat(20000) }))).status, 413);
	assert.equal(calls.length, 0);
	assert.equal((await postJson(env, "/api/voice/speak", { text: "x".repeat(MAX_SPEECH_CHARS) })).status, 200);
});
