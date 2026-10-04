import { test } from "node:test";
import assert from "node:assert/strict";
import { healStreaming, renderMarkdown } from "../public/markdown.js";

test("escapes raw HTML", () => {
	const html = renderMarkdown('<script>alert(1)</script>\n<img src=x onerror="alert(1)">');
	assert.ok(!html.includes("<script"));
	assert.ok(!html.includes("<img"));
	assert.ok(html.includes("&lt;script&gt;"));
});

test("only allows http(s) and mailto links", () => {
	assert.match(renderMarkdown("[a](https://a.com?x=1&y=2)"), /<a href="https:\/\/a\.com\?x=1&amp;y=2"/);
	assert.match(renderMarkdown("[m](mailto:a@b.co)"), /<a href="mailto:a@b\.co"/);
	for (const bad of ["[x](javascript:alert(1))", "[x](data:text/html,hi)", "[x](vbscript:1)"]) {
		assert.ok(!renderMarkdown(bad).includes("<a "), bad);
	}
});

test("link text cannot break out of attributes", () => {
	const html = renderMarkdown('[x](https://a.com" onmouseover="alert(1))');
	assert.ok(!/<a [^>]*onmouseover/.test(html));
});

test("code blocks are escaped and labeled", () => {
	const html = renderMarkdown('```js\nconst a = "<b>";\n```');
	assert.match(html, /<span>js<\/span>/);
	assert.match(html, /const a = &quot;&lt;b&gt;&quot;;/);
});

test("unclosed fence renders as code while streaming", () => {
	assert.match(renderMarkdown("```py\nprint(1)"), /<pre><code>print\(1\)<\/code><\/pre>/);
});

test("fence language cannot inject markup", () => {
	const html = renderMarkdown("```<img/onerror=alert(1)>\nx\n```");
	assert.ok(!html.includes("<img"));
});

test("inline formatting", () => {
	assert.equal(
		renderMarkdown("**b** *i* `c<` ~~s~~"),
		"<p><strong>b</strong> <em>i</em> <code>c&lt;</code> <del>s</del></p>",
	);
	assert.equal(renderMarkdown("snake_case_name and 2*3*4"), "<p>snake_case_name and 2*3*4</p>");
});

test("tight nested lists", () => {
	assert.equal(
		renderMarkdown("- a\n- b\n  - c\n- d\n\n1. one\n2. two"),
		"<ul><li>a</li><li>b<ul><li>c</li></ul></li><li>d</li></ul><ol><li>one</li><li>two</li></ol>",
	);
});

test("ordered list start number", () => {
	assert.match(renderMarkdown("3. x\n4. y"), /^<ol start="3">/);
});

test("tables with alignment and escaped pipes in code", () => {
	const html = renderMarkdown("| A | B |\n|:--|--:|\n| 1 | `x|y` |");
	assert.match(html, /<th class="align-left">A<\/th><th class="align-right">B<\/th>/);
	assert.match(html, /<td class="align-right"><code>x\|y<\/code><\/td>/);
});

test("headings, quotes, rules, autolinks", () => {
	const html = renderMarkdown("## T\n\n> q\n\n---\n\nsee https://ex.com/a.");
	assert.match(html, /<h2>T<\/h2>/);
	assert.match(html, /<blockquote><p>q<\/p><\/blockquote>/);
	assert.match(html, /<hr>/);
	assert.match(html, /<a href="https:\/\/ex\.com\/a"[^>]*>https:\/\/ex\.com\/a<\/a>\./);
});

test("strips NUL so placeholders cannot be forged", () => {
	const html = renderMarkdown("`<x>` \u00000\u0000");
	assert.ok(!html.includes("\u0000"));
	assert.equal((html.match(/<code>/g) || []).length, 1);
});

test("deep nesting does not overflow the stack", () => {
	assert.doesNotThrow(() => renderMarkdown("- ".repeat(20000) + "x"));
	assert.doesNotThrow(() => renderMarkdown(">".repeat(20000) + " x"));
});

test("pathological inputs render in linear time", () => {
	const inputs = [
		"# a" + " ".repeat(200000) + "b",
		"x " + "`".repeat(200000),
		"[".repeat(200000),
		"[x](https://a.com/" + "(".repeat(50000),
		"https://" + "a".repeat(200000),
		"**a ".repeat(25000),
		"~".repeat(200000) + "`",
		"```" + "a".repeat(200000) + "`",
		"a|b\n|---" + " ".repeat(200000) + "x",
		"- " + "~".repeat(20000) + "`",
	];
	for (const input of inputs) {
		const start = performance.now();
		renderMarkdown(input);
		assert.ok(performance.now() - start < 1000, `${input.slice(0, 20)}… took too long`);
	}
});

test("placeholder tokens never land inside an href", () => {
	for (const src of ["see https://a.com`code`", "https://a.com[x](https://b.com/x)", "[x](https://a.com`y`)"]) {
		const html = renderMarkdown(src);
		for (const [, href] of html.matchAll(/href="([^"]*)"/g)) assert.ok(!/[<>]/.test(href), `${src} -> ${href}`);
	}
});

test("tabs inside fenced code are kept", () => {
	assert.match(renderMarkdown("```make\nall:\n\techo hi\n```"), /all:\n\techo hi/);
});

test("headings keep a trailing # that is part of a word", () => {
	assert.equal(renderMarkdown("## Learn C#"), "<h2>Learn C#</h2>");
	assert.equal(renderMarkdown("## Title ##"), "<h2>Title</h2>");
});

test("links with parentheses, bold URLs, bracketed labels", () => {
	assert.match(renderMarkdown("[w](https://en.wikipedia.org/wiki/Foo_(bar))"), /href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"/);
	assert.match(renderMarkdown("see https://e.org/Foo_(bar) now"), /href="https:\/\/e\.org\/Foo_\(bar\)"[^>]*>[^<]*<\/a> now/);
	assert.match(renderMarkdown("(see https://e.org/x)"), /href="https:\/\/e\.org\/x"/);
	assert.match(renderMarkdown("**https://x.com**"), /<strong><a href="https:\/\/x\.com"/);
	assert.match(renderMarkdown("[[1]](https://x.com)"), /<a href="https:\/\/x\.com"[^>]*>\[1\]<\/a>/);
	assert.match(renderMarkdown("[x](https://a.com/?q=1&amp;r=2)"), /href="https:\/\/a\.com\/\?q=1&amp;r=2"/);
});

test("an unpaired backtick does not merge table cells", () => {
	assert.match(renderMarkdown("| a | b | c |\n|---|---|---|\n| x` | y | z |"), /<td>x`<\/td><td>y<\/td><td>z<\/td>/);
});

test("character references render as characters in text but not in code", () => {
	assert.equal(renderMarkdown("a&nbsp;b &copy; & x"), "<p>a&nbsp;b &copy; &amp; x</p>");
	assert.match(renderMarkdown("`&nbsp;`"), /<code>&amp;nbsp;<\/code>/);
});

test("code spans pair runs of equal length", () => {
	assert.equal(renderMarkdown("use ``a ` b`` and `c`"), "<p>use <code>a ` b</code> and <code>c</code></p>");
});

test("tabs survive in fences nested in lists and quotes", () => {
	for (const src of [
		"- step\n\n    ```make\n    all:\n    \techo hi\n    ```",
		"- ```make\n  all:\n  \techo hi\n  ```",
		"> ```make\n> all:\n> \techo hi\n> ```",
	]) {
		assert.match(renderMarkdown(src), /all:\n\techo hi/, src);
	}
	assert.equal(renderMarkdown("-\titem one\n-\titem two"), "<ul><li>item one</li><li>item two</li></ul>");
});

test("&amp; in bare and angle-bracket autolinks is decoded once", () => {
	const html = renderMarkdown("https://a.com/?q=1&amp;r=2 and <https://b.com/?x=1&amp;y=2>");
	assert.match(html, /href="https:\/\/a\.com\/\?q=1&amp;r=2"/);
	assert.match(html, /href="https:\/\/b\.com\/\?x=1&amp;y=2"/);
});

const visibleText = (html) => html.replace(/<[^>]*>/g, "");

test("healStreaming completes an unfinished span in the last paragraph", () => {
	const cases = [
		["intention: *\u201cMay the day begin", "<em>\u201cMay the day begin</em>"],
		["**bold unfinished", "<strong>bold unfinished</strong>"],
		["a `code unfinished", "<code>code unfinished</code>"],
		["~~struck", "<del>struck</del>"],
		["_half emphasis", "<em>half emphasis</em>"],
		["- item *em", "<em>em</em>"],
		["first\n\nsecond **b", "<p>second <strong>b</strong></p>"],
	];
	for (const [src, html] of cases) assert.ok(renderMarkdown(healStreaming(src)).includes(html), src);
});

test("healStreaming drops a dangling marker or half-typed link instead of showing it", () => {
	assert.equal(healStreaming("text with *"), "text with ");
	assert.equal(healStreaming("text with **"), "text with ");
	assert.equal(healStreaming("see [the docs](https://exa"), "see the docs");
	assert.equal(healStreaming("see [the do"), "see the do");
	assert.ok(!renderMarkdown(healStreaming("see [the docs](https://exa")).includes("<a "));
});

test("healStreaming leaves finished text, prose with symbols, and code fences alone", () => {
	for (const text of [
		"Done *fine* and **bold** and `code` and ~~gone~~.",
		"snake_case_name and 2 * 3 * 4 and 5 > 3",
		"```py\nx = *",
		"```py\nprint('a')\n```\n\nafter",
		"A [link](https://example.com) and [ref]",
		"plain text",
		"",
	]) {
		assert.equal(healStreaming(text), text);
	}
	assert.equal(healStreaming(undefined), "");
});

test("healStreaming only changes the last paragraph", () => {
	assert.equal(healStreaming("keep *this\n\nthen *that"), "keep *this\n\nthen *that*");
});

test("no prefix of a streamed reply shows a raw marker once healed", () => {
	const reply =
		"Hello *there* and **bold *nested* text** with `code` and ~~gone~~ plus a [link](https://example.com/a) and _under_ done.\n\n" +
		"## Heading *one*\n\n- first **item**\n- second *item* here\n\nLast paragraph *\u201cquoted text\u201d* ends.";
	for (let i = 1; i <= reply.length; i++) {
		const prefix = reply.slice(0, i);
		const shown = visibleText(renderMarkdown(healStreaming(prefix)));
		assert.ok(!/[*_~`]|\]\(/.test(shown), `prefix ${i}: ${JSON.stringify(prefix.slice(-30))} shows ${JSON.stringify(shown.slice(-40))}`);
	}
	assert.equal(healStreaming(reply), reply);
});

test("healStreaming stays fast on a long reply", () => {
	const long = "word ".repeat(20000) + "*unfinished";
	const t0 = performance.now();
	for (let i = 0; i < 20; i++) healStreaming(long);
	assert.ok(performance.now() - t0 < 500);
});
