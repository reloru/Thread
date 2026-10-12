import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { MODELS } from "../src/models.js";
import { sanitizeParams } from "../public/params.js";
import { MAX_WORDS, buildBias, cleanWord, createWords, formsOf, lookup } from "../public/words.js";

const vocab = (family) => JSON.parse(readFileSync(new URL(`../public/vocab/${family}.json`, import.meta.url), "utf8"));
const byId = (id) => MODELS.find((m) => m.id === id);
const OSS20 = byId("@cf/openai/gpt-oss-20b");
const OSS = byId("@cf/openai/gpt-oss-120b");
const LLAMA = byId("@cf/meta/llama-3.3-70b-instruct-fp8-fast");

const memory = () => {
	const data = new Map();
	return { get: (k) => data.get(k) ?? null, set: (k, v) => data.set(k, v), del: (k) => data.delete(k), data };
};

test("cleanWord keeps one plain word and rejects the rest", () => {
	assert.equal(cleanWord("  Interesting "), "interesting");
	assert.equal(cleanWord("Can’t"), "can't");
	for (const bad of ["", "ab", "two words", "hello!", "123", "'quote", "x".repeat(41), "café", null, undefined]) {
		assert.equal(cleanWord(bad), null, String(bad));
	}
});

test("formsOf: space and capitalized forms, plus the no-space form on request", () => {
	assert.deepEqual(formsOf("pattern", false), [["sp", "pattern"], ["sp", "Pattern"], ["no", "Pattern"]]);
	assert.deepEqual(formsOf("pattern", true).at(-1), ["no", "pattern"]);
	assert.deepEqual(formsOf("can't", false)[2], ["no", "Can't"]);
});

test("lookup uses own keys only, so words like constructor are not found by accident", () => {
	for (const w of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
		assert.deepEqual(lookup({ sp: {}, no: {} }, w, true), { usable: false, ids: [] });
	}
	const bias = buildBias([{ w: "constructor", inside: true }], { sp: {}, no: {} });
	assert.deepEqual(bias, {});
});

// IDs checked against the published tokenizers (tools/verify-vocab.py) and, for the ban itself, live on Workers AI.
test("gpt-oss word list gives the token IDs of the tokenizer", () => {
	const v = vocab("gptoss");
	assert.deepEqual(lookup(v, "interesting", false), { usable: true, ids: [9559, 104291, 112291] });
	assert.deepEqual(lookup(v, "interesting", true).ids, [9559, 104291, 112291, 143633]);
	assert.deepEqual(lookup(v, "instead", true).ids, [7665, 21050, 64952, 152746]);
	// " prioritise" is not a single token here, so there is nothing to ban.
	assert.deepEqual(lookup(v, "prioritise", true), { usable: false, ids: [] });
	// " can't" is one token here, " can’t" with a curly apostrophe is two (so only the straight one is covered).
	assert.deepEqual(lookup(v, "can't", false).ids, [8535, 58989, 55715]);
});

test("the same word has different IDs, and is split by some tokenizers", () => {
	assert.equal(vocab("deepseek").sp.honestly, 37670);
	assert.equal(vocab("qwen").sp.honestly, 25211);
	assert.equal(lookup(vocab("deepseek"), "tapestry", false).usable, true);
	assert.equal(lookup(vocab("qwen"), "tapestry", false).usable, false);
});

test("every model that accepts logit_bias has a word list, and no other model does", () => {
	for (const m of MODELS) {
		const accepts = m.controls.some((c) => c.key === "logit_bias");
		assert.equal(Boolean(m.tokenizer), accepts, m.id);
		if (!m.tokenizer) continue;
		assert.ok(existsSync(new URL(`../public/vocab/${m.tokenizer}.json`, import.meta.url)), m.id);
	}
	assert.equal(LLAMA.tokenizer, undefined);
});

test("word lists are well formed", () => {
	for (const family of new Set(MODELS.map((m) => m.tokenizer).filter(Boolean))) {
		const v = vocab(family);
		assert.deepEqual(Object.keys(v).sort(), ["no", "sp"], family);
		for (const table of [v.sp, v.no]) {
			const entries = Object.entries(table);
			assert.ok(entries.length > 20000, family);
			assert.ok(entries.every(([w, id]) => /^[A-Za-z']+$/.test(w) && Number.isSafeInteger(id) && id >= 0), family);
		}
	}
});

test("bias built from the list passes the Worker's validation, including gpt-oss-20b's narrower range", () => {
	const v = vocab("gptoss");
	const bias = buildBias([{ w: "interesting", inside: true }, { w: "especially", inside: false }], v);
	assert.ok(Object.keys(bias).length >= 7);
	assert.ok(Object.values(bias).every((n) => n === -100));
	assert.deepEqual(sanitizeParams({ logit_bias: bias }, OSS20), { logit_bias: bias });
	assert.deepEqual(sanitizeParams({ logit_bias: bias }, OSS), { logit_bias: bias });
});

test("createWords: the list, per-model switches and the bias sent for a model", async () => {
	const storage = memory();
	const loads = [];
	const loadVocab = async (family) => {
		loads.push(family);
		return vocab(family);
	};
	const words = createWords({ storage, loadVocab });

	assert.deepEqual(await words.biasFor(OSS), {});
	assert.deepEqual(words.add("Interesting"), { word: "interesting" });
	assert.match(words.add("interesting").error, /already/);
	assert.match(words.add("two words").error, /one word/);
	words.setInside("interesting", true);

	const bias = await words.biasFor(OSS);
	assert.deepEqual(Object.keys(bias).map(Number).sort((a, b) => a - b), [9559, 104291, 112291, 143633]);
	assert.deepEqual(await words.biasFor(LLAMA), {});
	assert.deepEqual(loads, ["gptoss"]);

	words.setOn(OSS.id, false);
	assert.deepEqual(await words.biasFor(OSS), {});
	assert.equal(words.isOn(OSS20.id), true);

	// Kept on the device: a new instance reads the same list and switches.
	const again = createWords({ storage, loadVocab });
	assert.deepEqual(again.list(), [{ w: "interesting", inside: true }]);
	assert.equal(again.isOn(OSS.id), false);
	again.setOn(OSS.id, true);
	again.remove("interesting");
	assert.equal(again.count(), 0);
	assert.deepEqual(await again.biasFor(OSS), {});
	assert.equal(await again.usable(OSS, "interesting"), true);
	assert.equal(await again.usable(OSS, "prioritise"), false);
	assert.equal(await again.usable(LLAMA, "interesting"), false);
});

test("createWords ignores damaged stored data and caps the list", () => {
	const storage = memory();
	storage.set("thread.words", JSON.stringify([{ w: "Bad Word" }, { w: "fine", inside: "yes" }, null, 5]));
	storage.set("thread.words.off", "not json");
	const words = createWords({ storage });
	assert.deepEqual(words.list(), [{ w: "fine", inside: false }]);
	const letters = "abcdefghijklmnopqrstuvwxyz";
	let added = 0;
	for (let i = 0; added < MAX_WORDS - 1; i++) {
		const w = `w${letters[i % 26]}${letters[Math.floor(i / 26) % 26]}${letters[Math.floor(i / 676) % 26]}`;
		if (!words.add(w).error) added++;
	}
	assert.equal(words.count(), MAX_WORDS);
	assert.match(words.add("onetoomany").error, /limited/);
});
