import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../public/markdown.js";

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
