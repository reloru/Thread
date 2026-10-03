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

export function renderMarkdown(src) {
	const lines = String(src ?? "").replace(/\0/g, "").replace(/\r\n?/g, "\n").split("\n");
	return renderBlocks(lines, 0);
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
	if (depth > MAX_DEPTH) {
		const text = lines.filter((l) => l.trim()).map((l) => inline(expandTabs(l).trim()));
		return text.length ? `<p>${text.join("<br>")}</p>` : "";
	}
	const out = [];
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
			out.push(codeBlock(body.join("\n"), fence.lang));
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
	return out.join("");
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
		isTableStart(lines, i)
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
		`<pre><code>${escapeHtml(code)}</code></pre></div>`
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

	let s = codeSpans(text, stash);
	s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_, c) => stash(escapeHtml(c)));
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
