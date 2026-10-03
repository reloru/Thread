import { ParamError, allowedKeys, hasCustom, toWire } from "./params.js";

const KEY_PARAMS = "thread.params";
const KEY_INSTRUCTIONS = "thread.instructions";
const GROUPS = ["Reasoning", "Sampling", "Output"];

/**
 * Per-model parameter settings and instructions.
 * deps: { storage, el, icon, getChat, onChatInstructions }
 */
export function createSettings(deps) {
	const { storage, el, icon } = deps;
	let all = read();
	let globalText = storage.get(KEY_INSTRUCTIONS) || "";

	function read() {
		try {
			const data = JSON.parse(storage.get(KEY_PARAMS) || "{}");
			return data && typeof data === "object" ? data : {};
		} catch {
			return {};
		}
	}

	function save() {
		storage.set(KEY_PARAMS, JSON.stringify(all));
	}

	function entry(id) {
		all[id] ??= { values: {}, json: "" };
		return all[id];
	}

	function prune(id) {
		if (!hasCustom(all[id])) delete all[id];
		save();
	}

	function globalInstructions() {
		return globalText;
	}

	return {
		hasCustom: (id) => hasCustom(all[id]),
		/** Validated wire params for a model. Throws ParamError. */
		params: (model) => toWire(model, all[model.id]),
		instructionsFor(chat) {
			return (chat?.instructions || "").trim() || globalInstructions().trim();
		},
		reset(id) {
			delete all[id];
			save();
		},
		render(container, model) {
			const chat = deps.getChat();
			const status = el("p", "settings-status");
			const validate = () => {
				try {
					toWire(model, all[model.id]);
					status.textContent = "";
					status.classList.remove("error");
				} catch (err) {
					status.textContent = err instanceof ParamError ? err.message : String(err);
					status.classList.add("error");
				}
			};
			const commit = (key, value) => {
				const e = entry(model.id);
				if (value === undefined) delete e.values[key];
				else e.values[key] = value;
				prune(model.id);
				validate();
			};

			const nodes = [];

			const instr = section("Instructions");
			const globalBox = textarea("instr-global", 3, "Applies to every chat. E.g. “Be concise. Use metric units.”");
			globalBox.value = globalInstructions();
			globalBox.addEventListener("input", () => {
				globalText = globalBox.value;
				storage.set(KEY_INSTRUCTIONS, globalText);
			});
			const chatBox = textarea("instr-chat", 2, "Leave empty to use the instructions above");
			chatBox.value = chat?.instructions || "";
			chatBox.addEventListener("input", () => deps.onChatInstructions(chatBox.value));
			instr.append(
				fieldLabel("All chats", "instr-global"),
				globalBox,
				fieldLabel("This chat only", "instr-chat"),
				chatBox,
				hint("Sent as the system message. This chat’s text replaces the all-chats text."),
			);
			nodes.push(instr);

			const values = all[model.id]?.values || {};
			for (const group of GROUPS) {
				const controls = model.controls.filter((c) => c.group === group);
				if (!controls.length) continue;
				const sec = section(group);
				for (const c of controls) sec.append(control(c, values[c.key], commit));
				nodes.push(sec);
			}

			const adv = section("Advanced JSON");
			const jsonBox = textarea("param-json", 5, '{"n": 1}');
			jsonBox.classList.add("mono");
			jsonBox.spellcheck = false;
			jsonBox.autocapitalize = "off";
			jsonBox.value = all[model.id]?.json || "";
			jsonBox.addEventListener("input", () => {
				entry(model.id).json = jsonBox.value;
				prune(model.id);
				validate();
			});
			adv.append(
				hint("Any parameter this model accepts, sent as-is. Fields here override the controls above."),
				jsonBox,
				hint(`Accepted keys: ${allowedKeys(model).join(", ")}`),
			);
			nodes.push(adv, status);

			container.replaceChildren(...nodes);
			validate();
		},
	};

	function section(title) {
		const sec = el("section", "set-group");
		sec.append(el("h3", "", title));
		return sec;
	}

	function fieldLabel(text, id) {
		const label = el("label", "field-label", text);
		label.htmlFor = id;
		return label;
	}

	function hint(text) {
		return el("p", "hint", text);
	}

	function textarea(id, rows, placeholder) {
		const t = el("textarea", "set-text");
		t.id = id;
		t.rows = rows;
		t.placeholder = placeholder;
		return t;
	}

	function control(c, value, commit) {
		const field = el("div", "field");
		const id = `f-${c.path ? `${c.path}-` : ""}${c.key}`;
		const head = el("div", "field-head");
		const label = fieldLabel(c.label, id);
		head.append(label);
		field.append(head);

		const error = el("p", "field-error");
		error.hidden = true;
		const reset = el("button", "field-reset");
		reset.type = "button";
		reset.setAttribute("aria-label", `Reset ${c.label}`);
		reset.append(icon("i-redo"));
		const showReset = (on) => reset.classList.toggle("off", !on);

		const defaultText =
			c.defaultLabel ?? (c.default === undefined ? "Default" : `Default · ${formatOption(c.default)}`);

		if (c.type === "number" || c.type === "integer") {
			const num = el("input", "num");
			num.id = id;
			num.type = "number";
			num.inputMode = c.type === "integer" ? "numeric" : "decimal";
			if (c.min !== undefined) num.min = String(c.min);
			if (c.max !== undefined) num.max = String(c.max);
			num.step = c.type === "integer" ? "1" : String(c.step ?? "any");
			num.placeholder = defaultText;
			if (value !== undefined) num.value = String(value);
			head.append(num, reset);

			// Every keystroke is committed, so a rejected entry restores the value saved when editing began.
			let saved = value;
			let atFocus = value;
			const set = (v) => {
				saved = v;
				commit(c.key, v);
			};
			num.addEventListener("focus", () => (atFocus = saved));

			const useSlider = c.min !== undefined && c.max !== undefined && c.max - c.min <= 100;
			let slider = null;
			if (useSlider) {
				slider = el("input", "slider");
				slider.type = "range";
				slider.min = String(c.type === "integer" ? c.min : Math.floor(c.min / c.step + 1e-9) * c.step);
				slider.max = String(c.max);
				slider.step = c.type === "integer" ? "1" : String(c.step);
				slider.value = String(value ?? c.default ?? c.min);
				slider.setAttribute("aria-label", c.label);
				slider.classList.toggle("unset", value === undefined);
				slider.addEventListener("input", () => {
					const v = Math.max(c.min, Number(slider.value));
					num.value = String(v);
					slider.classList.remove("unset");
					error.hidden = true;
					showReset(true);
					set(v);
				});
				field.append(slider);
			}

			num.addEventListener("input", () => {
				const raw = num.value.trim();
				if (raw === "" && !num.validity.badInput) {
					error.hidden = true;
					showReset(false);
					if (slider) {
						slider.value = String(c.default ?? c.min);
						slider.classList.add("unset");
					}
					set(undefined);
					return;
				}
				const v = Number(raw);
				const ok =
					raw !== "" &&
					Number.isFinite(v) &&
					(c.type !== "integer" || Number.isSafeInteger(v)) &&
					(c.min === undefined || v >= c.min) &&
					(c.max === undefined || v <= c.max);
				if (!ok) {
					error.textContent =
						c.min !== undefined && c.max !== undefined
							? `Enter ${c.type === "integer" ? "a whole number" : "a number"} from ${c.min} to ${c.max}.`
							: `Enter ${c.type === "integer" ? "a whole number" : "a number"}.`;
					error.hidden = false;
					if (saved !== atFocus) {
						set(atFocus);
						showReset(atFocus !== undefined);
						if (slider) {
							slider.value = String(atFocus ?? c.default ?? c.min);
							slider.classList.toggle("unset", atFocus === undefined);
						}
					}
					return;
				}
				error.hidden = true;
				showReset(true);
				if (slider) {
					slider.value = String(v);
					slider.classList.remove("unset");
				}
				set(v);
			});

			reset.addEventListener("click", () => {
				num.value = "";
				num.dispatchEvent(new Event("input"));
			});
			showReset(value !== undefined);
		} else if (c.type === "enum" || c.type === "boolean" || c.type === "format") {
			const options = c.type === "boolean" ? [true, false] : c.options;
			const seg = el("div", "segmented");
			seg.setAttribute("role", "radiogroup");
			seg.setAttribute("aria-label", c.label);
			const buttons = [];
			const select = (v) => {
				for (const b of buttons) b.setAttribute("aria-checked", String(b._value === v));
			};
			const add = (text, v) => {
				const b = el("button", "seg", text);
				b.type = "button";
				b.setAttribute("role", "radio");
				b._value = v;
				b.addEventListener("click", () => {
					select(v);
					commit(c.key, v);
				});
				buttons.push(b);
				seg.append(b);
			};
			add("Default", undefined);
			for (const o of options) add(formatOption(o), o);
			select(value);
			label.removeAttribute("for");
			field.append(seg);
			if (c.default !== undefined) field.append(hint(`Default: ${formatOption(c.default)}`));
		} else {
			const area = textarea(id, 2, c.type === "stop" ? "One per line" : '{"1234": -100}');
			if (c.type === "bias") {
				area.classList.add("mono");
				area.spellcheck = false;
				area.autocapitalize = "off";
			}
			if (value !== undefined) area.value = value;
			area.addEventListener("input", () => commit(c.key, area.value.trim() ? area.value : undefined));
			field.append(area);
		}

		if (c.help) field.append(hint(c.help));
		if (c.note) field.append(el("p", "note", c.note));
		field.append(error);
		return field;
	}
}

function formatOption(v) {
	if (v === true) return "On";
	if (v === false) return "Off";
	return String(v);
}
