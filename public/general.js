// Settings page: instructions sent with every chat, notifications for this device, and appearance.

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

/** deps: { storage, el, notify } */
export function createGeneral(deps) {
	const { storage, el, notify } = deps;
	let instructions = storage.get(KEY_INSTRUCTIONS) || "";

	return {
		/** Sent as the system message with every chat request. */
		instructions: () => instructions.trim(),
		render(container) {
			container.replaceChildren(instructionsGroup(), notificationsGroup(), appearanceGroup());
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

	function notificationsGroup() {
		const row = el("button", "switch-row");
		row.type = "button";
		row.setAttribute("role", "switch");
		const text = el("span", "switch-text");
		const sub = el("small");
		text.append(el("b", "", "Allow notifications"), sub);
		const knob = el("i", "switch");
		knob.setAttribute("aria-hidden", "true");
		row.append(text, knob);
		const sync = () => {
			const status = notify.status();
			row.setAttribute("aria-checked", String(status === "on"));
			row.disabled = status === "unsupported" || status === "blocked";
			sub.textContent = NOTIFY_TEXT[status];
		};
		row.addEventListener("click", () => {
			if (notify.status() === "on") {
				notify.disable();
				sync();
			} else {
				notify.enable().finally(sync);
			}
		});
		sync();
		return group("Notifications", row);
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
