// Minimal GitHub-flavored Markdown renderer for model output.
// Every text path is HTML-escaped; link hrefs are restricted to http(s) and mailto.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function renderMarkdown(src) {
	const lines = String(src ?? "").replace(/\0/g, "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
	return renderBlocks(lines);
}

function renderBlocks(lines) {
	const out = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];

		if (!line.trim()) {
			i++;
			continue;
		}

		const fence = line.match(FENCE);
		if (fence) {
			const marker = fence[1];
			const lang = fence[2];
			const indent = line.match(/^ */)[0].length;
			const body = [];
			i++;
			while (i < lines.length && !isClosingFence(lines[i], marker)) {
				body.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ""));
				i++;
			}
			i++;
			out.push(codeBlock(body.join("\n"), lang));
			continue;
		}

		const heading = line.match(HEADING);
		if (heading) {
			const level = heading[1].length;
			out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
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
			while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) {
				body.push(lines[i].match(QUOTE)[1]);
				i++;
			}
			out.push(`<blockquote>${renderBlocks(body)}</blockquote>`);
			continue;
		}

		if (LIST_ITEM.test(line)) {
			const [html, next] = parseList(lines, i);
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
			para.push(lines[i].trim());
			i++;
		}
		if (para.length === 0) {
			para.push(lines[i].trim());
			i++;
		}
		out.push(`<p>${para.map(inline).join("<br>")}</p>`);
	}
	return out.join("");
}

function isClosingFence(line, marker) {
	const t = line.trim();
	return t.length >= marker.length && t[0] === marker[0] && /^(`+|~+)$/.test(t) && line.match(/^ */)[0].length < 4;
}

function startsBlock(lines, i) {
	const line = lines[i];
	return (
		FENCE.test(line) ||
		HEADING.test(line) ||
		HR.test(line) ||
		QUOTE.test(line) ||
		LIST_ITEM.test(line) ||
		isTableStart(lines, i)
	);
}

function isTableStart(lines, i) {
	const sep = lines[i + 1];
	return lines[i].includes("|") && sep !== undefined && sep.includes("|") && sep.includes("-") && TABLE_SEP.test(sep);
}

function codeBlock(code, lang) {
	const label = lang ? escapeHtml(lang) : "code";
	return (
		`<div class="code"><div class="code-head"><span>${label}</span>` +
		`<button type="button" class="copy-code" aria-label="Copy code">Copy</button></div>` +
		`<pre><code>${escapeHtml(code)}</code></pre></div>`
	);
}

function parseList(lines, start) {
	const first = lines[start].match(LIST_ITEM);
	const baseIndent = first[1].length;
	const ordered = /\d/.test(first[2]);
	const startNum = ordered ? parseInt(first[2], 10) : 1;
	const items = [];
	let loose = false;
	let i = start;

	while (i < lines.length) {
		const m = lines[i].match(LIST_ITEM);
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
				const nextIndent = lines[j].match(/^ */)[0].length;
				const nextItem = lines[j].match(LIST_ITEM);
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
			const indent = l.match(/^ */)[0].length;
			const item = l.match(LIST_ITEM);
			if (item && item[1].length <= baseIndent) break;
			if (indent <= baseIndent && !item && startsBlock(lines, i)) break;
			body.push(l.slice(Math.min(indent, contentIndent)));
			i++;
		}
		items.push(body);
	}

	const tag = ordered ? "ol" : "ul";
	const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : "";
	const lis = items.map((body) => {
		const html = renderBlocks(body);
		const simple = !loose && /^<p>[\s\S]*?<\/p>/.test(html) ? html.replace(/^<p>([\s\S]*?)<\/p>/, "$1") : html;
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
		} else if (c === "`") {
			inCode = !inCode;
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
	const head = splitRow(lines[start]);
	const aligns = splitRow(lines[start + 1]).map((c) => {
		const l = c.startsWith(":");
		const r = c.endsWith(":");
		return l && r ? "center" : r ? "right" : l ? "left" : "";
	});
	const cls = (k) => (aligns[k] ? ` class="align-${aligns[k]}"` : "");
	let i = start + 2;
	const rows = [];
	while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
		rows.push(splitRow(lines[i]));
		i++;
	}
	const th = head.map((c, k) => `<th${cls(k)}>${inline(c)}</th>`).join("");
	const trs = rows
		.map((r) => `<tr>${head.map((_, k) => `<td${cls(k)}>${inline(r[k] ?? "")}</td>`).join("")}</tr>`)
		.join("");
	return [`<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`, i];
}

const SAFE_URL = /^(https?:\/\/|mailto:)[^\s]+$/i;

export function inline(text) {
	const tokens = [];
	const stash = (html) => `\0${tokens.push(html) - 1}\0`;

	let s = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => stash(`<code>${escapeHtml(code.trim() ? code.replace(/^ (.*) $/, "$1") : code)}</code>`));

	s = s.replace(/\\([\\`*_{}\[\]()#+\-.!|~>])/g, (_, c) => stash(escapeHtml(c)));

	s = s.replace(/\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (m, label, url) => {
		if (!SAFE_URL.test(url)) return stash(escapeHtml(m));
		return stash(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${inlineFormat(escapeHtml(label))}</a>`);
	});

	s = s.replace(/<(https?:\/\/[^\s>]+)>/g, (_, url) => stash(link(url)));
	s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]*[^\s<.,:;"')\]!?*_~])/g, (_, pre, url) => pre + stash(link(url)));

	const restore = (str) => str.replace(/\0(\d+)\0/g, (_, n) => restore(tokens[n]));
	return restore(inlineFormat(escapeHtml(s)));
}

function link(url) {
	const e = escapeHtml(url);
	return `<a href="${e}" target="_blank" rel="noopener noreferrer">${e}</a>`;
}

function inlineFormat(s) {
	return s
		.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, "<strong><em>$1</em></strong>")
		.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
		.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, "$1<em>$2</em>")
		.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>")
		.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
}
