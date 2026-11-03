// Guards against a page and scripts from different releases. iPhone has served a weeks-old copy of index.html
// alongside current scripts; the scripts then fail on elements the old page lacks and the app stops responding.
// test/page.test.js keeps PAGE_IDS in step with the ids the scripts look up and the ids index.html has.

export const PAGE_IDS = [
	// app.js
	"announce", "app", "attachBtn", "attachments", "chatList", "drawer", "drawerNew", "file", "form", "input",
	"lock", "lockError", "lockForm", "menuBtn", "messages", "modelBtn", "modelList", "modelName", "newBtn",
	"notice", "notifyAllow", "notifyCard", "notifyLater", "passInput", "passToggle", "prefs", "prefsBack",
	"prefsBody", "prefsBtn", "scrim", "scroller", "sendBtn", "settings", "settingsBack", "settingsBody",
	"settingsBtn", "settingsReset", "settingsTitle", "sheet", "toBottom", "toast", "toolChips", "unlockBtn",
	"usage", "voice", "voiceBtn",
	// voice.js
	"voiceChip", "voiceChipName", "voiceClose", "voiceFilter", "voiceHint", "voiceList", "voiceModel",
	"voiceModes", "voiceMute", "voiceOrb", "voiceReply", "voiceScrim", "voiceSheet", "voiceSheetClose",
	"voiceState", "voiceTalkOver", "voiceUser",
];

// Query parameter of the one cache-busting reload; its presence also stops a second reload.
const FRESH = "fresh";

const freshUrl = () => `/?${FRESH}=${Date.now()}`;

/**
 * True when this page has every element the scripts need. Otherwise reloads once from the network, or, if that
 * reload still got a mismatched page, shows a message with a Reload button; returns false either way.
 */
export function checkPage(doc = document, loc = location, hist = history) {
	const missing = PAGE_IDS.filter((id) => !doc.getElementById(id));
	const params = new URLSearchParams(loc.search);
	if (!missing.length) {
		if (params.has(FRESH)) hist.replaceState(null, "", "/");
		return true;
	}
	console.error("Page and scripts are from different versions; missing:", missing.join(", "));
	if (!params.has(FRESH)) {
		loc.replace(freshUrl());
		return false;
	}
	showMismatch(doc, loc);
	return false;
}

function showMismatch(doc, loc) {
	const make = (tag, className, text) => {
		const node = doc.createElement(tag);
		if (className) node.className = className;
		if (text) node.textContent = text;
		return node;
	};
	const card = make("div", "lock-card");
	const reload = make("button", "primary", "Reload");
	reload.type = "button";
	reload.addEventListener("click", () => loc.replace(freshUrl()));
	card.append(
		make("h1", "", "Thread"),
		make("p", "lock-error", "This copy of the app is out of date and couldn't update itself. Reload to get the current version. If that doesn't help, close Thread from the app switcher and open it again."),
		reload,
	);
	const overlay = make("div", "lock");
	overlay.append(card);
	doc.body.replaceChildren(overlay);
}
