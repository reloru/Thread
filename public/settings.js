import { ParamError, hasCustom, toWire } from "./params.js";

const KEY_PARAMS = "thread.params";
const GROUPS = ["Reply length", "Thinking", "Randomness", "Word choice"];
const NOT_SET = "–";
// Display names for option values; the values sent are unchanged.
const OPTION_LABELS = { max: "Max", xhigh: "Extra high", high: "High", medium: "Medium", low: "Low", none: "None" };

/**
 * Per-model parameter settings.
 * deps: { storage, el, icon }
 */
export function createSettings(deps) {
	const { storage, el, icon } = deps;
	let all = read();

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

	return {
		hasCustom: (id) => hasCustom(all[id]),
		/** Validated wire params for a model. Throws ParamError. */
		params: (model) => toWire(model, all[model.id]),
		reset(id) {
			delete all[id];
			save();
		},
		render(container, model) {
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
			const values = all[model.id]?.values || {};
			for (const group of GROUPS) {
				const controls = model.controls.filter((c) => c.group === group && !c.hidden);
				if (!controls.length) continue;
				const sec = section(group);
				for (const c of controls) sec.append(control(c, values[c.key], commit));
				nodes.push(sec);
			}
			nodes.push(status);

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

		if (c.type === "number" || c.type === "integer") {
			const num = el("input", "num");
			num.id = id;
			num.type = "number";
			num.inputMode = c.type === "integer" ? "numeric" : "decimal";
			if (c.min !== undefined) num.min = String(c.min);
			if (c.max !== undefined) num.max = String(c.max);
			num.step = c.type === "integer" ? "1" : String(c.step ?? "any");
			// An empty field shows, greyed out, what applies without a value of your own.
			num.placeholder = c.default !== undefined ? formatOption(c.default) : (c.placeholder ?? NOT_SET);
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
			// With no value of its own, the dimmed slider rests at the default, or mid-range when there is none.
			const rest = () => String(c.default ?? (c.min + c.max) / 2);
			let slider = null;
			if (useSlider) {
				slider = el("input", "slider");
				slider.type = "range";
				slider.min = String(c.type === "integer" ? c.min : Math.floor(c.min / c.step + 1e-9) * c.step);
				slider.max = String(c.max);
				slider.step = c.type === "integer" ? "1" : String(c.step);
				slider.value = value !== undefined ? String(value) : rest();
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
						slider.value = rest();
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
							slider.value = atFocus !== undefined ? String(atFocus) : rest();
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
		} else if (c.type === "enum" || c.type === "boolean") {
			const options = c.type === "boolean" ? [true, false] : c.options;
			const seg = el("div", "segmented");
			seg.setAttribute("role", "radiogroup");
			seg.setAttribute("aria-label", c.label);
			const buttons = [];
			// With no choice of its own, the default option shows selected in grey and nothing is sent.
			const show = (v) => {
				const shown = v === undefined ? c.default : v;
				seg.classList.toggle("is-default", v === undefined);
				for (const b of buttons) b.setAttribute("aria-checked", String(b._value === shown));
				showReset(v !== undefined);
			};
			for (const o of options) {
				const b = el("button", "seg", formatOption(o));
				b.type = "button";
				b.setAttribute("role", "radio");
				b._value = o;
				b.addEventListener("click", () => {
					show(o);
					commit(c.key, o);
				});
				buttons.push(b);
				seg.append(b);
			}
			reset.addEventListener("click", () => {
				show(undefined);
				commit(c.key, undefined);
			});
			head.append(reset);
			show(value);
			label.removeAttribute("for");
			field.append(seg);
		} else {
			const area = textarea(id, 2, c.placeholder ?? "");
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
	return OPTION_LABELS[v] ?? String(v);
}
