import { test } from "node:test";
import assert from "node:assert/strict";
import { highlight } from "../public/highlight.js";

// Strips tags until none are left (as in markdown.test.js), then decodes the five escapes.
function text(html) {
	let out = html;
	for (let prev = null; prev !== out; ) {
		prev = out;
		out = out.replace(/<[^>]*>/g, "");
	}
	return out.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
const tokens = (html, cls) => [...html.matchAll(new RegExp(`<span class="hl-${cls}">([^<]*)</span>`, "g"))].map((m) => text(m[1]));

const SAMPLES = {
	js: 'const x = 42; // note\nlet s = "a\\"b" + `t ${y}`;\n/* block */ foo(0x1F, 1.5e3);',
	python: 'def f(x):\n    """doc"""\n    return None  # c\nprint(f"{x}", 3.14)',
	bash: 'echo $HOME "$PATH" # note\nfor f in *.txt; do cat "$f"; done',
	sql: "SELECT name FROM t WHERE id = 3 -- c\n/* x */ insert into t values ('a');",
	html: '<div class="a" data-x=\'b\'>x &lt; y</div><!-- c --> 1 < 2',
	css: ".a { color: red; } /* c */ @media (x) {}",
	json: '{"a": 1, "b": [true, null]}',
	rust: 'fn main() { let mut v: Vec<u8> = vec![1]; println!("{}", v.len()); }',
};

test("highlighting never changes the text", () => {
	for (const [lang, code] of Object.entries(SAMPLES)) assert.equal(text(highlight(code, lang)), code, lang);
	assert.equal(highlight("<b>&", "nope"), "&lt;b&gt;&amp;");
	assert.equal(highlight("<b>", ""), "&lt;b&gt;");
});

test("tokens by kind", () => {
	const js = highlight(SAMPLES.js, "js");
	assert.deepEqual(tokens(js, "keyword"), ["const", "let"]);
	assert.deepEqual(tokens(js, "comment"), ["// note", "/* block */"]);
	assert.deepEqual(tokens(js, "string"), ['"a\\"b"', "`t ${y}`"]);
	assert.deepEqual(tokens(js, "number"), ["42", "0x1F", "1.5e3"]);
	assert.deepEqual(tokens(js, "call"), ["foo"]);

	const py = highlight(SAMPLES.python, "py");
	assert.deepEqual(tokens(py, "string"), ['"""doc"""', '"{x}"']);
	assert.deepEqual(tokens(py, "literal"), ["None"]);
	assert.deepEqual(tokens(py, "comment"), ["# c"]);

	const sh = highlight(SAMPLES.bash, "sh");
	assert.deepEqual(tokens(sh, "variable"), ["$HOME"]);
	assert.deepEqual(tokens(sh, "comment"), ["# note"]);

	const sql = highlight(SAMPLES.sql, "sql");
	assert.deepEqual(tokens(sql, "keyword"), ["SELECT", "FROM", "WHERE", "insert", "into", "values"]);

	const html = highlight(SAMPLES.html, "html");
	assert.deepEqual(tokens(html, "type"), ["class", "data-x"]);
	assert.deepEqual(tokens(html, "comment"), ["<!-- c -->"]);
});

test("names that contain digits or keywords aren't split", () => {
	assert.deepEqual(tokens(highlight("x1 = item2 + iffy", "js"), "number"), []);
	assert.deepEqual(tokens(highlight("x1 = item2 + iffy", "js"), "keyword"), []);
});

test("unterminated strings and comments end at the line or the text", () => {
	assert.deepEqual(tokens(highlight('a = "open\nb = 1', "py"), "string"), ['"open']);
	assert.deepEqual(tokens(highlight('a = "open\nb = 1', "py"), "number"), ["1"]);
	assert.deepEqual(tokens(highlight("/* open\nx", "js"), "comment"), ["/* open\nx"]);
});

test("highlighting stays linear on hostile input", () => {
	const t0 = performance.now();
	for (const [unit, lang] of [["/*", "js"], ['"', "js"], ["`", "js"], ["<!--", "html"], ["<a ", "html"], ["0x", "js"], ["$(", "bash"], ['"""', "py"], ["'", "sql"]]) {
		highlight(unit.repeat(50000), lang);
	}
	assert.ok(performance.now() - t0 < 2000, `took ${Math.round(performance.now() - t0)} ms`);
});

import { clampOffset, imageFile } from "../public/viewer.js";

test("viewer: a zoomed image stays centred while it fits and pans only to the viewer's edges", () => {
	// A 430×287 image in a 430×739 viewer.
	assert.deepEqual(clampOffset(1, 50, -50, 430, 287, 430, 739), { x: 0, y: 0 });
	assert.deepEqual(clampOffset(2, 500, -500, 430, 287, 430, 739), { x: 215, y: 0 }, "574 px tall still fits");
	assert.deepEqual(clampOffset(3, -999, 999, 430, 287, 430, 739), { x: -430, y: 61 });
	assert.deepEqual(clampOffset(3, 10, 20, 430, 287, 430, 739), { x: 10, y: 20 });
});

test("viewer: shares data: images as files and nothing else", () => {
	const f = imageFile("data:image/jpeg;base64,/9j/AA==", "Shot");
	assert.equal(f.name, "Shot.jpg");
	assert.equal(f.type, "image/jpeg");
	assert.equal(f.size, 4);
	assert.equal(imageFile("https://example.com/a.png"), null);
	assert.equal(imageFile("data:text/html;base64,PGI+"), null);
});
