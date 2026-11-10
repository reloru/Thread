// The Web tools, both through Browser Run Quick Actions: web_search (a results page scraped with /scrape) and
// fetch_url (/markdown, or /snapshot when a vision model asks to see the page).

// Page parts the text doesn't need; leaving them out saves browser time.
const LEAN = ["image", "stylesheet", "font", "media"];
export const MAX_RESULTS = 8;
const MAX_SNIPPET = 300;
const MAX_TITLE = 200;
const SEARCH_TIMEOUT_MS = 10000;
const IPHONE_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
export const SCREENSHOT = { type: "jpeg", quality: 70 };
export const VIEWPORT = { width: 1280, height: 800 };

/**
 * Results pages tried in order until one gives results. A page that answers with a status other than 200 (DuckDuckGo
 * sends 202 with a CAPTCHA for some queries), fails, or yields nothing moves on to the next. Each result is a `link`
 * element (its href is the result), with the `title` and `snippet` elements below it on the page; they are matched to
 * the link above them by their position, since some layouts (DuckDuckGo Lite) don't nest them in one element.
 * Left out: Google blocks Browser Run ("unusual traffic"), Mojeek shows a CAPTCHA, Startpage came back empty, Yahoo
 * is mostly ads. Bing's results for 4 of 6 test queries of several words mentioned none of the words after the first
 * ("James 1 NIV" for "james webb telescope discoveries"), which would look like a successful search.
 */
export const ENGINES = [
	{
		name: "DuckDuckGo",
		url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
		link: "a.result__a",
		snippet: "a.result__snippet",
	},
	{
		name: "DuckDuckGo Lite",
		url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
		link: "a.result-link",
		snippet: "td.result-snippet",
	},
	{
		// Empty with the default (desktop Chrome) user agent, full results with an iPhone one.
		name: "Brave",
		url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`,
		link: 'div.snippet[data-type="web"] a.l1',
		title: 'div.snippet[data-type="web"] .search-snippet-title',
		snippet: 'div.snippet[data-type="web"] .generic-snippet .content',
		userAgent: IPHONE_UA,
	},
];

/** Calls a Quick Action. Returns its JSON body ({ result, meta }); throws with the service's message on an error. */
export async function quick(env, action, body) {
	let out = await env.BROWSER.quickAction(action, body);
	if (out instanceof Response) {
		const type = out.headers.get("content-type") || "";
		const data = type.includes("json") ? await out.json().catch(() => null) : await out.text();
		if (!out.ok) throw new Error(`Browser Run returned HTTP ${out.status}${serviceError(data)}`);
		out = data;
	}
	if (typeof out === "string") return { result: out };
	if (out && out.success === false) throw new Error(`Browser Run: ${serviceError(out).slice(2) || "the request failed"}`);
	if (out && typeof out === "object" && "result" in out) return out;
	throw new Error("Browser Run returned an unexpected result.");
}

function serviceError(data) {
	const message = data?.errors?.[0]?.message;
	return typeof message === "string" && message ? `: ${message.slice(0, 300)}` : "";
}

const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// Plain text of an element's HTML, for when /scrape returns its text empty (seen on Bing, where every element's
// text came back empty while its HTML was there). The result is only ever used as text.
export function htmlText(html) {
	let text = String(html ?? "");
	for (let prev = null; prev !== text; ) {
		prev = text;
		text = text.replace(/<[^>]*>/g, " ");
	}
	return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, name) => {
		if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? entity;
		const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
	});
}

const textOf = (el) => clean(el.text) || clean(htmlText(el.html));
const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const host = (name, domain) => name === domain || name.endsWith(`.${domain}`);

/** The page a results link leads to, or null for ads, the engine's own pages and anything that isn't http(s). */
export function realUrl(href) {
	let url;
	try {
		url = new URL(href, "https://duckduckgo.com/");
	} catch {
		return null;
	}
	// DuckDuckGo: //duckduckgo.com/l/?uddg=<the URL, percent-encoded>. Ads lead to duckduckgo.com/y.js, dropped below.
	if (host(url.hostname, "duckduckgo.com") && url.pathname === "/l/") {
		const target = url.searchParams.get("uddg");
		return target ? realUrl(target) : null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (host(url.hostname, "duckduckgo.com") || host(url.hostname, "search.brave.com")) return null;
	return url.href;
}

/** Turns a /scrape result for `engine` into at most MAX_RESULTS { title, url, snippet }, in page order. */
export function parseResults(engine, scraped) {
	const found = new Map((Array.isArray(scraped) ? scraped : []).map((g) => [g.selector, Array.isArray(g.results) ? g.results : []]));
	const rows = (found.get(engine.link) || [])
		.map((el) => ({ top: Number(el.top) || 0, href: el.attributes?.find((a) => a.name === "href")?.value, title: textOf(el), snippet: "" }))
		.sort((a, b) => a.top - b.top);
	// The last link at or above an element owns it, so an ad's snippet goes with the ad and is dropped with it.
	const owner = (top) => {
		let row = null;
		for (const r of rows) {
			if (r.top > top) break;
			row = r;
		}
		return row;
	};
	const attach = (selector, field) => {
		const done = new Set();
		for (const el of found.get(selector) || []) {
			const row = owner(Number(el.top) || 0);
			if (!row || done.has(row)) continue;
			done.add(row);
			row[field] = textOf(el);
		}
	};
	if (engine.title) attach(engine.title, "title");
	attach(engine.snippet, "snippet");
	const out = [];
	const seen = new Set();
	for (const row of rows) {
		const url = realUrl(row.href);
		if (!url || !row.title || seen.has(url)) continue;
		seen.add(url);
		out.push({ title: cut(row.title, MAX_TITLE), url, snippet: cut(row.snippet, MAX_SNIPPET) });
		if (out.length === MAX_RESULTS) break;
	}
	return out;
}

/** web_search: the results of the first engine that gives some. Returns { forModel, forUser }. */
export async function webSearch(env, args) {
	const query = typeof args.query === "string" ? clean(args.query) : "";
	if (!query) {
		const msg = "web_search needs a query.";
		return { forModel: msg, forUser: { query: "", error: msg } };
	}
	const failures = [];
	for (const engine of ENGINES) {
		let results;
		try {
			const out = await quick(env, "scrape", {
				url: engine.url(query),
				elements: [engine.link, engine.title, engine.snippet].filter(Boolean).map((selector) => ({ selector })),
				rejectResourceTypes: LEAN,
				gotoOptions: { timeout: SEARCH_TIMEOUT_MS },
				...(engine.userAgent ? { userAgent: engine.userAgent } : {}),
			});
			const status = out.meta?.status;
			if (status && status !== 200) {
				failures.push(`${engine.name}: HTTP ${status}`);
				continue;
			}
			results = parseResults(engine, out.result);
		} catch (err) {
			failures.push(`${engine.name}: ${err?.message || String(err)}`);
			continue;
		}
		if (!results.length) {
			failures.push(`${engine.name}: no results`);
			continue;
		}
		const list = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n");
		return {
			forModel: `Search results for “${query}” (${engine.name}):\n\n${list}\n\nSnippets are short and can be out of date: read the most relevant pages with fetch_url before relying on them.`,
			forUser: { query, engine: engine.name, results: results.map(({ title, url }) => ({ title, url })) },
		};
	}
	const none = failures.every((f) => f.endsWith(": no results"));
	const msg = none ? `No results for “${query}”. Try other words.` : `The search failed (${failures.join("; ")}).`;
	return { forModel: msg, forUser: { query, error: msg } };
}

// /markdown and /snapshot start the Markdown with YAML front matter (the page title) when the page has metadata.
const FRONT_MATTER = /^---\n[\s\S]*?\n---(\n|$)/;
export const isBlank = (markdown) => !String(markdown ?? "").replace(FRONT_MATTER, "").trim();

/**
 * fetch_url. options: { vision, maxChars }. show_page (vision models only) loads the page once through /snapshot for
 * the Markdown and a JPEG of the top of the page together. A page with no text is loaded again, with everything it
 * asks for and waiting until the network is nearly idle, for pages that draw their content with JavaScript: in testing,
 * crates.io came back empty without its stylesheets and fonts even then, and with 5,825 characters with them.
 * Returns { forModel, forUser, image? }: image is a data URL for the loop to show the model.
 */
export async function readPage(env, args, { vision = false, maxChars }) {
	let url;
	try {
		url = new URL(args.url);
	} catch {
		url = null;
	}
	if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
		const msg = "fetch_url needs an absolute http(s) URL.";
		return { forModel: msg, forUser: { error: msg } };
	}
	const showPage = vision && args.show_page === true;
	const load = async (retry) => {
		const wait = retry ? { gotoOptions: { waitUntil: "networkidle2" } } : {};
		if (showPage) {
			const out = await quick(env, "snapshot", { url: url.href, formats: ["markdown", "screenshot"], screenshotOptions: SCREENSHOT, viewport: VIEWPORT, ...wait });
			return { markdown: typeof out.result?.markdown === "string" ? out.result.markdown : "", screenshot: typeof out.result?.screenshot === "string" ? out.result.screenshot : "" };
		}
		const out = await quick(env, "markdown", { url: url.href, ...(retry ? wait : { rejectResourceTypes: LEAN }) });
		return { markdown: typeof out.result === "string" ? out.result : "", screenshot: "" };
	};
	let page = await load(false);
	if (isBlank(page.markdown)) page = await load(true);
	const text = page.markdown.trim();
	const body = isBlank(text) ? "(the page had no readable content)" : truncate(text, maxChars);
	const screenshot = page.screenshot;
	return {
		forModel: screenshot ? `${body}\n\n[A screenshot of the top of the page (1280×800) follows in a separate message.]` : body,
		forUser: { url: url.href, chars: text.length, ...(screenshot ? { screenshot } : {}) },
		...(screenshot ? { image: `data:image/jpeg;base64,${screenshot}` } : {}),
	};
}

export const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]` : text);
