// Shows Markdown in an element and keeps it in step as the text grows. A streaming reply is rendered again on
// every frame; replacing the whole element each time made a long reply slow, dropped a text selection, and
// scrolled a wide code block or table back to its start. Only the blocks that changed are replaced.

import { markdownBlocks } from "./markdown.js";
import { typeset } from "./math.js";

/**
 * What to change on the page to go from the blocks shown to the new ones (both from markdownBlocks):
 * { keep } children stay, then either { code }, the new text of the last block, a code block still being
 * written, or { html } to put after them in place of the rest. Null when nothing changed.
 */
export function diffBlocks(prev, next) {
	let keep = 0;
	const shared = Math.min(prev.length, next.length);
	while (keep < shared && prev[keep].html === next[keep].html) keep++;
	if (keep === prev.length && keep === next.length) return null;
	const a = prev[keep]?.code;
	const b = next[keep]?.code;
	if (a && b && a.lang === b.lang && keep === prev.length - 1 && keep === next.length - 1) return { keep, code: b.text };
	return { keep, html: next.slice(keep).map((block) => block.html).join("") };
}

/** A view of one element: render(src) shows the Markdown, reset() says the element was filled some other way. */
export function blockView(container) {
	let shown = null;
	return {
		render(src) {
			const next = markdownBlocks(src);
			const change = shown && container.children.length === shown.length ? diffBlocks(shown, next) : { keep: 0, html: next.map((b) => b.html).join("") };
			shown = next;
			if (!change) return;
			const code = change.code === undefined ? null : container.children[change.keep]?.querySelector("pre code");
			if (code) {
				code.textContent = change.code;
				return;
			}
			if (change.keep === 0) container.innerHTML = change.html ?? next.map((b) => b.html).join("");
			else {
				while (container.children.length > change.keep) container.lastElementChild.remove();
				container.insertAdjacentHTML("beforeend", change.html ?? next.slice(change.keep).map((b) => b.html).join(""));
			}
			typeset(container);
		},
		reset() {
			shown = null;
		},
	};
}
