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

test("every model's controls have unique keys and valid groups", () => {
	for (const m of MODELS) {
		const keys = m.controls.map((c) => `${c.path || ""}.${c.key}`);
		assert.equal(new Set(keys).size, keys.length, m.id);
		for (const c of m.controls) assert.ok(["Reasoning", "Sampling", "Output"].includes(c.group), `${m.id} ${c.key}`);
	}
});

test("empty settings produce no params", () => {
	assert.deepEqual(toWire(GLM, undefined), {});
	assert.deepEqual(toWire(GLM, { values: {}, json: "  " }), {});
	assert.equal(hasCustom({ values: {}, json: "" }), false);
	assert.equal(hasCustom({ values: { temperature: 0.5 }, json: "" }), true);
});

test("controls convert to wire format", () => {
	const wire = toWire(GEMMA, {
		values: {
			temperature: 0.4,
			enable_thinking: false,
			clear_thinking: true,
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
		chat_template_kwargs: { enable_thinking: false, clear_thinking: true },
		stop: ["END", "STOP"],
		response_format: { type: "json_object" },
		logit_bias: { 42: -100 },
		max_completion_tokens: 2048,
		seed: 7,
	});
});

test("advanced JSON overrides controls and merges chat_template_kwargs", () => {
	const wire = toWire(GEMMA, {
		values: { temperature: 0.4, enable_thinking: false },
		json: '{"temperature": 0.9, "chat_template_kwargs": {"clear_thinking": true}, "n": 1, "user": "me"}',
	});
	assert.deepEqual(wire, {
		temperature: 0.9,
		chat_template_kwargs: { enable_thinking: false, clear_thinking: true },
		n: 1,
		user: "me",
	});
});

test("range and enum violations are rejected", () => {
	assert.throws(() => toWire(GLM, { values: { temperature: 3 } }), /temperature must be a number between 0 and 2/);
	assert.throws(() => toWire(OSS, { values: { temperature: 2.5 } }), /between 0 and 2/);
	assert.throws(() => toWire(OSS, { values: { top_k: 0 } }), /top_k must be an integer between 1 and 50/);
	assert.throws(() => toWire(KIMI, { values: { reasoning_effort: "low" } }), /one of high, none/);
	assert.throws(() => toWire(GLM, { values: { max_completion_tokens: 1.5 } }), /integer/);
	assert.throws(() => toWire(GLM, { values: { stop: "a\nb\nc\nd\ne" } }), /1 to 4/);
	assert.throws(() => toWire(GLM, { values: { logit_bias: '{"x": 1}' } }), /token IDs/);
	assert.throws(() => toWire(GLM, { values: { logit_bias: '{"1": 500}' } }), /-100 to 100/);
	assert.throws(() => toWire(GLM, { values: { logit_bias: "{bad" } }), /Logit bias: invalid JSON/);
});

test("GLM cannot disable thinking; gpt-oss has no chat_template_kwargs", () => {
	assert.throws(() => sanitizeParams({ chat_template_kwargs: { enable_thinking: false } }, GLM), /enable_thinking is not supported/);
	assert.deepEqual(sanitizeParams({ chat_template_kwargs: { clear_thinking: true } }, GLM), {
		chat_template_kwargs: { clear_thinking: true },
	});
	assert.throws(() => sanitizeParams({ chat_template_kwargs: {} }, OSS), /not a parameter of gpt-oss-120b/);
});

test("response_format rules follow each model", () => {
	assert.throws(() => sanitizeParams({ response_format: { type: "text" } }, OSS), /type must be one of json_object, json_schema/);
	assert.deepEqual(sanitizeParams({ response_format: { type: "text" } }, GLM), { response_format: { type: "text" } });
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
	for (const k of ["temperature", "chat_template_kwargs", "skip_special_tokens", "tools", "n"]) assert.ok(keys.includes(k), k);
	assert.ok(!keys.includes("enable_thinking"));
	assert.ok(!allowedKeys(OSS).includes("chat_template_kwargs"));
});

test("Qwen 3.8 27B: effort levels, thinking toggle and the top_p floor follow the service", () => {
	assert.deepEqual(toWire(QWEN, { values: { reasoning_effort: "xhigh", enable_thinking: false, clear_thinking: true } }), {
		reasoning_effort: "xhigh",
		chat_template_kwargs: { enable_thinking: false, clear_thinking: true },
	});
	assert.throws(() => toWire(QWEN, { values: { reasoning_effort: "none" } }), /one of xhigh, medium, low/);
	assert.throws(() => toWire(QWEN, { values: { top_p: 0 } }), /top_p must be a number between 0.001 and 1/);
	assert.deepEqual(toWire(QWEN, { values: { top_p: 0.001 } }), { top_p: 0.001 });
});

test("Nemotron 3 120B: reasoning modes go through chat_template_kwargs only", () => {
	assert.deepEqual(
		toWire(NEMOTRON, { values: { enable_thinking: true, low_effort: true, force_nonempty_content: true } }),
		{ chat_template_kwargs: { enable_thinking: true, low_effort: true, force_nonempty_content: true } },
	);
	assert.throws(() => sanitizeParams({ reasoning_effort: "low" }, NEMOTRON), /reasoning_effort is not a parameter of Nemotron 3 120B/);
	assert.throws(() => sanitizeParams({ chat_template_kwargs: { clear_thinking: true } }, NEMOTRON), /clear_thinking is not supported/);
	assert.throws(() => toWire(NEMOTRON, { values: { top_p: 0 } }), /between 0.001 and 1/);
});

test("DeepSeek V4 Pro: effort levels include none, and top_p cannot be 0", () => {
	assert.deepEqual(toWire(DEEPSEEK_PRO, { values: { reasoning_effort: "none", enable_thinking: false } }), {
		reasoning_effort: "none",
		chat_template_kwargs: { enable_thinking: false },
	});
	assert.throws(() => toWire(DEEPSEEK_PRO, { values: { reasoning_effort: "xhigh" } }), /one of max, high, low, none/);
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
		["@cf/google/gemma-4-26b-a4b-it", "@cf/moonshotai/kimi-k2.6", "@cf/qwen/qwen3.8-27b", "@cf/zai-org/glm-5.3-flash"],
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
