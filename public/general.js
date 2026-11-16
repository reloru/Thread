// Settings page: system and developer instructions sent with every chat, banned words, notifications for this
// device, appearance, and backups of the chats and settings.

import { MAX_WORDS } from "./words.js";
import { BackupError } from "./chats.js";
import { deliver } from "./backup.js";

const KEY_INSTRUCTIONS = "thread.instructions";
const KEY_DEVELOPER = "thread.developer";
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

const plural = (n, word) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
const megabytes = (bytes) => (bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

/** deps: { storage, el, icon, notify, words, backup, picker, onImport, currentModel }. picker: the file input for imports. */
export function createGeneral(deps) {
	const { storage, el, icon, notify, words, backup, picker, onImport, currentModel } = deps;
	let instructions = storage.get(KEY_INSTRUCTIONS) || "";
	let developer = storage.get(KEY_DEVELOPER) || "";
	// Where the backup group reports progress; it is drawn anew each time Settings opens.
	let sayData = () => {};
	picker.addEventListener("change", () => {
		const [file] = picker.files;
		picker.value = "";
		if (file) importBackup(file);
	});

	return {
		/** Sent as the system message with every chat request. */
		instructions: () => instructions.trim(),
		/** Sent as a developer message, or appended to the system message on models that don't follow one. */
		developer: () => developer.trim(),
		render(container) {
			container.replaceChildren(instructionsGroup(), wordsGroup(), notificationsGroup(), appearanceGroup(), dataGroup());
		},
	};

	function group(title, ...children) {
		const sec = el("section", "set-group");
		sec.append(el("h3", "", title), ...children);
		return sec;
	}

	function instructionsGroup() {
		const system = instructionBox({
			id: "set-system",
			label: "System",
			placeholder: "e.g. Keep answers short. Use metric units.",
			value: () => instructions,
			save: (text) => {
				instructions = text;
				return storage.set(KEY_INSTRUCTIONS, text);
			},
			hint: "Sent to the model as the system message, ahead of your messages, with every message you send from now on, in new chats and ones already open. Use it for anything you always want, like the tone or length of replies.",
		});
		const dev = instructionBox({
			id: "set-developer",
			label: "Developer",
			placeholder: "e.g. Answer in plain text without Markdown.",
			value: () => developer,
			save: (text) => {
				developer = text;
				return storage.set(KEY_DEVELOPER, text);
			},
			hint: developerHint(currentModel()),
		});
		const saves = el("p", "hint", "Both save as you type; there's nothing to confirm.");
		return group("Instructions", ...system, ...dev, saves);
	}

	// Says where the developer instructions go on the model in use.
	function developerHint(model) {
		const general = "Sent as a separate developer message after the system message, on models that follow one.";
		if (!model) return general;
		return model.developer
			? `${general} ${model.name} does.`
			: `${general} ${model.name} doesn't (it ignores or refuses one), so on it they're added to the end of the system message.`;
	}

	function instructionBox({ id, label, placeholder, value, save, hint }) {
		const head = el("label", "field-label", label);
		head.htmlFor = id;
		const box = el("textarea", "set-text");
		box.id = id;
		box.rows = 4;
		box.placeholder = placeholder;
		box.value = value();
		const status = el("p", "note");
		status.setAttribute("role", "status");
		status.hidden = true;
		let timer = 0;
		box.addEventListener("input", () => {
			const saved = save(box.value) !== false;
			// Announced once typing pauses, so a screen reader doesn't read it on every keystroke.
			clearTimeout(timer);
			timer = setTimeout(() => {
				status.textContent = saved
					? "Saved. Your next message uses it, in this chat and every other."
					: "Couldn't save on this device. It applies until Thread is closed.";
				status.hidden = false;
			}, 500);
		});
		return [head, box, status, el("p", "hint", hint)];
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
			"Words the model is blocked from writing, in every chat. Each ban covers the word as it appears in a sentence or at the start of one (“word”, “Word”). Turn on “with no space before it” to also catch it right after a quote, bracket or **, which can also block it in code. The model can still use a synonym, and a blocked word can make a reply come out odd; if so, turn banned words off for that model in its settings. Llama 3.3, Granite, Mistral, DeepSeek V4.1 Flash and Inkling 2 Small don't support this.",
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

	function dataGroup() {
		const status = el("p", "note");
		status.setAttribute("role", "status");
		status.hidden = true;
		sayData = (text) => {
			status.textContent = text;
			status.hidden = !text;
		};
		const exportBtn = el("button", "set-btn", "Export backup");
		exportBtn.type = "button";
		const importBtn = el("button", "set-btn", "Import backup");
		importBtn.type = "button";
		// A backup that is made and waiting for a tap: sharing a file has to follow a tap closely, and reading
		// a long history can take longer than the browser allows.
		let ready = null;
		exportBtn.addEventListener("click", async () => {
			exportBtn.disabled = true;
			try {
				if (!ready) {
					sayData("Preparing the backup…");
					ready = await backup.backupFile();
				}
				const { file, count } = ready;
				const what = `${plural(count, "chat")}, ${megabytes(file.size)}`;
				const result = await deliver(file);
				if (result === "blocked") {
					exportBtn.textContent = "Save backup";
					sayData(`The backup is ready (${what}). Tap Save backup.`);
					return;
				}
				ready = null;
				exportBtn.textContent = "Export backup";
				sayData(result === "cancelled" ? "" : result === "saved" ? `Saved ${file.name} (${what}).` : `Backup shared (${what}).`);
			} catch {
				ready = null;
				sayData("Couldn't make the backup.");
			} finally {
				exportBtn.disabled = false;
			}
		});
		importBtn.addEventListener("click", () => picker.click());
		const buttons = el("div", "set-btns");
		buttons.append(exportBtn, importBtn);
		const hint = el(
			"p",
			"hint",
			"Chats and settings are kept only on this device. A backup is one file with every chat, images included, and your instructions, banned words, model settings and appearance. It doesn't include the sign-in. Importing adds the chats this device doesn't have and replaces the ones that are older here; nothing is deleted.",
		);
		return group("Backup", buttons, status, hint);
	}

	async function importBackup(file) {
		sayData("Importing…");
		let result;
		try {
			result = await backup.restore(file);
		} catch (err) {
			sayData(err instanceof BackupError ? err.message : "Couldn't store the chats on this device. It may be out of space.");
			return;
		}
		const said = [result.saved.length ? `Imported ${plural(result.saved.length, "chat")}.` : "That backup has no chats that are new to this device."];
		if (result.saved.length && result.kept) said.push(`${plural(result.kept, "chat")} already up to date here.`);
		if (result.skipped) said.push(`${plural(result.skipped, "chat")} couldn't be read.`);
		sayData(said.join(" "));
		onImport(result.saved);
		const question = "This backup also has settings (instructions, banned words, model settings, appearance). Replace this device's settings with them?";
		if (Object.keys(result.settings).length && backup.settingsDiffer(result.settings) && confirm(question)) {
			backup.applySettings(result.settings);
			location.reload();
		}
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
