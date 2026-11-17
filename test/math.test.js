import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { healStreaming, markdownBlocks, renderMarkdown } from "../public/markdown.js";
import { diffBlocks } from "../public/render.js";

const span = (tex, display = false) => `<span class="math"${display ? " data-display" : ""}>${tex}</span>`;
const block = (tex) => `<div class="math-block">${span(tex, true)}</div>`;

test("inline formulas: single dollars and \\( \\)", () => {
	assert.equal(renderMarkdown("rate $r$ for $t$ years ($A$)"), `<p>rate ${span("r")} for ${span("t")} years (${span("A")})</p>`);
	assert.equal(renderMarkdown("where \\( P \\) is the price"), `<p>where ${span("P")} is the price</p>`);
	assert.equal(renderMarkdown("**$A$** = amount"), `<p><strong>${span("A")}</strong> = amount</p>`);
	assert.equal(renderMarkdown("$a_1 * b_2$ and $x < y$"), `<p>${span("a_1 * b_2")} and ${span("x &lt; y")}</p>`);
});

test("prices are not formulas", () => {
	for (const text of [
		"$20 (shirt) + $35 (pants) = **$55.00**",
		"$20 + $35 = $55",
		"$55 × 0.85 = **$46.75**",
		"between $5-$10 or US$5",
		"I have $5 and you have 10$.",
		"costs \\$5 and \\$6",
		"a lone $ sign and $ spaced $ ones",
	]) {
		assert.ok(!renderMarkdown(text).includes("math"), text);
	}
	assert.equal(renderMarkdown("costs \\$5"), "<p>costs $5</p>");
});

test("formulas in code are left alone", () => {
	assert.equal(renderMarkdown("`$x$` and `\\(y\\)`"), "<p><code>$x$</code> and <code>\\(y\\)</code></p>");
	assert.ok(!renderMarkdown("```\n$$\nx\n$$\n```").includes("math"));
});

test("display formulas on one line and across lines", () => {
	assert.equal(renderMarkdown("$$A = P(1 + r)^t$$"), block("A = P(1 + r)^t"));
	assert.equal(renderMarkdown("\\[ A = P \\]"), block("A = P"));
	assert.equal(renderMarkdown("\\[\na=1,\\qquad b=-5\n\\]"), block("a=1,\\qquad b=-5"));
	assert.equal(renderMarkdown("$$\nx = 1\n- 2\n$$"), block("x = 1\n- 2"), "lines inside are not read as a list");
	assert.equal(renderMarkdown("The formula is:  \n$$\nx\n$$  \nnext"), `<p>The formula is:</p>${block("x")}<p>next</p>`);
	assert.equal(renderMarkdown("\\[\nx = 1\n\\]."), block("x = 1"));
	assert.equal(renderMarkdown("so $$x = 1$$ holds"), `<p>so ${span("x = 1", true)} holds</p>`);
});

test("display formulas inside list items", () => {
	const html = renderMarkdown("1. **Compute**:  \n   $$\n   \\Delta = b^2\n   $$  \n2. next");
	assert.equal(html, `<ol><li><strong>Compute</strong>:${block("\\Delta = b^2")}</li><li>next</li></ol>`);
});

test("escaped brackets around a citation stay text", () => {
	assert.equal(renderMarkdown("see \\[1\\] and \\[2, 3\\]"), "<p>see [1] and [2, 3]</p>");
	assert.equal(renderMarkdown("\\[1\\] Smith, J. (2020)"), "<p>[1] Smith, J. (2020)</p>");
});

test("an opening delimiter that never closes isn't a formula", () => {
	assert.equal(renderMarkdown("$$$ pricing\n\nmore"), "<p>$$$ pricing</p><p>more</p>");
	assert.equal(renderMarkdown("$$ and then prose\n\nmore"), "<p>$$ and then prose</p><p>more</p>");
	assert.ok(!renderMarkdown("\\[ x").includes('class="math"'));
});

test("a display formula still arriving is held as plain text, and typeset once it closes", () => {
	assert.equal(renderMarkdown("Text:\n$$\nx = \\frac{1"), '<p>Text:</p><div class="math-pending">x = \\frac{1</div>');
	assert.equal(renderMarkdown("Text:\n$$\nx = \\frac{1}{2}\n$$"), `<p>Text:</p>${block("x = \\frac{1}{2}")}`);
	assert.equal(healStreaming("Text:\n$$\nx = \\frac{1"), "Text:\n$$\nx = \\frac{1");
});

test("a finished reply ending in a delimiter with text after it isn't a pending formula", () => {
	assert.equal(renderMarkdown("Save big:\n$$ off today"), "<p>Save big:<br>$$ off today</p>");
	assert.equal(renderMarkdown("\\[ x = 1"), "<p>[ x = 1</p>");
});

test("bars inside a formula in a table cell don't split the row", () => {
	const html = renderMarkdown("| a | b |\n|---|---|\n| \\(|x|\\) | 2 |");
	assert.ok(html.includes(`<td>${span("|x|")}</td><td>2</td>`), html);
});

test("the TeX is escaped", () => {
	const html = renderMarkdown("$$<img src=x onerror=alert(1)>$$ and $a<b>c$");
	assert.ok(!html.includes("<img") && !html.includes("<b>"));
	assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
});

test("math scanning stays linear on hostile input", () => {
	const started = performance.now();
	for (const unit of ["\\(", "\\[", "$", "$$", "$x", "\\[ x\n"]) renderMarkdown(unit.repeat(40000));
	assert.ok(performance.now() - started < 3000, `took ${Math.round(performance.now() - started)} ms`);
});

// Replies of all eleven models to two prompts that never mention LaTeX: a quadratic with an integral and a
// standard deviation, and a shopping sum followed by the compound interest formula.
const dir = new URL("fixtures/math/", import.meta.url);
const fixtures = readdirSync(dir).filter((f) => f.endsWith(".md"));
const mathOf = (html) => [...html.matchAll(/<span class="math"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);

test("model replies: every formula is found and no delimiter is left behind", () => {
	assert.equal(fixtures.length, 22);
	const counts = {};
	for (const file of fixtures) {
		const html = renderMarkdown(readFileSync(new URL(file, dir), "utf8"));
		const rest = html.replace(/<span class="math"[^>]*>[^<]*<\/span>/g, "").replace(/<code>[^<]*<\/code>/g, "");
		assert.deepEqual(rest.match(/\\\(|\\\)|\\\[|\\\]|\$\$|\\frac|\\sqrt|math-pending/g), null, file);
		counts[file] = mathOf(html).length;
	}
	// Granite and Llama wrote no TeX at all; the others did for the quadratic.
	assert.equal(counts["gemma-4-26b-a4b-it.quadratic.md"], 26);
	assert.equal(counts["gpt-oss-120b.quadratic.md"], 49);
	assert.equal(counts["qwen3.8-27b.quadratic.md"], 23);
	assert.equal(counts["phonellm-mini-alpha-2.quadratic.md"], 26);
	assert.equal(counts["granite-4.0-h-micro.quadratic.md"], 0);
	assert.equal(counts["llama-3.3-70b-instruct-fp8-fast.prices.md"], 0);
});

test("model replies: dollar amounts stay text", () => {
	for (const file of fixtures.filter((f) => f.endsWith(".prices.md"))) {
		const src = readFileSync(new URL(file, dir), "utf8");
		const html = renderMarkdown(src);
		// A price that became a formula would lose its dollar sign.
		const dollars = (text) => (text.match(/\$\d/g) || []).length;
		const inMath = mathOf(html).join(" ");
		const plain = html.replace(/<span class="math"[^>]*>[^<]*<\/span>/g, "");
		assert.equal(dollars(plain) + dollars(inMath), dollars(src), file);
	}
});

test("markdownBlocks gives renderMarkdown's output one top-level element at a time", () => {
	for (const file of fixtures) {
		const src = readFileSync(new URL(file, dir), "utf8");
		const blocks = markdownBlocks(src);
		assert.equal(blocks.map((b) => b.html).join(""), renderMarkdown(src), file);
		for (const b of blocks) assert.match(b.html, /^<(p|div|h[1-6]|hr|ul|ol|blockquote)[ >]/, file);
	}
	const [, code] = markdownBlocks("a\n\n```js\nlet x;\n```");
	assert.deepEqual(code.code, { lang: "js", text: "let x;" });
});

test("diffBlocks: only what changed is replaced", () => {
	const b = (src) => markdownBlocks(src);
	assert.equal(diffBlocks(b("one\n\ntwo"), b("one\n\ntwo")), null);
	assert.deepEqual(diffBlocks(b("one\n\ntwo"), b("one\n\ntwo more")), { keep: 1, html: "<p>two more</p>" });
	assert.deepEqual(diffBlocks(b("one"), b("one\n\n- a\n- b")), { keep: 1, html: "<ul><li>a</li><li>b</li></ul>" });
	assert.deepEqual(diffBlocks(b("one\n\ntwo"), b("one")), { keep: 1, html: "" });
	assert.deepEqual(diffBlocks([], b("one")), { keep: 0, html: "<p>one</p>" });
	// A code block that is still being written is updated in place.
	assert.deepEqual(diffBlocks(b("x\n\n```js\nlet a"), b("x\n\n```js\nlet a = 1;")), { keep: 1, code: "let a = 1;" });
	// Once something follows it, or its language changes, it is replaced like any other block.
	assert.deepEqual(diffBlocks(b("```js\na"), b("```js\na\n```\n\ndone")), { keep: 1, html: "<p>done</p>" });
	assert.equal(diffBlocks(b("```js\na"), b("```js\nab\n```\n\ndone")).keep, 0);
	assert.ok("html" in diffBlocks(b("```js\na"), b("```js\nab\n```\n\ndone")));
	assert.ok("html" in diffBlocks(b("```j\na"), b("```js\na")));
});
