// Syntax highlighting for code blocks: comments, strings, numbers, keywords and a few literals, by language
// family. It returns escaped HTML. Each token pattern either matches at a position or doesn't start there, and
// every pattern that starts always ends (an unterminated string or comment runs to the end of its line or of the
// text), so a scan is linear in the length of the code, as markdown.js requires.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);

const words = (list) => new Set(list.split(" "));

const C_LIKE_KEYWORDS =
	"if else for while do switch case default break continue return goto try catch finally throw new delete typeof instanceof void in of class extends super this static public private protected const let var function async await yield import export from as interface enum implements package struct union typedef sizeof namespace using template typename virtual override final abstract fn mut impl trait pub use mod crate self match loop where unsafe move ref dyn func go defer chan select range type map";
const LITERALS = words("true false null undefined nil None True False NaN Infinity");

const FAMILIES = {
	c: {
		keywords: words(C_LIKE_KEYWORDS),
		types: words("int long short char float double bool boolean byte string String void u8 u16 u32 u64 i8 i16 i32 i64 f32 f64 usize isize str any number unknown never object auto unsigned signed"),
		line: "//",
		block: true,
		strings: "\"'`",
	},
	python: {
		keywords: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self"),
		types: words("int float str bool list dict set tuple bytes object type range len"),
		line: "#",
		strings: "\"'",
		triple: true,
	},
	shell: {
		keywords: words("if then else elif fi for while until do done case esac in function return export local readonly echo cd exit set unset source sudo"),
		types: words(""),
		line: "#",
		strings: "\"'",
		variables: true,
	},
	sql: {
		keywords: words("select from where and or not insert into values update set delete create table drop alter add column index primary key foreign references join left right inner outer on group by order having limit offset as distinct union all case when then else end is null like in between exists with returning default unique"),
		types: words("int integer bigint smallint text varchar char boolean date timestamp real float double numeric decimal blob serial"),
		line: "--",
		block: true,
		strings: "'\"",
		caseless: true,
	},
	json: { keywords: words(""), types: words(""), strings: "\"" },
	css: {
		keywords: words("important media import supports keyframes font-face"),
		types: words(""),
		block: true,
		strings: "\"'",
	},
	html: { markup: true },
};

const ALIASES = {
	js: "c", javascript: "c", jsx: "c", ts: "c", typescript: "c", tsx: "c", mjs: "c", c: "c", h: "c", cpp: "c", "c++": "c",
	cc: "c", hpp: "c", cs: "c", csharp: "c", java: "c", kotlin: "c", kt: "c", swift: "c", go: "c", golang: "c", rust: "c",
	rs: "c", php: "c", dart: "c", scala: "c",
	py: "python", python: "python", python3: "python",
	sh: "shell", bash: "shell", shell: "shell", zsh: "shell", console: "shell",
	sql: "sql", postgres: "sql", postgresql: "sql", mysql: "sql", sqlite: "sql",
	json: "json", jsonc: "c",
	css: "css", scss: "css", less: "css",
	html: "html", xml: "html", svg: "html", vue: "html",
};

const span = (cls, text) => `<span class="hl-${cls}">${escapeHtml(text)}</span>`;
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[a-zA-Z]*/y;
const IDENT = /[A-Za-z_$][\w$]*/y;

function stringEnd(code, i, quote, triple) {
	if (triple && code.startsWith(quote.repeat(3), i)) {
		const end = code.indexOf(quote.repeat(3), i + 3);
		return end === -1 ? code.length : end + 3;
	}
	let j = i + 1;
	while (j < code.length) {
		const c = code[j];
		if (c === "\\") j += 2;
		else if (c === quote) return j + 1;
		// Only template strings run over lines; an unclosed ordinary string stops at the line's end.
		else if (c === "\n" && quote !== "`") return j;
		else j++;
	}
	return code.length;
}

function highlightCode(code, f) {
	let out = "";
	let plain = "";
	const flush = () => {
		out += escapeHtml(plain);
		plain = "";
	};
	const emit = (cls, text) => {
		flush();
		out += span(cls, text);
	};
	let i = 0;
	while (i < code.length) {
		const c = code[i];
		if (f.line && code.startsWith(f.line, i) && !(f.line === "#" && f.variables && code[i - 1] === "$")) {
			const end = code.indexOf("\n", i);
			const stop = end === -1 ? code.length : end;
			emit("comment", code.slice(i, stop));
			i = stop;
			continue;
		}
		if (f.block && code.startsWith("/*", i)) {
			const end = code.indexOf("*/", i + 2);
			const stop = end === -1 ? code.length : end + 2;
			emit("comment", code.slice(i, stop));
			i = stop;
			continue;
		}
		if (f.strings.includes(c)) {
			const stop = stringEnd(code, i, c, f.triple);
			emit("string", code.slice(i, stop));
			i = stop;
			continue;
		}
		if (f.variables && c === "$" && /[\w{(@#?*!]/.test(code[i + 1] || "")) {
			IDENT.lastIndex = i + 1;
			const m = IDENT.exec(code);
			const stop = m ? i + 1 + m[0].length : i + 2;
			emit("variable", code.slice(i, stop));
			i = stop;
			continue;
		}
		if (/\d/.test(c) || (c === "." && /\d/.test(code[i + 1] || ""))) {
			const before = code[i - 1] || "";
			if (!/[\w$]/.test(before)) {
				NUMBER.lastIndex = i;
				const m = NUMBER.exec(code);
				emit("number", m[0]);
				i += m[0].length;
				continue;
			}
		}
		if (/[A-Za-z_$]/.test(c) && !/[\w$]/.test(code[i - 1] || "")) {
			IDENT.lastIndex = i;
			const word = IDENT.exec(code)[0];
			const key = f.caseless ? word.toLowerCase() : word;
			if (f.keywords.has(key)) emit("keyword", word);
			else if (LITERALS.has(word)) emit("literal", word);
			else if (f.types.has(key)) emit("type", word);
			else if (code[i + word.length] === "(") emit("call", word);
			else plain += word;
			i += word.length;
			continue;
		}
		plain += c;
		i++;
	}
	flush();
	return out;
}

const TAG = /<\/?[A-Za-z][\w:-]*|\/?>|"[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)|[A-Za-z_:][\w:.-]*(?==)/gy;

// Markup: comments, tag names, attribute names and their quoted values. Text between tags stays plain.
function highlightMarkup(code) {
	let out = "";
	let i = 0;
	let inTag = false;
	while (i < code.length) {
		if (!inTag) {
			const lt = code.indexOf("<", i);
			const stop = lt === -1 ? code.length : lt;
			out += escapeHtml(code.slice(i, stop));
			i = stop;
			if (lt === -1) break;
			if (code.startsWith("<!--", i)) {
				const end = code.indexOf("-->", i + 4);
				const close = end === -1 ? code.length : end + 3;
				out += span("comment", code.slice(i, close));
				i = close;
				continue;
			}
			if (!/[A-Za-z/!?]/.test(code[i + 1] || "")) {
				out += escapeHtml("<");
				i++;
				continue;
			}
			inTag = true;
		}
		TAG.lastIndex = i;
		const m = TAG.exec(code);
		if (!m) {
			out += escapeHtml(code[i]);
			i++;
			continue;
		}
		const t = m[0];
		if (t.startsWith("<")) out += span("keyword", t);
		else if (t.endsWith(">")) {
			out += span("keyword", t);
			inTag = false;
		} else if (t[0] === '"' || t[0] === "'") out += span("string", t);
		else out += span("type", t);
		i += t.length;
	}
	return out;
}

/** Highlighted HTML for a code block in the given fence language; escaped plain text for a language it doesn't know. */
export function highlight(code, lang) {
	const family = ALIASES[String(lang || "").toLowerCase()];
	if (!family) return escapeHtml(code);
	const f = FAMILIES[family];
	return f.markup ? highlightMarkup(code) : highlightCode(code, f);
}
