// Settings page: instructions sent with every chat, banned words, notifications for this device, and appearance.

import { MAX_WORDS } from "./words.js";

const KEY_INSTRUCTIONS = "thread.instructions";
const KEY_THEME = "thread.theme";
const THEMES = [
	["system", "System"],
	["light", "Light"],
	["dark", "Dark"],
];
const ALERTS_TEXT = "Get an alert on this device when someone keeps entering the wrong passcode.";
const NOTIFY_TEXT = {
	on: ALERTS_TEXT,
	off: ALERTS_TEXT,
	unsupported: "This browser can't show notifications from Thread. On iPhone, add Thread to your Home Screen first.",
	blocked: "Notifications are blocked for Thread. Allow them in your device's settings, then come back here.",
};

/** A switch row (the markup of the voice picker's). Returns { row, set(checked), setSub(text) }. */
export function switchRow(el, { title, sub, checked, onToggle }) {
	const row = el("button", "switch-row");
	row.type = "button";
	row.setAttribute("role", "switch");
	const text = el("span", "switch-text");
	const small = el("small", "", sub);
	small.hidden = !sub;
	text.append(el("b", "", title), small);
	const knob = el("i", "switch");
	knob.setAttribute("aria-hidden", "true");
	row.append(text, knob);
	const set = (on) => row.setAttribute("aria-checked", String(on));
	set(checked);
	row.addEventListener("click", () => onToggle(row.getAttribute("aria-checked") !== "true"));
	return {
		row,
		set,
		setSub(t) {
			small.textContent = t;
			small.hidden = !t;
		},
	};
}

/** deps: { storage, el, icon, notify, words, currentModel } */
export function createGeneral(deps) {
	const { storage, el, icon, notify, words, currentModel } = deps;
	let instructions = storage.get(KEY_INSTRUCTIONS) || "";

	return {
		/** Sent as the system message with every chat request. */
		instructions: () => instructions.trim(),
		render(container) {
			container.replaceChildren(instructionsGroup(), wordsGroup(), notificationsGroup(), appearanceGroup());
		},
	};

	function group(title, ...children) {
		const sec = el("section", "set-group");
		sec.append(el("h3", "", title), ...children);
		return sec;
	}

	function instructionsGroup() {
		const box = el("textarea", "set-text");
		box.rows = 4;
		box.placeholder = "e.g. Keep answers short. Use metric units.";
		box.setAttribute("aria-label", "Instructions");
		box.value = instructions;
		box.addEventListener("input", () => {
			instructions = box.value;
			storage.set(KEY_INSTRUCTIONS, instructions);
		});
		const hint = el(
			"p",
			"hint",
			"Sent to the model as the system message in every chat, ahead of your messages. Use it for anything you always want, like the tone or length of replies.",
		);
		return group("Instructions", box, hint);
	}

	function wordsGroup() {
		const form = el("form", "word-add");
		const input = el("input", "word-input");
		input.type = "text";
		input.placeholder = "Add a word";
		input.autocapitalize = "off";
		input.autocomplete = "off";
		input.spellcheck = false;
		input.enterKeyHint = "done";
		input.setAttribute("aria-label", "Word to block");
		const add = el("button", "word-add-btn", "Add");
		add.type = "submit";
		form.append(input, add);
		const error = el("p", "field-error");
		error.hidden = true;
		const list = el("div", "word-list");

		const draw = () => {
			const entries = words.list();
			list.replaceChildren(...entries.map(row));
			form.hidden = false;
			input.disabled = entries.length >= MAX_WORDS;
			const model = currentModel();
			// Whether each word can be blocked on the model in use (it has to be a single token there).
			if (model?.tokenizer) {
				entries.forEach(({ w }, i) => {
					words
						.usable(model, w)
						.then((ok) => {
							if (ok || !list.children[i]?.isConnected) return;
							const note = list.children[i].querySelector(".word-note");
							note.textContent = `Can't be blocked on ${model.name}: this model splits it into pieces that other words use too.`;
							note.hidden = false;
						})
						.catch(() => {});
				});
			}
		};

		const row = ({ w, inside }) => {
			const item = el("div", "word-row");
			const head = el("div", "word-head");
			const del = el("button", "icon-btn");
			del.type = "button";
			del.setAttribute("aria-label", `Remove ${w}`);
			del.append(icon("i-x"));
			del.addEventListener("click", () => {
				words.remove(w);
				draw();
			});
			head.append(el("span", "word-text", w), del);
			const opt = switchRow(el, {
				title: "Also with no space before it",
				sub: "",
				checked: inside,
				onToggle(on) {
					words.setInside(w, on);
					opt.set(on);
				},
			});
			opt.row.classList.add("word-opt");
			const note = el("p", "note word-note");
			note.hidden = true;
			item.append(head, opt.row, note);
			return item;
		};

		form.addEventListener("submit", (e) => {
			e.preventDefault();
			if (!input.value.trim()) return;
			const result = words.add(input.value);
			error.hidden = !result.error;
			error.textContent = result.error || "";
			if (result.error) return;
			input.value = "";
			draw();
		});
		draw();

		const hint = el(
			"p",
			"hint",
			"Words the model is blocked from writing, in every chat. Each ban covers the word as it appears in a sentence or at the start of one (“word”, “Word”). Turn on “with no space before it” to also catch it right after a quote, bracket or **, which can also block it in code. The model can still use a synonym, and a blocked word can make a reply come out odd; if so, turn banned words off for that model in its settings. Llama 3.3, Granite and Mistral don't support this.",
		);
		return group("Banned words", hint, form, error, list);
	}

	function notificationsGroup() {
		const status = () => notify.status();
		const sw = switchRow(el, {
			title: "Allow notifications",
			sub: NOTIFY_TEXT[status()],
			checked: status() === "on",
			onToggle() {
				if (status() === "on") {
					notify.disable();
					sync();
				} else {
					notify.enable().finally(sync);
				}
			},
		});
		const sync = () => {
			sw.set(status() === "on");
			sw.row.disabled = status() === "unsupported" || status() === "blocked";
			sw.setSub(NOTIFY_TEXT[status()]);
		};
		sync();
		return group("Notifications", sw.row);
	}

	function appearanceGroup() {
		const seg = el("div", "segmented");
		seg.setAttribute("role", "radiogroup");
		seg.setAttribute("aria-label", "Appearance");
		const current = storage.get(KEY_THEME) || "system";
		for (const [value, label] of THEMES) {
			const b = el("button", "seg", label);
			b.type = "button";
			b.setAttribute("role", "radio");
			b.setAttribute("aria-checked", String(value === current));
			b.addEventListener("click", () => {
				if (value === "system") storage.del(KEY_THEME);
				else storage.set(KEY_THEME, value);
				// Defined by theme.js, which applies the stored choice before the page first renders.
				globalThis.applyTheme?.(value);
				for (const x of seg.children) x.setAttribute("aria-checked", String(x === b));
			});
			seg.append(b);
		}
		return group("Appearance", seg);
	}
}
