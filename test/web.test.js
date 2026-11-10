import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ENGINES, MAX_RESULTS, SCREENSHOT, VIEWPORT, htmlText, isBlank, parseResults, readPage, realUrl, webSearch } from "../src/web.js";

// Real /scrape responses (trimmed to selector, text, html, top and href), captured through Browser Run in November 2026.
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/search/${name}.json`, import.meta.url), "utf8"));
const engine = (name) => ENGINES.find((e) => e.name === name);
const onDuckDuckGo = (url) => /(^|\.)duckduckgo\.com$/.test(new URL(url).hostname);
const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("DuckDuckGo: ads and their snippets are dropped, the redirect links resolve to the real pages", () => {
	const fx = fixture("ddg-html");
	const ads = fx.result[0].results.filter((r) => r.attributes[0].value.includes("y.js"));
	assert.equal(ads.length, 2, "the fixture has ads");
	const out = parseResults(engine("DuckDuckGo"), fx.result);
	assert.equal(out.length, MAX_RESULTS);
	assert.deepEqual(out[0], {
		title: "Running Shoes: Sale, Clearance & Outlet | REI Co-op",
		url: "https://www.rei.com/c/running-shoes/f/scd-deals",
		snippet: "Shop for Running Shoes on sale, discount and clearance at REI. Find a great deal on Running Shoes. 100% Satisfaction Guarantee",
	});
	assert.ok(out.every((r) => !onDuckDuckGo(r.url) && r.snippet), "no ads; every result has its snippet");
	const adSnippets = fx.result[1].results.filter((r) => r.attributes[0].value.includes("y.js")).map((r) => r.text.trim());
	assert.ok(out.every((r) => !adSnippets.includes(r.snippet)));
});

test("DuckDuckGo Lite: snippets without links are matched by position; ads and their 'more info' links are dropped", () => {
	const fx = fixture("ddg-lite");
	const out = parseResults(engine("DuckDuckGo Lite"), fx.result);
	assert.equal(out.length, MAX_RESULTS);
	assert.deepEqual(out[1], {
		title: "Car Insurance: Get a Fast Auto Quote and Save | GEICO",
		url: "https://www.geico.com/auto-insurance/",
		snippet: "Get a GEICO car insurance quote in minutes. See how much you could save with discounts and bundling, and choose coverage that fits your budget.",
	});
	assert.ok(out.every((r) => !onDuckDuckGo(r.url)));
	assert.ok(!out.some((r) => r.title === "Florida Car Insurance - Get an Auto Quote Today"), "the first link is an ad");
});

test("Brave: the title element is used, not the link's whole text", () => {
	const out = parseResults(engine("Brave"), fixture("brave").result);
	assert.equal(out.length, MAX_RESULTS);
	assert.equal(out[0].title, "Mount Everest - Wikipedia");
	assert.equal(out[0].url, "https://en.wikipedia.org/wiki/Mount_Everest");
	assert.ok(out[0].snippet.length <= 300 && out[0].snippet.endsWith("…"), "snippets are cut to 300 characters");
});

test("elements whose text comes back empty are read from their HTML", () => {
	const fx = fixture("ddg-lite");
	const blank = fx.result.map((g) => ({ ...g, results: g.results.map((r) => ({ ...r, text: "" })) }));
	assert.deepEqual(parseResults(engine("DuckDuckGo Lite"), blank), parseResults(engine("DuckDuckGo Lite"), fx.result));
	assert.equal(htmlText("<b>Tom</b> &amp; <i>Jerry</i>&#39;s &#x2014; &nbsp;x &bogus;"), " Tom  &  Jerry 's —  x &bogus;");
	assert.equal(htmlText("<scr<script>ipt>alert(1)</script>").includes("<"), false);
});

test("realUrl keeps http(s) pages and drops redirects to ads, the engines' own pages and other schemes", () => {
	assert.equal(realUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=x"), "https://example.com/a?b=1");
	assert.equal(realUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dx.com"), null);
	assert.equal(realUrl("https://duckduckgo.com/duckduckgo-help-pages/company/ads-by-microsoft-on-duckduckgo-and-private-search"), null);
	assert.equal(realUrl("//duckduckgo.com/l/?uddg=javascript%3Aalert(1)"), null);
	assert.equal(realUrl("https://search.brave.com/search?q=x"), null);
	assert.equal(realUrl("https://brave.com/download/"), "https://brave.com/download/");
});

function searchEnv(responses) {
	const calls = [];
	return {
		calls,
		env: {
			BROWSER: {
				quickAction: async (action, body) => {
					calls.push({ action, body });
					const next = responses.shift();
					if (next instanceof Error) throw next;
					return next;
				},
			},
		},
	};
}

test("web_search falls back when a page is blocked, fails or has no results, and stops at the first with results", async () => {
	const { env, calls } = searchEnv([respond(fixture("ddg-blocked")), respond({ success: false, errors: [{ message: "Navigation timeout" }] }, 422), respond(fixture("brave"))]);
	const { forModel, forUser } = await webSearch(env, { query: "  mount   everest height " });
	assert.deepEqual(calls.map((c) => c.body.url), [
		"https://html.duckduckgo.com/html/?q=mount%20everest%20height",
		"https://lite.duckduckgo.com/lite/?q=mount%20everest%20height",
		"https://search.brave.com/search?q=mount%20everest%20height&source=web",
	]);
	assert.ok(calls.every((c) => c.action === "scrape" && c.body.rejectResourceTypes.join() === "image,stylesheet,font,media"));
	assert.match(calls[2].body.userAgent, /iPhone/);
	assert.equal(calls[0].body.userAgent, undefined);
	assert.equal(forUser.engine, "Brave");
	assert.equal(forUser.query, "mount everest height");
	assert.equal(forUser.results.length, 8);
	assert.deepEqual(Object.keys(forUser.results[0]), ["title", "url"]);
	assert.match(forModel, /^Search results for “mount everest height” \(Brave\):\n\n1\. Mount Everest - Wikipedia\n {3}https:\/\/en\.wikipedia\.org\/wiki\/Mount_Everest\n {3}2 days ago/);
	assert.match(forModel, /read the most relevant pages with fetch_url/);
});

test("web_search reports no results, failures and a missing query", async () => {
	const empty = { success: true, result: [], meta: { status: 200 } };
	const none = searchEnv([respond(empty), respond(empty), respond(empty)]);
	assert.match((await webSearch(none.env, { query: "zzqx" })).forModel, /^No results for “zzqx”/);
	const broken = searchEnv([new Error("binding down"), respond({ success: false, errors: [{ message: "rate limited" }] }, 429), respond(empty)]);
	const failed = await webSearch(broken.env, { query: "x" });
	assert.match(failed.forUser.error, /DuckDuckGo: binding down; DuckDuckGo Lite: Browser Run returned HTTP 429: rate limited; Brave: no results/);
	const missing = searchEnv([]);
	assert.equal((await webSearch(missing.env, { query: "  " })).forModel, "web_search needs a query.");
	assert.equal(missing.calls.length, 0);
});

test("isBlank ignores the front matter /markdown adds", () => {
	assert.equal(isBlank('---\ntitle: "App"\n---\n\n  \n'), true);
	assert.equal(isBlank("---\ntitle: x\n---"), true);
	assert.equal(isBlank("---\ntitle: x\n---\n\nHello"), false);
	assert.equal(isBlank(""), true);
});

test("fetch_url reads Markdown without images, styles, fonts or media, and retries a blank page with everything, once the network is idle", async () => {
	const { env, calls } = searchEnv([respond({ success: true, result: '---\ntitle: "SPA"\n---\n' }), respond({ success: true, result: "# Loaded\nText" })]);
	const out = await readPage(env, { url: "https://e.com/app" }, { maxChars: 20000 });
	assert.deepEqual(calls[0], { action: "markdown", body: { url: "https://e.com/app", rejectResourceTypes: ["image", "stylesheet", "font", "media"] } });
	assert.deepEqual(calls[1], { action: "markdown", body: { url: "https://e.com/app", gotoOptions: { waitUntil: "networkidle2" } } });
	assert.equal(out.forModel, "# Loaded\nText");
	assert.deepEqual(out.forUser, { url: "https://e.com/app", chars: 13 });
	assert.equal(out.image, undefined);

	const blank = searchEnv([respond({ success: true, result: "" }), respond({ success: true, result: "  " })]);
	assert.equal((await readPage(blank.env, { url: "https://e.com" }, { maxChars: 100 })).forModel, "(the page had no readable content)");
});

test("fetch_url returns long pages in parts, each saying where the next starts", async () => {
	const page = "a".repeat(5000) + "b".repeat(5000) + "c".repeat(2000);
	const read = async (args) => {
		const { env, calls } = searchEnv([respond({ success: true, result: page })]);
		return { ...(await readPage(env, { url: "https://e.com", ...args }, { maxChars: 5000 })), calls };
	};
	const first = await read({});
	assert.equal(first.forModel, `${"a".repeat(5000)}\n… [7,000 more characters: call fetch_url with start 5000 to read on]`);
	assert.deepEqual(first.forUser, { url: "https://e.com/", chars: 12000 });
	const second = await read({ start: 5000 });
	assert.equal(second.forModel, `[Characters 5,000 to 10,000 of 12,000]\n\n${"b".repeat(5000)}\n… [2,000 more characters: call fetch_url with start 10000 to read on]`);
	assert.equal(second.forUser.start, 5000);
	assert.equal((await read({ start: "10000" })).forModel, `[Characters 10,000 to 12,000 of 12,000]\n\n${"c".repeat(2000)}`);
	assert.equal((await read({ start: 12000 })).forModel, "The page has 12,000 characters, so there is nothing from start 12,000 on.");
	for (const start of [-1, 1.5, "x", true]) {
		const bad = await read({ start });
		assert.equal(bad.forModel, "start must be a whole number of characters, 0 or more.", String(start));
		assert.equal(bad.calls.length, 0);
	}
});

test("show_page: vision models get one /snapshot with Markdown and a JPEG; other models ignore it", async () => {
	const { env, calls } = searchEnv([respond({ success: true, result: { markdown: "# Page", screenshot: "/9j/AAAA" }, meta: { status: 200 } })]);
	const out = await readPage(env, { url: "https://e.com", show_page: true }, { vision: true, maxChars: 20000 });
	assert.deepEqual(calls[0], {
		action: "snapshot",
		body: { url: "https://e.com/", formats: ["markdown", "screenshot"], screenshotOptions: { type: "jpeg", quality: 70 }, viewport: { width: 1280, height: 800 } },
	});
	assert.deepEqual([SCREENSHOT, VIEWPORT], [{ type: "jpeg", quality: 70 }, { width: 1280, height: 800 }]);
	assert.equal(out.image, "data:image/jpeg;base64,/9j/AAAA");
	assert.equal(out.forUser.screenshot, "/9j/AAAA");
	assert.match(out.forModel, /^# Page\n\n\[A screenshot of the top of the page \(1280×800\) follows in a separate message\.\]$/);

	const text = searchEnv([respond({ success: true, result: "# Page" })]);
	const plain = await readPage(text.env, { url: "https://e.com", show_page: true }, { vision: false, maxChars: 20000 });
	assert.equal(text.calls[0].action, "markdown");
	assert.equal(plain.image, undefined);
});

test("Browser Run errors carry the service's message", async () => {
	const { env } = searchEnv([respond({ success: false, errors: [{ code: 2001, message: "net::ERR_NAME_NOT_RESOLVED" }] }, 422)]);
	await assert.rejects(readPage(env, { url: "https://nope.invalid" }, { maxChars: 100 }), /Browser Run returned HTTP 422: net::ERR_NAME_NOT_RESOLVED/);
});
