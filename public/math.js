// Typesets the formulas markdown.js marks up (<span class="math">TeX</span>) with KaTeX 0.19.1, vendored in
// public/vendor/katex (script, stylesheet and woff2 fonts, as published on npm). Nothing of it is loaded until a
// message has a formula. KaTeX builds its output as DOM nodes and sets styles through the style object, which the
// page's CSP allows; it is never given HTML to parse.

const BASE = "/vendor/katex/";
const TODO = ".math:not([data-done])";
let loading = null;

function load() {
	loading ??= new Promise((resolve, reject) => {
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = `${BASE}katex.min.css`;
		const script = document.createElement("script");
		script.src = `${BASE}katex.min.js`;
		script.onload = () => resolve();
		script.onerror = () => {
			// Offline or a failed request: formulas stay as TeX, and the next one tries again.
			loading = null;
			link.remove();
			script.remove();
			reject(new Error("KaTeX didn't load."));
		};
		document.head.append(link, script);
	});
	return loading;
}

function render(el) {
	const tex = el.textContent;
	el.dataset.done = "";
	try {
		globalThis.katex.render(tex, el, { displayMode: el.hasAttribute("data-display"), throwOnError: true, strict: "ignore" });
	} catch {
		// Not valid TeX (or a command KaTeX doesn't have): the source is shown as it was written.
		el.textContent = tex;
		el.classList.add("math-error");
	}
}

/** Typesets the formulas under root that haven't been yet. Before KaTeX has loaded they show as TeX. */
export function typeset(root) {
	const todo = root.querySelectorAll(TODO);
	if (!todo.length) return;
	if (globalThis.katex) {
		todo.forEach(render);
		return;
	}
	load()
		.then(() => document.querySelectorAll(TODO).forEach(render))
		.catch(() => {});
}
