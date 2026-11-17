// Chat-list logic that needs no page: the searchable text of a chat, matching and snippets, a chat as Markdown,
// and backups (the file's contents and the checks an imported one goes through). Shared by the app and the tests.

const MAX_TEXT = 200000;
const MAX_TERMS = 8;
const MAX_TITLE = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const TOOLS = ["python", "web"];

export function makeTitle(text) {
	const line = String(text ?? "").replace(/\s+/g, " ").trim();
	return line.length > 60 ? `${line.slice(0, 57)}…` : line || "New chat";
}

/** What search looks through: every message's text and the names of attached files. */
export function chatText(chat) {
	const parts = [];
	let size = 0;
	for (const m of chat.messages || []) {
		for (const piece of [...(m.files || []).map((f) => f.name), m.content]) {
			if (!piece || size >= MAX_TEXT) continue;
			const text = String(piece).slice(0, MAX_TEXT - size);
			parts.push(text);
			size += text.length + 1;
		}
	}
	return parts.join("\n");
}

/** The words of a search, lowercased. A chat matches when it has every one of them. */
export function searchTerms(query) {
	return [...new Set(String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean))].slice(0, MAX_TERMS);
}

export function matchesTerms(terms, lowerTitle, lowerText) {
	return terms.every((t) => lowerTitle.includes(t) || lowerText.includes(t));
}

const squash = (s) => s.replace(/\s+/g, " ");

/**
 * The text around the first place a search word appears, as [{ text, hit }] pieces, or [] when none appears in
 * the text (the title matched instead). lower is text.toLowerCase(), passed in so a search lowercases a chat once.
 */
export function snippet(text, lower, terms, width = 110) {
	let at = -1;
	let length = 0;
	for (const t of terms) {
		const i = lower.indexOf(t);
		if (i !== -1 && (at === -1 || i < at)) {
			at = i;
			length = t.length;
		}
	}
	if (at === -1) return [];
	const lead = Math.min(at, Math.floor(width / 4));
	const start = at - lead;
	const end = Math.min(text.length, start + width);
	return [
		{ text: (start > 0 ? "…" : "") + squash(text.slice(start, at)).trimStart(), hit: false },
		{ text: squash(text.slice(at, at + length)), hit: true },
		{ text: squash(text.slice(at + length, end)).trimEnd() + (end < text.length ? "…" : ""), hit: false },
	].filter((p) => p.text);
}

// The longest run of backticks in the text decides the fence, so code that has fences of its own stays intact.
function fenced(text, lang = "") {
	const longest = Math.max(2, ...(String(text).match(/`+/g) || []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	return `${fence}${lang}\n${text}\n${fence}`;
}

function toolLines(tools) {
	const out = [];
	for (const t of tools || []) {
		const r = t.result || {};
		if (t.name === "web_search") out.push(`> Searched the web for “${t.args?.query ?? ""}”`);
		else if (t.name === "fetch_url") out.push(`> Read ${t.args?.url ?? "a page"}`);
		else if (t.name === "run_python") {
			out.push(`Ran Python:\n\n${fenced(String(t.args?.code ?? ""), "python")}`);
			const output = [r.stdout, r.stderr, r.error].filter(Boolean).join("\n");
			if (output) out.push(`Output:\n\n${fenced(output)}`);
			if (r.images?.length) out.push(`_${r.images.length} figure${r.images.length === 1 ? "" : "s"} not included._`);
		}
	}
	return out;
}

/** A chat as a Markdown document. labelOf(modelId) names the model of a reply. Thinking and images are left out. */
export function chatMarkdown(chat, labelOf = (id) => id) {
	const out = [`# ${squash(chat.title || "Chat").trim()}`];
	for (const m of chat.messages || []) {
		if (m.role === "user") {
			out.push("## You");
			for (const f of m.files || []) out.push(`_File: ${f.name}_`);
			if (m.images?.length) out.push(`_${m.images.length} image${m.images.length === 1 ? "" : "s"} not included._`);
			if (m.content) out.push(m.content);
		} else {
			out.push(`## ${labelOf(m.model) || "Assistant"}`);
			out.push(...toolLines(m.tools));
			if (m.content) out.push(m.content.trim());
			if (m.error) out.push(`_Error: ${m.error}_`);
		}
	}
	return `${out.join("\n\n")}\n`;
}

/** A file name made from a chat title: letters, digits, spaces and dashes, at most 60 characters. */
export function fileName(title, ext) {
	const base = String(title ?? "")
		.normalize("NFC")
		.replace(/[^\p{L}\p{M}\p{N} _-]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 60)
		.trim();
	return `${base || "chat"}.${ext}`;
}

/* ---------- Backups ---------- */

/** A problem with a backup file, worded for the user. */
export class BackupError extends Error {}

export const BACKUP_APP = "thread";
export const BACKUP_VERSION = 1;
// Settings that move with a backup. The sign-in token, usage figures and notification state stay on the device.
export const BACKUP_KEYS = [
	"thread.instructions",
	"thread.developer",
	"thread.theme",
	"thread.model",
	"thread.params",
	"thread.words",
	"thread.words.off",
	"thread.voice",
	"thread.voiceMode",
];

/**
 * The backup file as pieces for a Blob, one per chat, so a long history is never held as a single string.
 * settings: { key: string } for the BACKUP_KEYS that are set.
 */
export function backupParts(chats, settings, now = Date.now()) {
	const head = JSON.stringify({ app: BACKUP_APP, version: BACKUP_VERSION, exported: new Date(now).toISOString(), settings });
	const parts = [`${head.slice(0, -1)},"chats":[`];
	chats.forEach((chat, i) => parts.push((i ? "," : "") + JSON.stringify(chat)));
	parts.push("]}");
	return parts;
}

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v, max = Infinity) => (typeof v === "string" ? v.slice(0, max) : "");
const time = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback);

function cleanTool(t) {
	if (!isObject(t) || typeof t.name !== "string") return null;
	// A call that was still being written or run when the backup was made never finished.
	if (t.preparing) return null;
	const result = isObject(t.result) ? t.result : t.running ? { error: "Stopped before the tool finished." } : {};
	return { id: text(t.id, 100), name: t.name.slice(0, 100), args: isObject(t.args) ? t.args : {}, running: false, result };
}

function cleanMessage(m, newId, now) {
	if (!isObject(m) || (m.role !== "user" && m.role !== "assistant")) return null;
	const out = { id: UUID.test(m.id) ? m.id : newId(), role: m.role, content: text(m.content), time: time(m.time, now) };
	if (m.role === "user") {
		const images = Array.isArray(m.images) ? m.images.filter((src) => typeof src === "string" && IMAGE.test(src)) : [];
		const files = Array.isArray(m.files)
			? m.files
					.filter((f) => isObject(f) && typeof f.name === "string" && typeof f.text === "string")
					.map((f) => ({ name: f.name.slice(0, 255), text: f.text, truncated: f.truncated === true }))
			: [];
		if (images.length) out.images = images;
		if (files.length) out.files = files;
		return out.content || images.length || files.length ? out : null;
	}
	out.reasoning = text(m.reasoning);
	out.model = text(m.model, 200);
	if (Number.isFinite(m.thinkMs) && m.thinkMs > 0) out.thinkMs = m.thinkMs;
	for (const flag of ["stopped", "truncated", "toolCall", "lost"]) if (m[flag] === true) out[flag] = true;
	// A reply that was still coming in can't be picked up from a backup.
	if (m.pending === true || m.resumable === true) out.lost = true;
	if (typeof m.error === "string" && m.error) out.error = m.error;
	const tools = Array.isArray(m.tools) ? m.tools.map(cleanTool).filter(Boolean) : [];
	if (tools.length) {
		out.tools = tools;
		out.toolsVersion = 1;
	}
	return out;
}

/** A chat from a backup with only the fields the app uses, each of the right type; null when nothing is left of it. */
export function cleanChat(raw, { newId = () => crypto.randomUUID(), now = Date.now() } = {}) {
	if (!isObject(raw) || !UUID.test(raw.id) || !Array.isArray(raw.messages)) return null;
	const messages = raw.messages.map((m) => cleanMessage(m, newId, now)).filter(Boolean);
	if (!messages.length) return null;
	const created = time(raw.created, now);
	const chat = {
		id: raw.id,
		title: text(raw.title, MAX_TITLE).trim() || makeTitle(messages[0].content),
		created,
		updated: time(raw.updated, created),
		messages,
		tools: Array.isArray(raw.tools) ? TOOLS.filter((t) => raw.tools.includes(t)) : [],
	};
	if (raw.renamed === true) chat.renamed = true;
	return chat;
}

/** Reads a backup file's text. Returns { chats, settings, skipped }; throws a BackupError when it isn't one. */
export function parseBackup(json, options) {
	let data;
	try {
		data = JSON.parse(json);
	} catch {
		throw new BackupError("That file isn't a Thread backup (it isn't JSON).");
	}
	if (!isObject(data) || data.app !== BACKUP_APP || !Array.isArray(data.chats)) throw new BackupError("That file isn't a Thread backup.");
	if (!(data.version <= BACKUP_VERSION)) throw new BackupError("That backup was made by a newer version of Thread. Update the app, then import it again.");
	const seen = new Set();
	const chats = [];
	for (const raw of data.chats) {
		const chat = cleanChat(raw, options);
		if (!chat || seen.has(chat.id)) continue;
		seen.add(chat.id);
		chats.push(chat);
	}
	const settings = {};
	if (isObject(data.settings)) {
		for (const key of BACKUP_KEYS) if (typeof data.settings[key] === "string") settings[key] = data.settings[key];
	}
	return { chats, settings, skipped: data.chats.length - chats.length };
}

/**
 * Which chats of a backup to store: those not on the device, and those whose copy here is older.
 * existing: Map of chat id → updated time on this device. Returns { save, kept } (kept: left as they are here).
 */
export function mergePlan(chats, existing) {
	const save = [];
	let kept = 0;
	for (const chat of chats) {
		if (existing.has(chat.id) && existing.get(chat.id) >= chat.updated) kept++;
		else save.push(chat);
	}
	return { save, kept };
}
