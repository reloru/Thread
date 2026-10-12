// Builds public/vocab/<family>.json: the tokens of a model family's published tokenizer that are one plain word,
// so the app can turn a banned word into token IDs by lookup. No dependencies.
//
//   node tools/build-vocab.mjs hf <tokenizer.json> <family>        (Hugging Face byte-level or ▁ BPE tokenizers)
//   node tools/build-vocab.mjs tiktoken <tiktoken.model> <family>  (Kimi)
//
// Output: { "sp": { "word": id }, "no": { "word": id } }. "sp" holds tokens that start with a space (" word"),
// "no" holds tokens that do not ("word", "Word"). Only ASCII letters and straight apostrophes are kept.
// Then run tools/verify-vocab.py with --prune: it checks every entry against the real tokenizer (needs the
// `tokenizers` and `tiktoken` packages) and drops the few the tokenizer never produces.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const [kind, input, family] = process.argv.slice(2);
if (!["hf", "tiktoken"].includes(kind) || !input || !family) {
	console.error("usage: node tools/build-vocab.mjs hf|tiktoken <file> <family>");
	process.exit(1);
}

const WORD = /^[A-Za-z']+$/;
const sp = {};
const no = {};
const add = (token, id) => {
	// "Ġ" (byte-level) and "▁" (SentencePiece style) both stand for a leading space.
	const spaced = token[0] === "Ġ" || token[0] === "▁";
	const text = spaced ? token.slice(1) : token;
	if (!WORD.test(text)) return;
	(spaced ? sp : no)[text] = id;
};

if (kind === "hf") {
	const vocab = JSON.parse(readFileSync(input, "utf8")).model.vocab;
	for (const [token, id] of Object.entries(vocab)) add(token, id);
} else {
	// Each line is "<base64 bytes> <rank>"; the rank is the token ID.
	for (const line of readFileSync(input, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const [b64, rank] = line.split(" ");
		const bytes = Buffer.from(b64, "base64");
		if (bytes.some((b) => b > 127)) continue;
		add(bytes.toString("latin1").replace(/^ /, "▁"), Number(rank));
	}
}

mkdirSync(new URL("../public/vocab/", import.meta.url), { recursive: true });
const out = new URL(`../public/vocab/${family}.json`, import.meta.url);
writeFileSync(out, JSON.stringify({ sp, no }) + "\n");
console.log(`${family}: ${Object.keys(sp).length} spaced, ${Object.keys(no).length} unspaced`);
