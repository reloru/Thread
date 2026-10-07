// Appearance chosen in Settings: "light", "dark", or nothing to follow the system. A classic script loaded in
// <head>, so the stored choice applies before the page first renders; general.js calls applyTheme on a change.

const THEME_COLORS = { light: "#ffffff", dark: "#0e0e11" };

function applyTheme(theme) {
	const root = document.documentElement;
	const forced = theme === "light" || theme === "dark";
	if (forced) root.dataset.theme = theme;
	else delete root.dataset.theme;
	// The browser bar color: one meta per system scheme, both set to the forced theme's color.
	for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
		meta.content = THEME_COLORS[forced ? theme : (meta.getAttribute("media") || "").includes("dark") ? "dark" : "light"];
	}
}

try {
	applyTheme(localStorage.getItem("thread.theme"));
} catch {}
