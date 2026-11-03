import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PAGE_IDS, checkPage } from "../public/page.js";

const pub = new URL("../public/", import.meta.url);
const html = readFileSync(new URL("index.html", pub), "utf8");
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

test("PAGE_IDS covers every element id the scripts look up, and index.html has them all", () => {
	const looked = new Set();
	for (const file of readdirSync(pub).filter((f) => f.endsWith(".js"))) {
		const src = readFileSync(new URL(file, pub), "utf8");
		for (const m of src.matchAll(/(?:\$|getElementById)\("([^"]+)"\)/g)) looked.add(m[1]);
	}
	assert.ok(looked.size > 40, "the lookup pattern still finds the scripts' ids");
	assert.deepEqual([...looked].filter((id) => !PAGE_IDS.includes(id)), [], "ids looked up but missing from PAGE_IDS");
	assert.deepEqual(PAGE_IDS.filter((id) => !htmlIds.has(id)), [], "ids in PAGE_IDS but missing from index.html");
});

function fakePage(ids, search = "") {
	const calls = { replace: [], replaceState: [], shown: null };
	const doc = {
		getElementById: (id) => (ids.has(id) ? {} : null),
		createElement: (tag) => ({ tag, children: [], append(...c) { this.children.push(...c); }, addEventListener() {} }),
		body: { replaceChildren: (node) => (calls.shown = node) },
	};
	const loc = { search, replace: (u) => calls.replace.push(u) };
	const hist = { replaceState: (_s, _t, u) => calls.replaceState.push(u) };
	return { doc, loc, hist, calls };
}

test("checkPage passes a matching page and drops the reload marker from the address", () => {
	const p = fakePage(new Set(PAGE_IDS));
	assert.equal(checkPage(p.doc, p.loc, p.hist), true);
	assert.deepEqual(p.calls.replace, []);
	assert.deepEqual(p.calls.replaceState, []);
	const after = fakePage(new Set(PAGE_IDS), "?fresh=123");
	assert.equal(checkPage(after.doc, after.loc, after.hist), true);
	assert.deepEqual(after.calls.replaceState, ["/"]);
});

test("checkPage reloads a mismatched page once, then shows a message instead of reloading again", () => {
	const stale = new Set(PAGE_IDS.filter((id) => id !== "prefsBtn"));
	const first = fakePage(stale);
	assert.equal(checkPage(first.doc, first.loc, first.hist), false);
	assert.equal(first.calls.replace.length, 1);
	assert.match(first.calls.replace[0], /^\/\?fresh=\d+$/);
	assert.equal(first.calls.shown, null);

	const second = fakePage(stale, "?fresh=123");
	assert.equal(checkPage(second.doc, second.loc, second.hist), false);
	assert.deepEqual(second.calls.replace, []);
	assert.equal(second.calls.shown.className, "lock");
});
