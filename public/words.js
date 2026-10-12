// Banned words. A word is turned into token IDs for the model in use by looking it up in that model's
// tokenizer word list (public/vocab/<family>.json, built by tools/build-vocab.mjs), and sent as logit_bias
// with -100, which stops the model from writing those tokens. Shared by the app and the tests.

export const MAX_WORDS = 200;
const BAN = -100;
const VALID = /^[a-z][a-z']{2,39}$/;

/** A word as stored (lowercase, straight apostrophes), or null when it is not one plain word. */
export function cleanWord(input) {
	const w = String(input ?? "")
		.trim()
		.toLowerCase()
		.replace(/[‘’]/g, "'");
	return VALID.test(w) ? w : null;
}

/**
 * The spellings that are banned: " word" and " Word" (inside a sentence), and "Word" (a sentence or line start).
 * `inside` adds "word" with no space before it, which is how it appears after a bracket, a quote or ** (and in code).
 * Each is [table, key]: "sp" tokens start with a space, "no" tokens do not.
 */
export function formsOf(word, inside) {
	const cap = word[0].toUpperCase() + word.slice(1);
	const forms = [["sp", word], ["sp", cap], ["no", cap]];
	if (inside) forms.push(["no", word]);
	return forms;
}

const has = (table, key) => Object.hasOwn(table, key);

/**
 * Token IDs for a word in one tokenizer's word list. Only spellings that are a single token can be banned: a
 * spelling the tokenizer splits into pieces would mean banning the pieces, which other words use too. When
 * " word" itself is split, the word is not usable on this model (usable: false, no IDs).
 */
export function lookup(vocab, word, inside) {
	if (!has(vocab.sp, word)) return { usable: false, ids: [] };
	const ids = formsOf(word, inside)
		.filter(([table, key]) => has(vocab[table], key))
		.map(([table, key]) => vocab[table][key]);
	return { usable: true, ids: [...new Set(ids)] };
}

/** logit_bias for a list of { w, inside } against one tokenizer's word list. */
export function buildBias(list, vocab) {
	const bias = {};
	for (const { w, inside } of list) for (const id of lookup(vocab, w, inside).ids) bias[id] = BAN;
	return bias;
}

const KEY_WORDS = "thread.words";
const KEY_OFF = "thread.words.off";

const cache = new Map();
function fetchVocab(family) {
	if (!cache.has(family)) {
		const loading = fetch(`/vocab/${family}.json`).then((res) => {
			if (!res.ok) throw new Error(`Couldn't load the word list for ${family}.`);
			return res.json();
		});
		cache.set(family, loading);
		loading.catch(() => cache.delete(family));
	}
	return cache.get(family);
}

/** deps: { storage, loadVocab? }. The list is kept on this device; the off switches are per model. */
export function createWords({ storage, loadVocab = fetchVocab }) {
	const readJson = (key) => {
		try {
			const data = JSON.parse(storage.get(key) || "[]");
			return Array.isArray(data) ? data : [];
		} catch {
			return [];
		}
	};
	let list = readJson(KEY_WORDS).filter((e) => e && typeof e.w === "string" && cleanWord(e.w) === e.w).map((e) => ({ w: e.w, inside: e.inside === true }));
	let off = new Set(readJson(KEY_OFF).filter((id) => typeof id === "string"));
	const saveList = () => storage.set(KEY_WORDS, JSON.stringify(list));

	return {
		list: () => list.map((e) => ({ ...e })),
		count: () => list.length,
		/** Returns { word } on success or { error }. */
		add(input) {
			const w = cleanWord(input);
			if (!w) return { error: "Enter one word, using letters and apostrophes (3 to 40 characters)." };
			if (list.some((e) => e.w === w)) return { error: `“${w}” is already on the list.` };
			if (list.length >= MAX_WORDS) return { error: `The list is limited to ${MAX_WORDS} words.` };
			list.push({ w, inside: false });
			saveList();
			return { word: w };
		},
		remove(w) {
			list = list.filter((e) => e.w !== w);
			saveList();
		},
		setInside(w, inside) {
			const entry = list.find((e) => e.w === w);
			if (entry) entry.inside = inside;
			saveList();
		},
		isOn: (modelId) => !off.has(modelId),
		setOn(modelId, on) {
			if (on) off.delete(modelId);
			else off.add(modelId);
			storage.set(KEY_OFF, JSON.stringify([...off]));
		},
		/** logit_bias for a model: {} when it has no tokenizer, the list is empty or banned words are off for it. */
		async biasFor(model) {
			if (!model.tokenizer || !list.length || off.has(model.id)) return {};
			return buildBias(list, await loadVocab(model.tokenizer));
		},
		/** Whether a word can be banned on this model (it is a single token there). */
		async usable(model, w) {
			if (!model.tokenizer) return false;
			return lookup(await loadVocab(model.tokenizer), w, false).usable;
		},
	};
}
