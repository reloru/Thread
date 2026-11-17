import { highlight } from "./highlight.js";

// Minimal GitHub-flavored Markdown renderer for model output.
// Every text path is HTML-escaped; link hrefs are restricted to http(s) and mailto.
// The whole message is re-rendered on every streaming frame, so every pattern here
// must stay linear in the input length.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);

// Like escapeHtml, but leaves well-formed character references (&nbsp; &#169; &#x2014;)
// intact so the browser decodes them as text. Used only for text content, never attributes.
const ENTITY = /^&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});/;
const escapeText = (s) =>
	s.replace(/[&<>"']/g, (c, i) => (c === "&" && ENTITY.test(s.slice(i, i + 40)) ? "&" : ESC[c]));

const MAX_DEPTH = 16;
const MAX_FORMAT_LENGTH = 20000;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_START = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

// While a reply is still arriving, its last paragraph can end inside an unfinished span, and the full
// renderer would show the raw marker (*, **, `, ~~, "](") until the closing one streams in. This returns the
// text with that tail completed: open spans are closed, a dangling marker or half-typed link is dropped.
// Only the last paragraph is touched, and a completed message should be rendered without it.
const TAGS = /<(?:em|strong|del|code)>/g;
const tagCount = (html) => (html.match(TAGS) || []).length;
const WORD = /[\p{L}\p{N}]/u;
const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/gm;

export function healStreaming(src) {
	const text = String(src ?? "");
	const blank = text.lastIndexOf("\n\n");
	const cut = blank === -1 ? 0 : blank + 2;
	const head = text.slice(0, cut);
	let tail = text.slice(cut);
	if (!/[*_~`\[]/.test(tail) || (head.match(FENCE_LINE) || []).length % 2 || (tail.match(FENCE_LINE) || []).length % 2) {
		return text;
	}
	tail = tail
		.replace(/\[([^\]\n]*)\]\([^)\n]*$/, "$1")
		.replace(/(^|[\s(])\[([^\]\n]*)$/, "$1$2")
		.replace(/(^|[\s(])(?:\*\*|__|~~|\*|_|~|`)$/, "$1");
	// The first half of a doubled closing marker ("text*" on its way to "text**") belongs to the closer.
	const half = /([*_~])$/.exec(tail)?.[1];
	const base = half && openSpans(tail.slice(0, -1)).at(-1) === half + half ? tail.slice(0, -1) : tail;
	const closers = openSpans(base).reverse().join("");
	if (closers) {
		// A closing marker only works right after a word, so a trailing space goes first.
		const closed = base.replace(/\s+$/, "") + closers;
		if (tagCount(renderMarkdown(closed)) > tagCount(renderMarkdown(tail))) tail = closed;
	}
	return head + tail;
}

// Markers that are opened and not yet closed at the end of an inline run, outermost first.
function openSpans(t) {
	const stack = [];
	let i = 0;
	while (i < t.length) {
		const ch = t[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "`") {
			let n = 1;
			while (t[i + n] === "`") n++;
			const run = t.slice(i, i + n);
			const end = t.indexOf(run, i + n);
			if (end === -1) {
				stack.push(run);
				return stack;
			}
			i = end + n;
			continue;
		}
		if (ch !== "*" && ch !== "_" && ch !== "~") {
			i++;
			continue;
		}
		let n = 1;
		while (t[i + n] === ch) n++;
		const before = i > 0 ? t[i - 1] : "";
		const after = t[i + n] ?? "";
		const units = [];
		for (let left = n; left > 0; left -= 2) units.push(left >= 2 ? ch + ch : ch);
		for (const unit of units) {
			if (unit === "~") continue;
			const open = stack.lastIndexOf(unit);
			const canClose = open !== -1 && before !== "" && !/\s/.test(before);
			const wide = unit.length === 2;
			const canOpen = after !== "" && !/\s/.test(after) && (wide || (before === "" || !WORD.test(before)));
			if (canClose) stack.length = open;
			else if (canOpen) stack.push(unit);
		}
		i += n;
	}
	return stack;
}

const sourceLines = (src) => String(src ?? "").replace(/\0/g, "").replace(/\r\n?/g, "\n").split("\n");

export function renderMarkdown(src) {
	return renderBlocks(sourceLines(src), 0);
}

/**
 * The same output as renderMarkdown, as its top-level blocks: [{ html, code? }], each html being one element.
 * A streaming reply is rendered many times; the app compares the blocks with the ones on the page and replaces
 * only those that changed. code: { lang, text } on a fenced code block, so one that is still being written can be
 * updated in place.
 */
export function markdownBlocks(src) {
	return blocks(sourceLines(src), 0);
}

// Block structure is measured on a tab-expanded copy; source lines stay raw so that tabs
// inside code blocks survive. Container indentation is stripped by columns.
const expandTabs = (line) => line.replace(/\t/g, "    ");

function stripColumns(line, n) {
	let col = 0;
	let k = 0;
	while (k < line.length && col < n) {
		const w = line[k] === "\t" ? 4 : line[k] === " " ? 1 : 0;
		if (!w) break;
		if (col + w > n) return " ".repeat(col + w - n) + line.slice(k + 1);
		col += w;
		k++;
	}
	return line.slice(k);
}

function parseFence(line) {
	const m = FENCE_OPEN.exec(line);
	if (!m) return null;
	const rest = line.slice(m[0].length);
	if (rest.includes("`")) return null;
	return { marker: m[1], lang: rest.trimStart().split(/\s/)[0] };
}

function renderBlocks(lines, depth) {
	return blocks(lines, depth)
		.map((b) => b.html)
		.join("");
}

function blocks(lines, depth) {
	if (depth > MAX_DEPTH) {
		const text = lines.filter((l) => l.trim()).map((l) => inline(expandTabs(l).trim()));
		return text.length ? [{ html: `<p>${text.join("<br>")}</p>` }] : [];
	}
	const found = [];
	const out = { push: (html, extra) => found.push({ html, ...extra }) };
	let i = 0;
	while (i < lines.length) {
		const line = expandTabs(lines[i]);

		if (!line.trim()) {
			i++;
			continue;
		}

		const fence = parseFence(line);
		if (fence) {
			const indent = line.match(/^ */)[0].length;
			const body = [];
			i++;
			while (i < lines.length && !isClosingFence(expandTabs(lines[i]), fence.marker)) {
				body.push(stripColumns(lines[i], indent));
				i++;
			}
			i++;
			const text = body.join("\n");
			out.push(codeBlock(text, fence.lang), { code: { lang: fence.lang, text } });
			continue;
		}

		const math = mathBlock(lines, i);
		if (math) {
			out.push(displayMath(math));
			i = math.next;
			continue;
		}

		const heading = parseHeading(line);
		if (heading) {
			out.push(`<h${heading.level}>${inline(heading.text)}</h${heading.level}>`);
			i++;
			continue;
		}

		if (HR.test(line)) {
			out.push("<hr>");
			i++;
			continue;
		}

		if (QUOTE.test(line)) {
			const body = [];
			while (i < lines.length && lines[i].trim() && QUOTE.test(expandTabs(lines[i]))) {
				body.push(stripColumns(lines[i].replace(/^ {0,3}>/, ""), 1));
				i++;
			}
			out.push(`<blockquote>${renderBlocks(body, depth + 1)}</blockquote>`);
			continue;
		}

		if (LIST_ITEM.test(line)) {
			const [html, next] = parseList(lines, i, depth);
			out.push(html);
			i = next;
			continue;
		}

		if (isTableStart(lines, i)) {
			const [html, next] = parseTable(lines, i);
			out.push(html);
			i = next;
			continue;
		}

		const para = [];
		while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
			para.push(expandTabs(lines[i]).trim());
			i++;
		}
		if (para.length === 0) {
			para.push(line.trim());
			i++;
		}
		out.push(`<p>${para.map(inline).join("<br>")}</p>`);
	}
	return found;
}

// Math. Sampled from all eleven models: formulas come as $…$ or \(…\) inside a line, and as $$…$$ or \[…\]
// around one line or on lines of their own (also indented, inside list items); none had a blank line inside.
// Formulas are not typeset here: they become <span class="math">TeX</span>, which math.js hands to KaTeX.
const MATH_OPEN = /^ {0,3}(\$\$|\\\[)/;
// What may follow the closing delimiter on its line.
const MATH_TAIL = /^[\s.,;:!?]*$/;
const MATH_MAX_LINES = 200;
const MATH_MAX_CHARS = 2000;

/**
 * A display formula starting at line i: { tex, next } or, while its closing delimiter hasn't arrived,
 * { tex, next, pending }. Null when the line doesn't start one: text follows the closing delimiter, or a blank
 * line comes before it.
 */
function mathBlock(lines, i) {
	const line = expandTabs(lines[i]);
	const m = MATH_OPEN.exec(line);
	if (!m) return null;
	const close = m[1] === "$$" ? "$$" : "\\]";
	const first = line.slice(m[0].length);
	const end = first.indexOf(close);
	if (end !== -1) {
		const tex = first.slice(0, end).trim();
		if (close === "\\]" && (CITATION.test(tex) || placeholder(tex, true))) return null;
		return tex && MATH_TAIL.test(first.slice(end + close.length)) ? { tex, next: i + 1 } : null;
	}
	// Over several lines only from a line with nothing but the delimiter, as every sampled model wrote one; "$$ off
	// today" at the end of a finished reply is then text, not a formula that never closes.
	if (first.trim()) return null;
	const body = [first];
	const last = Math.min(lines.length, i + MATH_MAX_LINES);
	for (let j = i + 1; j < last; j++) {
		const l = lines[j];
		if (!l.trim()) return null;
		const at = l.indexOf(close);
		if (at === -1) {
			body.push(l);
			continue;
		}
		body.push(l.slice(0, at));
		const tex = body.join("\n").trim();
		return tex && MATH_TAIL.test(l.slice(at + close.length)) ? { tex, next: j + 1 } : null;
	}
	return last === lines.length ? { tex: body.join("\n").trim(), next: last, pending: true } : null;
}

function displayMath({ tex, pending }) {
	if (pending) return `<div class="math-pending">${escapeHtml(tex)}</div>`;
	return `<div class="math-block"><span class="math" data-display>${escapeHtml(tex)}</span></div>`;
}

function parseHeading(line) {
	const m = HEADING_START.exec(line);
	if (!m) return null;
	let text = line.slice(m[0].length).trim();
	// A closing run of #'s only counts when preceded by whitespace (so "C#" keeps its '#').
	const close = /(?:^|[ \t])#+$/.exec(text);
	if (close) text = text.slice(0, close.index).trimEnd();
	return { level: m[1].length, text };
}

function isClosingFence(line, marker) {
	const t = line.trim();
	return t.length >= marker.length && t[0] === marker[0] && /^(`+|~+)$/.test(t) && line.match(/^ */)[0].length < 4;
}

function startsBlock(lines, i) {
	const line = expandTabs(lines[i]);
	return (
		parseFence(line) !== null ||
		HEADING_START.test(line) ||
		HR.test(line) ||
		QUOTE.test(line) ||
		LIST_ITEM.test(line) ||
		isTableStart(lines, i) ||
		mathBlock(lines, i) !== null
	);
}

function isTableStart(lines, i) {
	const sep = lines[i + 1];
	return lines[i].includes("|") && sep !== undefined && sep.includes("|") && sep.includes("-") && isTableSep(sep);
}

function isTableSep(sep) {
	let t = sep.trim();
	if (t.startsWith("|")) t = t.slice(1);
	if (t.endsWith("|")) t = t.slice(0, -1);
	return t.split("|").every((c) => /^:?-+:?$/.test(c.trim()));
}

function codeBlock(code, lang) {
	const label = lang ? escapeHtml(lang) : "code";
	return (
		`<div class="code"><div class="code-head"><span>${label}</span>` +
		`<button type="button" class="copy-code" aria-label="Copy code">Copy</button></div>` +
		`<pre><code>${highlight(code, lang)}</code></pre></div>`
	);
}

function parseList(lines, start, depth) {
	const first = expandTabs(lines[start]).match(LIST_ITEM);
	const baseIndent = first[1].length;
	const ordered = /\d/.test(first[2]);
	const startNum = ordered ? parseInt(first[2], 10) : 1;
	const items = [];
	let loose = false;
	let i = start;

	while (i < lines.length) {
		const m = expandTabs(lines[i]).match(LIST_ITEM);
		if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
		const contentIndent = m[1].length + m[2].length + 1;
		const body = [m[3]];
		i++;
		while (i < lines.length) {
			const l = lines[i];
			if (!l.trim()) {
				let j = i + 1;
				while (j < lines.length && !lines[j].trim()) j++;
				if (j >= lines.length) {
					i = j;
					break;
				}
				const nextLine = expandTabs(lines[j]);
				const nextIndent = nextLine.match(/^ */)[0].length;
				const nextItem = nextLine.match(LIST_ITEM);
				if (nextIndent > baseIndent && !(nextItem && nextItem[1].length === baseIndent)) {
					body.push("");
					loose = true;
					i++;
					continue;
				}
				if (nextItem && nextItem[1].length === baseIndent && /\d/.test(nextItem[2]) === ordered) loose = true;
				i = j;
				break;
			}
			const expanded = expandTabs(l);
			const indent = expanded.match(/^ */)[0].length;
			const item = expanded.match(LIST_ITEM);
			if (item && item[1].length <= baseIndent) break;
			if (indent <= baseIndent && !item && startsBlock(lines, i)) break;
			body.push(stripColumns(l, Math.min(indent, contentIndent)));
			i++;
		}
		items.push(body);
	}

	const tag = ordered ? "ol" : "ul";
	const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : "";
	const lis = items.map((body) => {
		const html = renderBlocks(body, depth + 1);
		const simple = !loose && html.startsWith("<p>") ? html.replace(/^<p>([\s\S]*?)<\/p>/, "$1") : html;
		return `<li>${simple}</li>`;
	});
	return [`<${tag}${startAttr}>${lis.join("")}</${tag}>`, i];
}

function splitRow(line) {
	let t = line.trim();
	if (t.startsWith("|")) t = t.slice(1);
	if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
	const cells = [];
	let cur = "";
	let inCode = false;
	for (let k = 0; k < t.length; k++) {
		const c = t[k];
		if (c === "\\" && t[k + 1] === "|") {
			cur += "|";
			k++;
		} else if (c === "\\" && t[k + 1] === "`") {
			cur += "\\`";
			k++;
		} else if (!inCode && c === "\\" && t[k + 1] === "(" && t.indexOf("\\)", k + 2) !== -1) {
			// A formula like \(|x|\) keeps its bars.
			const end = t.indexOf("\\)", k + 2) + 2;
			cur += t.slice(k, end);
			k = end - 1;
		} else if (c === "`") {
			// A backtick with no partner later in the row is literal and must not swallow the cells after it.
			if (inCode || t.indexOf("`", k + 1) !== -1) inCode = !inCode;
			cur += c;
		} else if (c === "|" && !inCode) {
			cells.push(cur.trim());
			cur = "";
		} else cur += c;
	}
	cells.push(cur.trim());
	return cells;
}

function parseTable(lines, start) {
	const head = splitRow(expandTabs(lines[start]));
	const aligns = splitRow(expandTabs(lines[start + 1])).map((c) => {
		const l = c.startsWith(":");
		const r = c.endsWith(":");
		return l && r ? "center" : r ? "right" : l ? "left" : "";
	});
	const cls = (k) => (aligns[k] ? ` class="align-${aligns[k]}"` : "");
	let i = start + 2;
	const rows = [];
	while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
		rows.push(splitRow(expandTabs(lines[i])));
		i++;
	}
	const th = head.map((c, k) => `<th${cls(k)}>${inline(c)}</th>`).join("");
	const trs = rows
		.map((r) => `<tr>${head.map((_, k) => `<td${cls(k)}>${inline(r[k] ?? "")}</td>`).join("")}</tr>`)
		.join("");
	return [`<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`, i];
}

const SAFE_URL = /^(https?:\/\/|mailto:)[^\s]+$/i;
// Placeholder tokens (\0n\0) may appear in link text but never inside a URL.
const LINK =
	/\[((?:[^[\]\n]|\[[^[\]\n]{0,500}\]){1,500})\]\(\s*<?((?:[^()\s<>\0]|\([^()\s<>\0]{0,500}\)){1,2000})>?(?:\s+"[^"\n]{0,500}")?\s*\)/g;
const ANGLE_URL = /<(https?:\/\/[^\s<>\0]{1,2000})>/g;
const BARE_URL = /(^|[\s(*_~])(https?:\/\/[^\s<\0]{1,2000})/g;

export function inline(text) {
	const tokens = [];
	const stash = (html) => `\0${tokens.push(html) - 1}\0`;

	let s = mathSpans(codeSpans(text, stash), stash);
	s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~>$])/g, (_, c) => stash(escapeHtml(c)));
	s = s.replace(LINK, (m, label, url) => {
		if (!SAFE_URL.test(url)) return stash(escapeText(m));
		const href = escapeHtml(url.replace(/&amp;/g, "&"));
		return stash(`<a href="${href}" target="_blank" rel="noopener noreferrer">${format(escapeText(label))}</a>`);
	});
	s = s.replace(ANGLE_URL, (_, url) => stash(link(url)));
	s = s.replace(BARE_URL, (m, pre, candidate) => {
		const url = trimUrl(candidate);
		return url ? pre + stash(link(url)) + candidate.slice(url.length) : m;
	});

	const restore = (str) => str.replace(/\0(\d+)\0/g, (_, n) => restore(tokens[n]));
	return restore(format(escapeText(s)));
}

// CommonMark code spans: a run of N backticks closes at the next run of exactly N.
// Linear: each run's partner is found by one right-to-left pass.
function codeSpans(text, stash) {
	const runs = [];
	const re = /`+/g;
	let m;
	while ((m = re.exec(text))) runs.push([m.index, m[0].length]);
	if (runs.length < 2) return text;

	const partner = new Array(runs.length);
	const lastByLength = new Map();
	for (let i = runs.length - 1; i >= 0; i--) {
		partner[i] = lastByLength.get(runs[i][1]) ?? -1;
		lastByLength.set(runs[i][1], i);
	}

	let out = "";
	let pos = 0;
	for (let i = 0; i < runs.length; i++) {
		const [start, len] = runs[i];
		if (start < pos || partner[i] === -1) continue;
		const [end] = runs[partner[i]];
		let code = text.slice(start + len, end);
		if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
		out += text.slice(pos, start) + stash(`<code>${escapeHtml(code)}</code>`);
		pos = end + len;
		i = partner[i];
	}
	return out + text.slice(pos);
}

// "\[1\]" and "\[1, 2\]" are escaped brackets around a citation, not a formula.
const CITATION = /^\s*\^?\d+(\s*[,–-]\s*\d+)*\s*$/;
// Escaped brackets around a placeholder in prose ("Dear \[Your Name\],", "fill in \[date\]"): only letters, spaces
// and punctuation, nothing a formula would have, and a word of two letters or more; inside \( \) two such words,
// so \(x\), \(dx\) and \[ x \] stay math.
const PLAIN = /^[\p{L}\s'’.,:;!?&-]+$/u;
const LONG_WORD = /\p{L}{2,}/u;
const TWO_WORDS = /\p{L}{2,}\s+\p{L}{2,}/u;
const placeholder = (tex, bracket) => PLAIN.test(tex.trim()) && (bracket ? LONG_WORD : TWO_WORDS).test(tex);
// "I have $5 and you have 10$": a number, then words, with nothing a formula would have.
const PROSE_AMOUNT = /^\d[^\\^_=+\-*/<>{}|]*\s[^\\^_=+\-*/<>{}|]*$/;
const SPACE = /\s/;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Stashes the formulas in one line of text: \(…\), \[…\], $$…$$ and $…$. A single dollar opens one only with a
 * non-space after it and no letter or digit before it, and the next dollar closes it only with a non-space
 * before it and no letter or digit after it, which keeps prices ("$20 + $35 = $55") as text. One pass: each
 * closing delimiter is searched for once per stretch of text.
 */
function mathSpans(text, stash) {
	if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[")) return text;
	const found = {};
	const find = (close, from) => {
		if (!(close in found) || (found[close] !== -1 && found[close] < from)) found[close] = text.indexOf(close, from);
		return found[close];
	};
	const span = (tex, display) => stash(`<span class="math"${display ? " data-display" : ""}>${escapeHtml(tex.trim())}</span>`);
	let out = "";
	let from = 0;
	let i = 0;
	const take = (end, html) => {
		out += text.slice(from, i) + html;
		i = from = end;
	};
	while (i < text.length) {
		const c = text[i];
		if (c === "\\") {
			const open = text[i + 1];
			if (open === "(" || open === "[") {
				const end = find(open === "(" ? "\\)" : "\\]", i + 2);
				const tex = end === -1 ? "" : text.slice(i + 2, end);
				if (tex.trim() && tex.length <= MATH_MAX_CHARS && !(open === "[" && CITATION.test(tex)) && !placeholder(tex, open === "[")) {
					take(end + 2, span(tex, open === "["));
					continue;
				}
			}
			// Any other escaped character, a dollar included, is left for the caller.
			i += 2;
			continue;
		}
		if (c !== "$" || (i > 0 && WORD_CHAR.test(text[i - 1]))) {
			i++;
			continue;
		}
		if (text[i + 1] === "$") {
			const end = find("$$", i + 2);
			const tex = end === -1 ? "" : text.slice(i + 2, end);
			if (tex.trim() && tex.length <= MATH_MAX_CHARS) take(end + 2, span(tex, true));
			else i += 2;
			continue;
		}
		const next = text[i + 1];
		let end = -1;
		if (next !== undefined && !SPACE.test(next)) {
			const limit = Math.min(text.length, i + 1 + MATH_MAX_CHARS);
			for (let j = i + 1; j < limit; j++) {
				if (text[j] === "\\") j++;
				else if (text[j] === "$") {
					end = j;
					break;
				}
			}
		}
		const after = end === -1 ? "" : (text[end + 1] ?? "");
		const tex = end === -1 ? "" : text.slice(i + 1, end);
		if (tex && !SPACE.test(text[end - 1]) && !(after && WORD_CHAR.test(after)) && !PROSE_AMOUNT.test(tex)) take(end + 1, span(tex, false));
		else i++;
	}
	return out + text.slice(from);
}

// Drops trailing punctuation from a bare URL, and a trailing ')' unless it closes a '(' in the URL.
function trimUrl(url) {
	let end = url.length;
	while (end > 0) {
		const c = url[end - 1];
		if (".,:;\"'!?*_~]".includes(c)) {
			end--;
			continue;
		}
		if (c === ")") {
			const u = url.slice(0, end);
			if (u.split("(").length < u.split(")").length) {
				end--;
				continue;
			}
		}
		break;
	}
	const result = url.slice(0, end);
	return /^https?:\/\/[^/]/.test(result) ? result : null;
}

function link(url) {
	const e = escapeHtml(url.replace(/&amp;/g, "&"));
	return `<a href="${e}" target="_blank" rel="noopener noreferrer">${e}</a>`;
}

function format(s) {
	// Emphasis matching is quadratic on pathological lines; very long lines are shown unformatted.
	if (s.length > MAX_FORMAT_LENGTH) return s;
	return s
		.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, "<strong><em>$1</em></strong>")
		.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
		.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, "$1<em>$2</em>")
		.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>")
		.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
}
