import { test } from "node:test";
import assert from "node:assert/strict";
import { MODELS } from "../src/models.js";
import { ParamError, allowedKeys, hasCustom, sanitizeParams, toWire } from "../public/params.js";

const byId = (id) => MODELS.find((m) => m.id === id);
const GLM = byId("@cf/zai-org/glm-5.3-flash");
const GEMMA = byId("@cf/google/gemma-4-26b-a4b-it");
const OSS = byId("@cf/openai/gpt-oss-120b");
const KIMI = byId("@cf/moonshotai/kimi-k2.6");
const LLAMA = byId("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
const QWEN = byId("@cf/qwen/qwen3.8-27b");
const NEMOTRON = byId("@cf/nvidia/nemotron-3-120b-a12b");
const DEEPSEEK_PRO = byId("@cf/deepseek-ai/deepseek-v4-pro-0813");
const GRANITE = byId("@cf/ibm-granite/granite-4.0-h-micro");
const MISTRAL = byId("@cf/mistralai/mistral-small-3.1-24b-instruct");
const OSS20 = byId("@cf/openai/gpt-oss-20b");
const KIMI_CODE = byId("@cf/moonshotai/kimi-k2.7-code");

test("every model's controls have unique keys and valid groups", () => {
	for (const m of MODELS) {
		const keys = m.controls.map((c) => `${c.path || ""}.${c.key}`);
		assert.equal(new Set(keys).size, keys.length, m.id);
		for (const c of m.controls) {
			if (c.hidden) continue;
			assert.ok(["Reply length", "Thinking", "Randomness", "Word choice"].includes(c.group), `${m.id} ${c.key}`);
		}
	}
});

// The settings page shows these greyed out in empty fields. Max output tokens is what the Worker sends; every
// other value is the default in the model's Workers AI schema (GET /ai/models/schema, read 2026-10-07).
test("display defaults match what applies when a field is empty", () => {
	const defaults = (m) => Object.fromEntries(m.controls.filter((c) => c.default !== undefined).map((c) => [c.key, c.default]));
	const chat = { temperature: 1, top_p: 1, frequency_penalty: 0, presence_penalty: 0, max_completion_tokens: 16384 };
	assert.deepEqual(defaults(GLM), { reasoning_effort: "max", ...chat });
	assert.deepEqual(defaults(GEMMA), { enable_thinking: true, ...chat });
	assert.deepEqual(defaults(DEEPSEEK_PRO), { reasoning_effort: "high", enable_thinking: true, ...chat });
	assert.deepEqual(defaults(QWEN), { reasoning_effort: "xhigh", enable_thinking: true, ...chat });
	assert.deepEqual(defaults(NEMOTRON), { enable_thinking: true, low_effort: false, ...chat });
	assert.deepEqual(defaults(KIMI), { reasoning_effort: "high", ...chat });
	assert.deepEqual(defaults(KIMI_CODE), chat);
	// The older schema documents no default for top_p, top_k or the penalties.
	assert.deepEqual(defaults(GRANITE), { temperature: 0.6, max_completion_tokens: 16384 });
	assert.deepEqual(defaults(LLAMA), { temperature: 0.6, max_completion_tokens: 4096 });
	assert.deepEqual(defaults(MISTRAL), { temperature: 0.15, max_completion_tokens: 16384 });
	assert.deepEqual(defaults(OSS), { reasoning_effort: "medium", temperature: 0.6, max_completion_tokens: 16384 });
	assert.deepEqual(defaults(OSS20), { reasoning_effort: "medium", temperature: 0.6, max_completion_tokens: 16384 });
	for (const m of MODELS) {
		assert.equal(defaults(m).max_completion_tokens, m.defaultMaxTokens ?? 16384, m.id);
		assert.ok(m.controls.find((c) => c.key === "response_format")?.hidden ?? true, m.id);
	}
});

test("empty settings produce no params", () => {
	assert.deepEqual(toWire(GLM, undefined), {});
	assert.deepEqual(toWire(GLM, { values: {}, json: "  " }), {});
	assert.equal(hasCustom({ values: {}, json: "" }), false);
	assert.equal(hasCustom({ values: { temperature: 0.5 }, json: "" }), true);
});

test("controls convert to wire format", () => {
	const wire = toWire(QWEN, {
		values: {
			temperature: 0.4,
			enable_thinking: false,
			stop: "END\n\nSTOP\r",
			response_format: "json_object",
			logit_bias: '{"42": -100}',
			max_completion_tokens: 2048,
			seed: 7,
		},
		json: "",
	});
	assert.deepEqual(wire, {
		temperature: 0.4,
		chat_template_kwargs: { enable_thinking: false },
		stop: ["END", "STOP"],
		response_format: { type: "json_object" },
		logit_bias: { 42: -100 },
		max_completion_tokens: 2048,
		seed: 7,
	});
});

test("saved values for controls a model no longer offers are not sent", () => {
	assert.deepEqual(toWire(GEMMA, { values: { temperature: 0.4, seed: 7, clear_thinking: true, skip_special_tokens: true } }), {
		temperature: 0.4,
	});
});

test("advanced JSON overrides controls and merges chat_template_kwargs", () => {
	const wire = toWire(NEMOTRON, {
		values: { temperature: 0.4, enable_thinking: false },
		json: '{"temperature": 0.9, "chat_template_kwargs": {"low_effort": true}, "n": 1, "user": "me"}',
	});
	assert.deepEqual(wire, {
		temperature: 0.9,
		chat_template_kwargs: { enable_thinking: false, low_effort: true },
		n: 1,
		user: "me",
	});
});

test("range and enum violations are rejected", () => {
	assert.throws(() => toWire(GLM, { values: { temperature: 3 } }), /temperature must be a number between 0 and 2/);
	assert.throws(() => toWire(OSS, { values: { temperature: 1.25 } }), /between 0 and 1.2/);
	assert.throws(() => toWire(OSS, { values: { top_k: 0 } }), /top_k must be an integer between 1 and 50/);
	assert.throws(() => toWire(KIMI, { values: { reasoning_effort: "low" } }), /one of high, none/);
	assert.throws(() => toWire(GLM, { values: { max_completion_tokens: 1.5 } }), /integer/);
	assert.throws(() => toWire(GLM, { values: { stop: "a\nb\nc\nd\ne" } }), /1 to 4/);
	assert.throws(() => toWire(GLM, { values: { logit_bias: '{"x": 1}' } }), /token IDs/);
	assert.throws(() => toWire(GLM, { values: { logit_bias: '{"1": 500}' } }), /-100 to 100/);
	assert.throws(() => toWire(OSS20, { values: { logit_bias: '{"1": 31}' } }), /-100 to 30/);
	assert.throws(() => toWire(GLM, { values: { logit_bias: "{bad" } }), /Logit bias: invalid JSON/);
});

test("GLM cannot disable thinking; gpt-oss has no chat_template_kwargs", () => {
	assert.throws(() => sanitizeParams({ chat_template_kwargs: { enable_thinking: false } }, GLM), /chat_template_kwargs is not a parameter of GLM-5.3 Flash/);
	assert.throws(() => sanitizeParams({ chat_template_kwargs: {} }, OSS), /not a parameter of gpt-oss-120b/);
});

test("response_format rules follow each model", () => {
	assert.throws(() => sanitizeParams({ response_format: { type: "text" } }, OSS), /type must be one of json_object, json_schema/);
	assert.throws(() => sanitizeParams({ response_format: { type: "text" } }, GLM), /type must be one of json_object, json_schema/);
	const schema = { type: "json_schema", json_schema: { name: "x", schema: { type: "object" } } };
	assert.deepEqual(sanitizeParams({ response_format: schema }, OSS), { response_format: schema });
	assert.throws(() => sanitizeParams({ response_format: { type: "json_schema" } }, GLM), /json_schema object with a name/);
});

test("unknown, reserved and malformed keys are rejected", () => {
	assert.throws(() => sanitizeParams({ bogus: 1 }, GLM), /bogus is not a parameter/);
	for (const k of ["stream", "messages", "model", "prompt"]) {
		assert.throws(() => sanitizeParams({ [k]: true }, GLM), new RegExp(`${k} cannot be set`));
	}
	assert.throws(() => toWire(GLM, { json: "[1,2]" }), /must be an object/);
	assert.throws(() => toWire(GLM, { json: "{oops" }), (e) => e instanceof ParamError && /^Advanced JSON:/.test(e.message));
	assert.throws(() => sanitizeParams({ raw: true }, GLM), /raw is not a parameter/);
	assert.deepEqual(sanitizeParams({ raw: false }, OSS), { raw: false });
});

test("allowedKeys lists controls and extra keys", () => {
	const keys = allowedKeys(GEMMA);
	for (const k of ["temperature", "chat_template_kwargs", "tools", "n"]) assert.ok(keys.includes(k), k);
	for (const k of ["enable_thinking", "skip_special_tokens", "seed"]) assert.ok(!keys.includes(k), k);
	assert.ok(!allowedKeys(OSS).includes("chat_template_kwargs"));
});

test("Qwen 3.8 27B: effort levels, thinking toggle and the top_p floor follow the service", () => {
	assert.deepEqual(toWire(QWEN, { values: { reasoning_effort: "xhigh", enable_thinking: false } }), {
		reasoning_effort: "xhigh",
		chat_template_kwargs: { enable_thinking: false },
	});
	assert.throws(() => toWire(QWEN, { values: { reasoning_effort: "none" } }), /one of xhigh, medium, low/);
	assert.throws(() => toWire(QWEN, { values: { top_p: 0 } }), /top_p must be a number between 0.001 and 1/);
	assert.deepEqual(toWire(QWEN, { values: { top_p: 0.001 } }), { top_p: 0.001 });
});

test("Nemotron 3 120B: reasoning modes go through chat_template_kwargs only", () => {
	assert.deepEqual(
		toWire(NEMOTRON, { values: { enable_thinking: true, low_effort: true } }),
		{ chat_template_kwargs: { enable_thinking: true, low_effort: true } },
	);
	assert.throws(() => sanitizeParams({ chat_template_kwargs: { force_nonempty_content: true } }, NEMOTRON), /force_nonempty_content is not supported/);
	assert.throws(() => sanitizeParams({ reasoning_effort: "low" }, NEMOTRON), /reasoning_effort is not a parameter of Nemotron 3 120B/);
	assert.throws(() => sanitizeParams({ chat_template_kwargs: { clear_thinking: true } }, NEMOTRON), /clear_thinking is not supported/);
	assert.throws(() => toWire(NEMOTRON, { values: { top_p: 0 } }), /between 0.001 and 1/);
});

test("DeepSeek V4 Pro: effort none is not offered because it matched low, and top_p cannot be 0", () => {
	assert.deepEqual(toWire(DEEPSEEK_PRO, { values: { reasoning_effort: "low", enable_thinking: false } }), {
		reasoning_effort: "low",
		chat_template_kwargs: { enable_thinking: false },
	});
	for (const level of ["none", "xhigh"]) assert.throws(() => toWire(DEEPSEEK_PRO, { values: { reasoning_effort: level } }), /one of max, high, low\.$/);
	assert.throws(() => toWire(DEEPSEEK_PRO, { values: { top_p: 0 } }), /between 0.001 and 1/);
});

test("Llama 3.3 70B follows its legacy schema and the limits the service enforces", () => {
	assert.throws(() => sanitizeParams({ logit_bias: { 1: 1 } }, LLAMA), /logit_bias is not a parameter of Llama 3.3 70B/);
	assert.throws(() => sanitizeParams({ chat_template_kwargs: {} }, LLAMA), /not a parameter of Llama 3.3 70B/);
	assert.throws(() => toWire(LLAMA, { values: { response_format: "text" } }), /type must be one of json_object, json_schema/);
	assert.throws(() => toWire(LLAMA, { values: { temperature: 2.5 } }), /between 0 and 2/);
	assert.throws(() => toWire(LLAMA, { values: { seed: 0 } }), /between 1 and 9999999999/);
	assert.throws(() => toWire(LLAMA, { values: { top_k: 51 } }), /between 1 and 50/);
	assert.throws(() => toWire(LLAMA, { values: { max_completion_tokens: 24001 } }), /between 1 and 24000/);
	assert.deepEqual(toWire(LLAMA, { values: { stop: "END", top_k: 10, repetition_penalty: 1.2, response_format: "json_object" } }), {
		stop: ["END"],
		top_k: 10,
		repetition_penalty: 1.2,
		response_format: { type: "json_object" },
	});
});

test("only the models with a vision input accept images", () => {
	assert.deepEqual(
		MODELS.filter((m) => m.vision).map((m) => m.id).sort(),
		[
			"@cf/google/gemma-4-26b-a4b-it",
			"@cf/mistralai/mistral-small-3.1-24b-instruct",
			"@cf/moonshotai/kimi-k2.6",
			"@cf/moonshotai/kimi-k2.7-code",
			"@cf/qwen/qwen3.8-27b",
			"@cf/zai-org/glm-5.3-flash",
		],
	);
});

test("every model's voice overrides are valid parameters for that model", () => {
	const withOverrides = MODELS.filter((m) => m.voiceParams);
	assert.deepEqual(
		withOverrides.map((m) => m.name).sort(),
		["DeepSeek V4 Flash", "DeepSeek V4 Pro", "Gemma 4 26B", "Kimi K2.6", "Nemotron 3 120B", "Qwen 3.8 27B"],
	);
	for (const m of withOverrides) assert.deepEqual(sanitizeParams(m.voiceParams, m), m.voiceParams, m.id);
});

test("every model rejects top_p 0, which the service refuses, and accepts 0.001", () => {
	for (const m of MODELS) {
		assert.throws(() => toWire(m, { values: { top_p: 0 } }), /top_p must be a number between 0.001 and 1/, m.id);
		assert.deepEqual(toWire(m, { values: { top_p: 0.001 } }), { top_p: 0.001 }, m.id);
	}
});

test("Granite 4.0 Micro: older schema, temperature up to 5, no logit bias, no text response format", () => {
	assert.deepEqual(toWire(GRANITE, { values: { temperature: 5, top_k: 50, seed: 1, frequency_penalty: -2, repetition_penalty: 2 } }), {
		temperature: 5,
		top_k: 50,
		seed: 1,
		frequency_penalty: -2,
		repetition_penalty: 2,
	});
	assert.throws(() => toWire(GRANITE, { values: { temperature: 5.1 } }), /between 0 and 5/);
	assert.throws(() => sanitizeParams({ logit_bias: { 1: 1 } }, GRANITE), /logit_bias is not a parameter of Granite 4.0 Micro/);
	assert.throws(() => sanitizeParams({ reasoning_effort: "low" }, GRANITE), /not a parameter/);
	assert.throws(() => toWire(GRANITE, { values: { response_format: "text" } }), /type must be one of json_object, json_schema/);
	assert.throws(() => toWire(GRANITE, { values: { seed: 0 } }), /between 1 and 9999999999/);
	assert.throws(() => toWire(GRANITE, { values: { max_completion_tokens: 131001 } }), /between 1 and 131000/);
	assert.deepEqual(toWire(GRANITE, { values: { stop: "END" } }), { stop: ["END"] });
});

test("Mistral Small 3.1: penalties start at 0, JSON response format, temperature up to 5", () => {
	assert.throws(() => toWire(MISTRAL, { values: { frequency_penalty: -0.5 } }), /between 0 and 2/);
	assert.throws(() => toWire(MISTRAL, { values: { presence_penalty: -0.5 } }), /between 0 and 2/);
	assert.deepEqual(toWire(MISTRAL, { values: { frequency_penalty: 0.5, temperature: 5, response_format: "json_object" } }), {
		frequency_penalty: 0.5,
		temperature: 5,
		response_format: { type: "json_object" },
	});
	assert.throws(() => toWire(MISTRAL, { values: { response_format: "text" } }), /type must be one of json_object, json_schema/);
	assert.throws(() => toWire(MISTRAL, { values: { top_p: 0 } }), /between 0.001 and 1/);
	assert.throws(() => toWire(MISTRAL, { values: { top_p: 1.5 } }), /between 0.001 and 1/);
	assert.throws(() => sanitizeParams({ logit_bias: { 1: 1 } }, MISTRAL), /not a parameter/);
});

test("gpt-oss-20b: the 120b's controls without response format, temperature up to 1, logit bias up to 30", () => {
	assert.deepEqual(toWire(OSS20, { values: { reasoning_effort: "low", temperature: 1, logit_bias: '{"7": -100, "8": 30}' } }), {
		reasoning_effort: "low",
		temperature: 1,
		logit_bias: { 7: -100, 8: 30 },
	});
	assert.throws(() => toWire(OSS20, { values: { temperature: 1.05 } }), /between 0 and 1\.$/);
	assert.throws(() => toWire(OSS20, { values: { reasoning_effort: "none" } }), /one of low, medium, high/);
	assert.throws(() => sanitizeParams({ response_format: { type: "json_object" } }, OSS20), /response_format is not a parameter of gpt-oss-20b/);
	assert.throws(() => sanitizeParams({ chat_template_kwargs: {} }, OSS20), /not a parameter/);
	assert.deepEqual(
		OSS20.controls.map((c) => c.key),
		OSS.controls.map((c) => c.key).filter((k) => k !== "response_format"),
	);
});

test("repetition penalty: 0 is refused by the service; gpt-oss starts at 0.7", () => {
	for (const m of [GRANITE, LLAMA, MISTRAL, OSS, OSS20]) {
		assert.throws(() => toWire(m, { values: { repetition_penalty: 0 } }), /repetition_penalty must be a number/, m.id);
		assert.deepEqual(toWire(m, { values: { repetition_penalty: 2 } }), { repetition_penalty: 2 }, m.id);
	}
	for (const m of [GRANITE, LLAMA, MISTRAL]) assert.deepEqual(toWire(m, { values: { repetition_penalty: 0.05 } }), { repetition_penalty: 0.05 }, m.id);
	for (const m of [OSS, OSS20]) {
		assert.throws(() => toWire(m, { values: { repetition_penalty: 0.65 } }), /between 0.7 and 2/, m.id);
		assert.deepEqual(toWire(m, { values: { repetition_penalty: 0.7 } }), { repetition_penalty: 0.7 }, m.id);
	}
});

test("controls that had no measurable effect are not offered", () => {
	const keys = (m) => m.controls.map((c) => c.key);
	for (const m of MODELS) {
		for (const k of ["clear_thinking", "skip_special_tokens", "force_nonempty_content"]) assert.ok(!keys(m).includes(k), `${m.id} ${k}`);
		const format = m.controls.find((c) => c.key === "response_format");
		if (format) assert.ok(!format.options.includes("text"), m.id);
	}
	const seeded = MODELS.filter((m) => keys(m).includes("seed")).map((m) => m.name).sort();
	assert.deepEqual(seeded, ["Granite 4.0 Micro", "Llama 3.3 70B", "Mistral Small 3.1", "Nemotron 3 120B", "Qwen 3.8 27B", "gpt-oss-120b", "gpt-oss-20b"]);
	assert.ok(!keys(KIMI).includes("enable_thinking"));
	assert.deepEqual(keys(KIMI_CODE).filter((k) => KIMI_CODE.controls.find((c) => c.key === k).group === "Thinking"), []);
});

test("Kimi K2.7 Code: no reasoning controls, since effort levels made no difference", () => {
	assert.throws(() => sanitizeParams({ reasoning_effort: "low" }, KIMI_CODE), /reasoning_effort is not a parameter of Kimi K2.7 Code/);
	assert.throws(() => sanitizeParams({ chat_template_kwargs: { enable_thinking: false } }, KIMI_CODE), /chat_template_kwargs is not a parameter of Kimi K2.7 Code/);
	assert.deepEqual(toWire(KIMI_CODE, { values: { temperature: 0.7, logit_bias: '{"1": 5}' } }), { temperature: 0.7, logit_bias: { 1: 5 } });
	assert.equal(KIMI_CODE.voiceParams, undefined);
});
