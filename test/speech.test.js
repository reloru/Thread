import { test } from "node:test";
import assert from "node:assert/strict";
import { createChunker, toSpeech } from "../public/speech.js";

function chunks(text, step = 7, options) {
	const c = createChunker(options);
	const out = [];
	for (let i = 0; i < text.length; i += step) out.push(...c.push(text.slice(i, i + step)));
	out.push(...c.flush());
	return out;
}

test("toSpeech strips markdown but keeps the words", () => {
	assert.equal(toSpeech("**Hello** _there_, see [the docs](https://x.com/a)!"), "Hello there, see the docs!");
	assert.equal(toSpeech("# Title\n\n## Sub heading"), "Title\n\nSub heading");
	assert.equal(toSpeech("- one\n- two\n* three\n1. four\n2) five"), "one\ntwo\nthree\nfour\nfive");
	assert.equal(toSpeech("> quoted text"), "quoted text");
	assert.equal(toSpeech("Use `npm test` now."), "Use npm test now.");
	assert.equal(toSpeech("~~old~~ new"), "old new");
	assert.equal(toSpeech("![a cat](https://x.com/c.png) is here"), "a cat is here");
});

test("toSpeech reads links as a host, drops code fences, emoji and table scaffolding", () => {
	assert.equal(toSpeech("Visit https://www.example.com/a/b?c=d now."), "Visit example.com now.");
	assert.equal(toSpeech("Before\n```py\nprint(1)\n```\nAfter"), "Before\n\nAfter");
	assert.equal(toSpeech("Great 😀 job 👍🏽!"), "Great job !");
	assert.equal(toSpeech("| a | b |\n| --- | --- |\n| 1 | 2 |"), "a, b\n1, 2");
	assert.equal(toSpeech("snake_case_name and 2 * 3 * 4 stay"), "snake_case_name and 2 * 3 * 4 stay");
	assert.equal(toSpeech("<b>bold</b> text"), "bold text");
});

test("chunker splits at sentence ends, however the text is cut into deltas", () => {
	const text = "The capital of France is Paris. It has been the capital for centuries! Would you like to know more?";
	for (const step of [1, 3, 7, 50, 500]) {
		assert.deepEqual(chunks(text, step), [
			"The capital of France is Paris.",
			"It has been the capital for centuries!",
			"Would you like to know more?",
		], `step ${step}`);
	}
});

test("chunker does not split inside numbers or after short abbreviations", () => {
	assert.deepEqual(chunks("Pi is about 3.14159 and e is 2.71828. That is all, folks."), ["Pi is about 3.14159 and e is 2.71828.", "That is all, folks."]);
	assert.deepEqual(chunks("Ask Dr. Smith about it today. Thanks."), ["Ask Dr. Smith about it today.", "Thanks."]);
});

test("chunker lets the first chunk be short and joins later short fragments", () => {
	assert.deepEqual(chunks("Hello there. How can I help you today? I can answer questions."), [
		"Hello there.",
		"How can I help you today? I can answer questions.",
	]);
	assert.deepEqual(chunks("Sure. Yes. Okay then. Let me explain how this works in detail."), [
		"Sure. Yes. Okay then.",
		"Let me explain how this works in detail.",
	]);
});

test("chunker skips fenced code blocks, even when the fence is split across deltas", () => {
	const text = "Here is code:\n```python\nprint('hi.')\nx = 1\n```\nThat prints a greeting.";
	for (const step of [1, 2, 5, 100]) assert.deepEqual(chunks(text, step), ["Here is code:", "That prints a greeting."], `step ${step}`);
	assert.deepEqual(chunks("Start.\n```\nnever closed"), ["Start."]);
});

test("chunker drops list markers and puts a full stop between unpunctuated lines", () => {
	assert.deepEqual(chunks("Options:\n- Apples are red and tasty\n- Bananas are yellow and sweet\n\nPick one."), [
		"Options: Apples are red and tasty",
		"Bananas are yellow and sweet. Pick one.",
	]);
});

test("chunker breaks very long sentences at clauses and never exceeds the limit", () => {
	const clause = "this clause keeps going and going without a full stop";
	const text = Array.from({ length: 12 }, () => clause).join(", ") + ".";
	const out = chunks(text, 11, { maxChars: 120 });
	assert.ok(out.length > 4);
	for (const c of out) assert.ok(c.length <= 120, `${c.length}: ${c}`);
	assert.equal(out.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
});

test("chunker flush speaks an unfinished last sentence and nothing is lost or reordered", () => {
	const c = createChunker();
	assert.deepEqual(c.push("Hello there, this is the beginning"), []);
	assert.deepEqual(c.flush(), ["Hello there, this is the beginning"]);
	assert.deepEqual(c.flush(), []);
	const spoken = chunks("One short. Two short. Three is a little longer than the others. Four. Five is also fairly long here. Six.");
	assert.equal(spoken.join(" "), "One short. Two short. Three is a little longer than the others. Four. Five is also fairly long here. Six.");
});

test("chunker ignores text with nothing speakable", () => {
	assert.deepEqual(chunks("😀 😀\n\n---\n"), []);
	assert.deepEqual(chunks("```\ncode only\n```"), []);
});

test("chunker records how much of the raw text each chunk covers, so an interrupted reply can be cut there", () => {
	const text = "**First** sentence is here. Second sentence follows right after! Third one ends it.";
	for (const step of [1, 4, 9, 200]) {
		const c = createChunker();
		const out = [];
		for (let i = 0; i < text.length; i += step) out.push(...c.push(text.slice(i, i + step)));
		out.push(...c.flush());
		assert.equal(out.length, 3, `step ${step}`);
		assert.deepEqual(c.ends.length, 3);
		assert.ok(c.ends[0] < c.ends[1] && c.ends[1] < c.ends[2], `step ${step}: ${c.ends}`);
		assert.equal(text.slice(0, c.ends[0]).trim(), "**First** sentence is here.");
		assert.equal(text.slice(0, c.ends[1]).trim(), "**First** sentence is here. Second sentence follows right after!");
		assert.equal(c.ends[2], text.length);
	}
});

test("chunker starts a long first sentence at its first clause, then continues normally", () => {
	const text = "There was once a dragon named Scorch who lived in a far-off land, and he was known for his fiery breath and love of treasure. One day he found a bakery.";
	for (const step of [1, 6, 400]) {
		assert.deepEqual(chunks(text, step), [
			"There was once a dragon named Scorch who lived in a far-off land,",
			"and he was known for his fiery breath and love of treasure.",
			"One day he found a bakery.",
		], `step ${step}`);
	}
	assert.deepEqual(chunks("Short opening sentence, then more words follow it here. Next."), ["Short opening sentence, then more words follow it here.", "Next."]);
});
