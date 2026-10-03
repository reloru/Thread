import { renderMarkdown } from "./markdown.js";
import * as db from "./db.js";
import { createSettings } from "./settings.js";
import { createVoice } from "./voice.js";

const $ = (id) => document.getElementById(id);
const els = {
	scroller: $("scroller"),
	messages: $("messages"),
	topbar: document.querySelector(".topbar"),
	input: $("input"),
	form: $("form"),
	sendBtn: $("sendBtn"),
	attachBtn: $("attachBtn"),
	voiceBtn: $("voiceBtn"),
	voice: $("voice"),
	file: $("file"),
	attachments: $("attachments"),
	toolChips: $("toolChips"),
	notice: $("notice"),
	toBottom: $("toBottom"),
	menuBtn: $("menuBtn"),
	newBtn: $("newBtn"),
	drawerNew: $("drawerNew"),
	drawer: $("drawer"),
	scrim: $("scrim"),
	chatList: $("chatList"),
	lockBtn: $("lockBtn"),
	modelBtn: $("modelBtn"),
	modelName: $("modelName"),
	sheet: $("sheet"),
	modelList: $("modelList"),
	settingsBtn: $("settingsBtn"),
	settings: $("settings"),
	settingsBack: $("settingsBack"),
	settingsReset: $("settingsReset"),
	settingsTitle: $("settingsTitle"),
	settingsBody: $("settingsBody"),
	lock: $("lock"),
	lockForm: $("lockForm"),
	passInput: $("passInput"),
	passToggle: $("passToggle"),
	unlockBtn: $("unlockBtn"),
	lockError: $("lockError"),
	toast: $("toast"),
	announce: $("announce"),
	app: $("app"),
};

const KEY_PASS = "thread.passcode";
const KEY_MODEL = "thread.model";
const MAX_ATTACH = 4;
const MAX_DOCS = 5;
const MAX_IMAGE_EDGE = 1536;
// Must stay within the Worker's 24-image cap and 20 MB body limit.
const MAX_SEND_IMAGES = 24;
const IMAGE_BYTE_BUDGET = 15 * 1024 * 1024;
const IMAGE_DROPPED = "[An earlier image was omitted to stay within the per-request image limit.]";
const IMAGE_UNSEEN = "[An image was attached here, but the current model cannot view images.]";
const COARSE = matchMedia("(pointer: coarse)").matches;

const storage = {
	get(k) {
		try {
			return localStorage.getItem(k);
		} catch {
			return null;
		}
	},
	set(k, v) {
		try {
			localStorage.setItem(k, v);
		} catch {}
	},
	del(k) {
		try {
			localStorage.removeItem(k);
		} catch {}
	},
};

const state = {
	passcode: storage.get(KEY_PASS),
	models: [],
	defaultModel: null,
	model: storage.get(KEY_MODEL),
	chat: null,
	pending: [],
	docs: [],
	processing: 0,
	busy: false,
	controller: null,
	stick: true,
};

class AuthError extends Error {}

let instructionsTimer = 0;
const settings = createSettings({
	storage,
	el,
	icon,
	getChat: () => state.chat,
	onChatInstructions(value) {
		const chat = state.chat;
		chat.instructions = value.trim() ? value : undefined;
		clearTimeout(instructionsTimer);
		instructionsTimer = setTimeout(() => persist(chat), 400);
	},
});

const voice = createVoice({
	storage,
	el,
	icon,
	toast,
	api,
	isAuthError: (err) => err instanceof AuthError,
	turn: voiceTurn,
	stopReply: abortStream,
	cutReply,
	modelName: () => currentModel()?.name || "",
	syncModal,
});

function init() {
	fitViewport();
	bindEvents();
	els.input.enterKeyHint = COARSE ? "enter" : "send";
	newChat();
	if (!state.passcode) {
		showLock();
		return;
	}
	loadModels().catch(() => {});
	renderChatList();
}

/* ---------- API ---------- */

async function api(path, options = {}) {
	const res = await fetch(path, {
		...options,
		headers: { ...(options.headers || {}), authorization: bearer(state.passcode || "") },
	});
	if (res.status === 401) {
		state.passcode = null;
		storage.del(KEY_PASS);
		showLock("Passcode is no longer valid.");
		throw new AuthError("Locked");
	}
	return res;
}

// Header values must be ISO-8859-1, so the passcode is percent-encoded; the Worker decodes it.
function bearer(pass) {
	return `Bearer ${encodeURIComponent(pass)}`;
}

async function errorText(res) {
	try {
		const data = await res.json();
		if (data?.error) return data.error;
	} catch {}
	return `Request failed (${res.status})`;
}

async function loadModels() {
	try {
		const res = await api("/api/models");
		if (!res.ok) throw new Error(await errorText(res));
		const data = await res.json();
		state.models = data.models;
		state.defaultModel = data.default;
		if (!state.models.some((m) => m.id === state.model)) state.model = data.default;
		updateModelUI();
	} catch (err) {
		if (!(err instanceof AuthError)) toast(err.message || "Couldn't load models");
		throw err;
	}
}

function currentModel() {
	return state.models.find((m) => m.id === state.model) || null;
}

function modelLabel(id) {
	return state.models.find((m) => m.id === id)?.name || id?.split("/").pop() || "";
}

/* ---------- Lock ---------- */

function showLock(message = "") {
	abortStream();
	closeOverlays();
	els.lock.hidden = false;
	syncModal();
	els.lockError.textContent = message;
	els.passInput.value = "";
	setTimeout(() => els.passInput.focus(), 60);
}

async function unlock(event) {
	event.preventDefault();
	const pass = els.passInput.value.trim();
	if (!pass) return;
	els.unlockBtn.disabled = true;
	els.lockError.textContent = "";
	try {
		const res = await fetch("/api/auth", { method: "POST", headers: { authorization: bearer(pass) } });
		if (res.status === 401) {
			els.lockError.textContent = "Incorrect passcode.";
			els.passInput.select();
			return;
		}
		if (!res.ok) {
			els.lockError.textContent = await errorText(res);
			return;
		}
		state.passcode = pass;
		storage.set(KEY_PASS, pass);
		els.lock.hidden = true;
		syncModal();
		els.passInput.blur();
		await loadModels().catch(() => {});
		renderChatList();
	} catch {
		els.lockError.textContent = "Network error. Try again.";
	} finally {
		els.unlockBtn.disabled = false;
	}
}

/* ---------- Chats ---------- */

function uid() {
	return crypto.randomUUID();
}

function newChat() {
	abortStream();
	const now = Date.now();
	state.chat = { id: uid(), title: "New chat", created: now, updated: now, messages: [], tools: [] };
	renderConversation();
	renderToolChips();
}

async function openChat(id) {
	if (id === state.chat?.id) {
		closeOverlays();
		return;
	}
	abortStream();
	let chat = null;
	try {
		chat = await db.getChat(id);
	} catch {}
	if (!chat) {
		toast("Chat not found");
		renderChatList();
		return;
	}
	state.chat = chat;
	renderConversation();
	renderToolChips();
	closeOverlays();
}

function renderToolChips() {
	const on = state.chat?.tools || [];
	for (const chip of els.toolChips.querySelectorAll(".chip")) {
		chip.setAttribute("aria-pressed", String(on.includes(chip.dataset.tool)));
	}
}

function toggleTool(tool) {
	const chat = state.chat;
	const on = new Set(chat.tools || []);
	if (on.has(tool)) on.delete(tool);
	else on.add(tool);
	chat.tools = [...on];
	renderToolChips();
	persist(chat);
}

async function persist(chat) {
	if (!chat.messages.length || chat.deleted) return;
	try {
		await db.saveChat(chat);
	} catch {
		toast("Couldn't save chat on this device");
	}
}

function makeTitle(text) {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > 60 ? `${line.slice(0, 57)}…` : line || "New chat";
}

async function renderChatList() {
	let chats = [];
	try {
		chats = await db.listChats();
	} catch {}
	const list = els.chatList;
	list.replaceChildren();
	if (!chats.length) {
		list.append(el("div", "chat-empty", "No chats yet"));
		return;
	}
	const startOfDay = new Date().setHours(0, 0, 0, 0);
	const day = 86400000;
	const groupOf = (t) =>
		t >= startOfDay ? "Today" : t >= startOfDay - day ? "Yesterday" : t >= startOfDay - 7 * day ? "Previous 7 days" : "Older";
	let current = null;
	for (const c of chats) {
		const g = groupOf(c.updated);
		if (g !== current) {
			current = g;
			list.append(el("div", "chat-group", g));
		}
		const row = el("div", `chat-item${state.chat?.id === c.id ? " active" : ""}`);
		row.dataset.id = c.id;
		const open = el("button", "open", c.title);
		open.type = "button";
		const del = iconButton("i-trash", "Delete chat");
		del.classList.add("del");
		row.append(open, del);
		list.append(row);
	}
}

/* ---------- Rendering ---------- */

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function icon(id) {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
	use.setAttribute("href", `#${id}`);
	svg.append(use);
	return svg;
}

function iconButton(id, label) {
	const b = el("button", "icon-btn");
	b.type = "button";
	b.setAttribute("aria-label", label);
	b.append(icon(id));
	return b;
}

function renderConversation() {
	els.messages.replaceChildren();
	for (const msg of state.chat.messages) appendMessage(msg, false);
	updateEmpty();
	updateRegen();
	state.stick = true;
	scrollToBottom();
}

function updateEmpty() {
	els.scroller.classList.toggle("has-messages", state.chat.messages.length > 0);
}

function appendMessage(msg, live) {
	let view;
	if (msg.role === "user") {
		const node = el("div", "msg user");
		if (msg.images?.length) {
			const imgs = el("div", "user-images");
			for (const src of msg.images) {
				const img = el("img");
				img.src = src;
				img.alt = "Attached image";
				img.loading = "lazy";
				imgs.append(img);
			}
			node.append(imgs);
		}
		if (msg.files?.length) {
			const files = el("div", "user-files");
			for (const f of msg.files) {
				const chip = el("div", "file-chip");
				chip.append(icon("i-file"), el("span", "", f.name));
				files.append(chip);
			}
			node.append(files);
		}
		if (msg.content) node.append(el("div", "bubble", msg.content));
		view = { node };
	} else {
		const node = el("div", "msg assistant");
		const thinking = el("details", "thinking");
		const summary = el("summary");
		const thinkLabel = el("span", "think-label", "Thinking");
		summary.append(thinkLabel, icon("i-chev"));
		const thinkBody = el("div", "thinking-body md");
		thinking.append(summary, thinkBody);
		thinking.hidden = true;
		const toolsBox = el("div", "tool-runs");
		const answer = el("div", "md answer");
		const error = el("div", "error-box");
		error.hidden = true;
		const actions = el("div", "actions");
		const copy = iconButton("i-copy", "Copy response");
		copy.classList.add("copy");
		const regen = iconButton("i-redo", "Regenerate");
		regen.classList.add("regen");
		const meta = el("span", "meta");
		actions.append(copy, regen, meta);
		node.append(thinking, toolsBox, answer, error, actions);
		view = { node, thinking, thinkLabel, thinkBody, toolsBox, answer, error, actions, meta, msg, toolsVersion: -1 };
		thinking.addEventListener("toggle", () => {
			if (thinking.open) thinkBody.innerHTML = renderMarkdown(view.msg.reasoning || "");
		});
		copy.addEventListener("click", () => copyText(view.msg.content, copy));
		regen.addEventListener("click", regenerate);
		renderAssistant(view, msg, live);
	}
	els.messages.append(view.node);
	return view;
}

function formatDuration(ms) {
	const s = Math.max(1, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function renderAssistant(view, msg, live) {
	const hasReasoning = Boolean(msg.reasoning);
	const thinkingLive = live && hasReasoning && !msg.content;
	view.thinking.hidden = !hasReasoning;
	view.thinking.classList.toggle("live", thinkingLive);
	view.thinkLabel.textContent = thinkingLive
		? "Thinking"
		: msg.thinkMs
			? `Thought for ${formatDuration(msg.thinkMs)}`
			: "Thoughts";
	if (hasReasoning && view.thinking.open) view.thinkBody.innerHTML = renderMarkdown(msg.reasoning);

	const tools = msg.tools || [];
	if (view.toolsVersion !== (msg.toolsVersion || 0)) {
		view.toolsVersion = msg.toolsVersion || 0;
		renderToolRuns(view.toolsBox, tools);
	}
	view.toolsBox.hidden = !tools.length;

	if (live && !msg.content && !hasReasoning && !tools.length) {
		if (!view.answer.querySelector(".dots")) {
			view.answer.replaceChildren(el("div", "dots"));
			view.answer.firstChild.append(el("i"), el("i"), el("i"));
		}
	} else {
		view.answer.innerHTML = renderMarkdown(msg.content);
	}
	view.answer.classList.toggle("streaming", live && Boolean(msg.content));

	const notes = [];
	if (msg.stopped) notes.push("Stopped");
	if (msg.pending && !live) notes.push("Interrupted");
	if (msg.truncated) notes.push("Hit length limit");
	if (msg.toolCall) notes.push("Tool call requested (not run)");
	view.error.hidden = !msg.error;
	view.error.textContent = msg.error || "";
	view.actions.hidden = live;
	view.actions.querySelector(".copy").hidden = !msg.content;
	view.meta.textContent = [modelLabel(msg.model), ...notes].filter(Boolean).join(" · ");
}

function renderToolRuns(box, tools) {
	box.replaceChildren(
		...tools.map((t) => {
			const run = el("div", "tool-run");
			const r = t.result || {};
			if (t.name === "fetch_url") {
				const line = el("div", "tool-line");
				line.append(icon("i-globe"));
				let host = t.args?.url || "";
				try {
					host = new URL(host).host;
				} catch {}
				line.append(el("span", "", t.running ? "Reading " : r.error ? "Couldn't read " : "Read "));
				if (/^https?:\/\//.test(t.args?.url || "")) {
					const a = el("a", "", host);
					a.href = t.args.url;
					a.target = "_blank";
					a.rel = "noopener noreferrer";
					line.append(a);
				} else line.append(el("span", "", host || "a page"));
				if (t.running) line.append(el("span", "tool-spin"));
				run.append(line);
				if (r.error) run.append(el("div", "error-box", r.error));
				return run;
			}
			const details = el("details", "tool-details");
			const summary = el("summary");
			summary.append(icon("i-code"), el("span", "", t.running ? "Running Python" : r.error ? "Ran Python · error" : "Ran Python"));
			if (t.running) summary.append(el("span", "tool-spin"));
			summary.append(icon("i-chev"));
			const body = el("div", "tool-body");
			const code = el("div", "md");
			code.innerHTML = renderMarkdown("```python\n" + String(t.args?.code ?? t.args?.raw ?? "") + "\n```");
			body.append(code);
			const out = [r.stdout, r.stderr].filter(Boolean).join("\n");
			if (out) body.append(el("pre", "tool-out", out));
			if (r.error) body.append(el("div", "error-box", r.error));
			details.append(summary, body);
			run.append(details);
			if (r.images?.length) {
				const imgs = el("div", "tool-images");
				for (const b64 of r.images) {
					const img = el("img");
					img.src = `data:image/png;base64,${b64}`;
					img.alt = "Figure from Python";
					imgs.append(img);
				}
				run.append(imgs);
			}
			return run;
		}),
	);
}

function handleToolEvent(msg, ev) {
	msg.tools ??= [];
	if (ev.type === "tool_start") {
		msg.tools.push({ id: ev.id, name: ev.name, args: ev.args || {}, running: true });
		if (msg.content && !msg.content.endsWith("\n\n")) msg.content += "\n\n";
	} else if (ev.type === "tool_result") {
		const t = msg.tools.find((x) => x.id === ev.id && x.running);
		if (t) {
			t.running = false;
			t.result = ev.result || {};
		}
	}
	msg.toolsVersion = (msg.toolsVersion || 0) + 1;
}

function updateRegen() {
	const last = els.messages.lastElementChild;
	for (const b of els.messages.querySelectorAll(".regen")) b.hidden = b.closest(".msg") !== last;
}

function scrollToBottom() {
	const s = els.scroller;
	s.scrollTop = s.scrollHeight;
}

/* ---------- Sending ---------- */

function toApiMessages(messages, vision) {
	// Keep the newest images that fit; older ones become a text note so the request stays sendable.
	let count = 0;
	let bytes = 0;
	const kept = new Map();
	for (let i = messages.length - 1; i >= 0; i--) {
		const images = messages[i].images;
		if (!images?.length) continue;
		kept.set(
			i,
			images.map((url) => {
				const ok = vision && count < MAX_SEND_IMAGES && bytes + url.length <= IMAGE_BYTE_BUDGET;
				if (ok) {
					count++;
					bytes += url.length;
				}
				return ok;
			}),
		);
	}
	const out = [];
	messages.forEach((m, i) => {
		if (m.role === "assistant") {
			const content = [toolSummary(m.tools), m.content].filter(Boolean).join("\n\n");
			if (content) out.push({ role: "assistant", content });
			return;
		}
		const text = [fileText(m.files), m.content].filter(Boolean).join("\n\n");
		if (!m.images?.length) {
			out.push({ role: "user", content: text });
			return;
		}
		const flags = kept.get(i);
		out.push({
			role: "user",
			content: [
				...(text ? [{ type: "text", text }] : []),
				...m.images.map((url, k) =>
					flags[k]
						? { type: "image_url", image_url: { url } }
						: { type: "text", text: vision ? IMAGE_DROPPED : IMAGE_UNSEEN },
				),
			],
		});
	});
	return out;
}

function fileText(files) {
	if (!files?.length) return "";
	return files.map((f) => `[File: ${f.name}${f.truncated ? " (truncated)" : ""}]\n${f.text}`).join("\n\n");
}

// Earlier tool use is replayed as text so stored chats stay valid for any model.
function toolSummary(tools) {
	if (!tools?.length) return "";
	return tools
		.map((t) => {
			const r = t.result || {};
			if (t.name === "fetch_url") return `(Earlier tool use: read ${t.args?.url || "a page"}${r.error ? `, which failed: ${r.error}` : ""}.)`;
			const output = [r.stdout, r.stderr, r.error].filter(Boolean).join("\n").slice(0, 2000) || "(no output)";
			const figs = r.images?.length ? `\n(${r.images.length} figure(s) were shown to the user.)` : "";
			return `(Earlier tool use: ran Python.)\n\`\`\`python\n${t.args?.code ?? ""}\n\`\`\`\nOutput:\n${output}${figs}`;
		})
		.join("\n\n");
}

async function send() {
	if (state.controller || state.busy || state.processing) return;
	state.busy = true;
	try {
		await sendNow();
	} finally {
		state.busy = false;
	}
}

async function sendNow() {
	if (!state.models.length) {
		if (!els.input.value.trim() && !state.pending.length && !state.docs.length) return;
		await loadModels().catch(() => {});
		if (!state.models.length || state.processing) return;
	}
	const text = els.input.value.trim();
	const images = state.pending.slice();
	const docs = state.docs.slice();
	if (!text && !images.length && !docs.length) return;
	const model = currentModel();
	if (images.length && !model.vision) {
		toast(`${model.name} can't read images. Pick a model marked Vision.`);
		return;
	}
	const params = paramsFor(model);
	if (!params) return;

	const chat = state.chat;
	const userMsg = { id: uid(), role: "user", content: text, time: Date.now() };
	if (images.length) userMsg.images = images;
	if (docs.length) userMsg.files = docs;
	chat.messages.push(userMsg);
	if (chat.messages.length === 1) chat.title = makeTitle(text || docs[0]?.name || "Image");

	els.input.value = "";
	autosize();
	state.pending = [];
	state.docs = [];
	renderAttachments();
	appendMessage(userMsg, false);
	updateEmpty();
	await respond(chat, params);
}

// Voice mode: the user cut a finished reply off, so keep only the part that was spoken.
function cutReply(msg, keep) {
	msg.content = msg.content.slice(0, keep);
	msg.stopped = true;
	const chat = state.chat;
	if (!chat.messages.includes(msg)) return;
	renderConversation();
	persist(chat);
}

// A turn spoken in voice mode: same path as a typed message, with the voice request fields and hooks.
async function voiceTurn(text, voiceInfo, hooks) {
	if (state.controller || state.busy) return null;
	state.busy = true;
	try {
		if (!state.models.length) await loadModels().catch(() => {});
		const model = currentModel();
		if (!model) return null;
		const params = paramsFor(model);
		if (!params) return null;
		const chat = state.chat;
		const userMsg = { id: uid(), role: "user", content: text, time: Date.now() };
		chat.messages.push(userMsg);
		if (chat.messages.length === 1) chat.title = makeTitle(text);
		appendMessage(userMsg, false);
		updateEmpty();
		return await respond(chat, params, { ...hooks, voice: voiceInfo });
	} finally {
		state.busy = false;
	}
}

function paramsFor(model) {
	try {
		return settings.params(model);
	} catch (err) {
		toast(`${model.name} settings: ${err.message}`);
		return null;
	}
}

async function regenerate() {
	if (state.controller || state.busy) return;
	state.busy = true;
	try {
		await regenerateNow();
	} finally {
		state.busy = false;
	}
}

async function regenerateNow() {
	const chat = state.chat;
	const lastUser = chat.messages.at(-1)?.role === "assistant" ? chat.messages.at(-2) : chat.messages.at(-1);
	if (lastUser?.role !== "user") return;
	if (!state.models.length) await loadModels().catch(() => {});
	if (state.chat !== chat) return;
	const model = currentModel();
	if (!model) return;
	const params = paramsFor(model);
	if (!params) return;
	const prev = chat.messages.at(-1)?.role === "assistant" ? chat.messages.pop() : null;
	renderConversation();
	const msg = await respond(chat, params);
	if (prev && !msg.content && (msg.error || msg.stopped) && chat.messages.at(-1) === msg) {
		chat.messages[chat.messages.length - 1] = prev;
		await persist(chat);
		if (state.chat === chat) renderConversation();
		if (msg.error) toast(msg.error);
	}
}

// hooks (voice mode): voice = { lang } for the request, onContent(delta, msg) per text chunk, onEnd(msg) before the final render.
async function respond(chat, params, hooks = {}) {
	const model = currentModel();
	const history = toApiMessages(chat.messages, model.vision);
	const msg = { id: uid(), role: "assistant", content: "", reasoning: "", model: model.id, time: Date.now(), pending: true };
	chat.messages.push(msg);
	chat.updated = Date.now();
	persist(chat).then(renderChatList);

	const view = appendMessage(msg, true);
	els.announce.textContent = "";
	updateRegen();
	state.stick = true;
	scrollToBottom();

	const controller = new AbortController();
	state.controller = controller;
	setStreaming(true);

	let thinkStart = null;
	let frame = 0;
	let timer = 0;
	let lastRender = 0;
	let renderCost = 0;
	let lastSave = performance.now();
	// Long replies make each full re-render expensive; space renders out in proportion to their cost.
	const schedule = () => {
		if (frame || timer) return;
		const run = () => {
			timer = 0;
			frame = requestAnimationFrame(() => {
				frame = 0;
				const t0 = performance.now();
				renderAssistant(view, msg, true);
				if (state.stick) scrollToBottom();
				lastRender = performance.now();
				renderCost = lastRender - t0;
				if (lastRender - lastSave > 3000) {
					lastSave = lastRender;
					persist(chat);
				}
			});
		};
		const wait = lastRender + renderCost * 3 - performance.now();
		if (wait > 0) timer = setTimeout(run, wait);
		else run();
	};

	try {
		const res = await api("/api/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: model.id,
				messages: history,
				params,
				instructions: settings.instructionsFor(chat),
				tools: chat.tools?.length ? chat.tools : undefined,
				chatId: chat.id,
				voice: hooks.voice,
			}),
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(await errorText(res));
		let finished = false;
		const sawDone = await readSSE(res.body, (evt) => {
			if (evt.thread) {
				handleToolEvent(msg, evt.thread);
				schedule();
				return;
			}
			if (evt.error || evt.errors?.length) {
				const e = evt.error ?? evt.errors[0];
				throw new Error(typeof e === "string" ? e : e.message || "Model error");
			}
			const choice = evt.choices?.find((c) => (c.index ?? 0) === 0);
			const delta = choice?.delta || {};
			if (delta.tool_calls || choice?.finish_reason === "tool_calls") msg.toolCall = true;
			const reasoning = delta.reasoning_content ?? delta.reasoning;
			if (reasoning) {
				thinkStart ??= performance.now();
				msg.reasoning += reasoning;
			}
			const content = delta.content ?? (typeof evt.response === "string" ? evt.response : "");
			if (content) {
				if (thinkStart !== null && !msg.thinkMs) msg.thinkMs = Math.round(performance.now() - thinkStart);
				msg.content += content;
				hooks.onContent?.(content, msg);
			}
			if (choice?.finish_reason) finished = true;
			if (choice?.finish_reason === "length") msg.truncated = true;
			schedule();
		});
		if (!sawDone && !finished) msg.error = "The reply ended early and may be incomplete. Regenerate to try again.";
	} catch (err) {
		if (err.name === "AbortError") msg.stopped = true;
		else if (err instanceof AuthError) msg.error = "Locked. Unlock and regenerate.";
		else msg.error = err.message || String(err);
	} finally {
		if (frame) cancelAnimationFrame(frame);
		clearTimeout(timer);
		delete msg.pending;
		for (const t of msg.tools || []) {
			if (t.running) {
				t.running = false;
				t.result = { error: "Stopped before the tool finished." };
				msg.toolsVersion = (msg.toolsVersion || 0) + 1;
			}
		}
		if (thinkStart !== null && !msg.thinkMs) msg.thinkMs = Math.round(performance.now() - thinkStart);
		hooks.onEnd?.(msg);
		if (state.controller === controller) {
			state.controller = null;
			setStreaming(false);
		}
		chat.updated = Date.now();
		renderAssistant(view, msg, false);
		if (state.stick) scrollToBottom();
		if (state.chat === chat) els.announce.textContent = msg.error || view.answer.textContent + (msg.stopped ? " Stopped." : "");
		await persist(chat);
		renderChatList();
	}
	return msg;
}

async function readSSE(body, onEvent) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { value, done } = await reader.read();
			buffer += done ? decoder.decode() + "\n" : decoder.decode(value, { stream: true });
			let nl;
			while ((nl = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, nl).replace(/\r$/, "");
				buffer = buffer.slice(nl + 1);
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (data === "[DONE]") return true;
				let evt;
				try {
					evt = JSON.parse(data);
				} catch {
					continue;
				}
				onEvent(evt);
			}
			if (done) return false;
		}
	} catch (err) {
		reader.cancel().catch(() => {});
		throw err;
	}
}

function abortStream() {
	state.controller?.abort();
}

function setStreaming(on) {
	els.sendBtn.classList.toggle("stop", on);
	els.sendBtn.querySelector("use").setAttribute("href", on ? "#i-stop" : "#i-up");
	els.sendBtn.setAttribute("aria-label", on ? "Stop" : "Send");
	updateSend();
}

function updateSend() {
	els.sendBtn.disabled =
		!state.controller && (state.processing > 0 || (!els.input.value.trim() && !state.pending.length && !state.docs.length));
}

function autosize() {
	const t = els.input;
	t.style.height = "auto";
	t.style.height = `${Math.min(t.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
	updateSend();
}

/* ---------- Images ---------- */

async function addFiles(files) {
	const model = currentModel();
	const docs = files.filter((f) => !f.type.startsWith("image/"));
	if (docs.length) addDocs(docs);
	const images = files.filter((f) => f.type.startsWith("image/"));
	if (!images.length) return;
	if (model && !model.vision) {
		toast(`${model.name} can't read images. Pick a model marked Vision.`);
		return;
	}
	const room = MAX_ATTACH - state.pending.length - state.processing;
	if (images.length > room) toast(`Up to ${MAX_ATTACH} images per message`);
	const accepted = images.slice(0, Math.max(0, room));
	state.processing += accepted.length;
	updateSend();
	for (const file of accepted) {
		try {
			state.pending.push(await downscale(file));
		} catch {
			toast("Couldn't read that image");
		} finally {
			state.processing--;
		}
	}
	renderAttachments();
}

async function addDocs(files) {
	const room = MAX_DOCS - state.docs.length;
	if (files.length > room) toast(`Up to ${MAX_DOCS} files per message`);
	const accepted = files.slice(0, Math.max(0, room));
	state.processing += accepted.length;
	renderAttachments();
	for (const file of accepted) {
		try {
			const res = await api("/api/convert", {
				method: "POST",
				headers: { "x-filename": encodeURIComponent(file.name) },
				body: file,
			});
			if (!res.ok) throw new Error(await errorText(res));
			const doc = await res.json();
			state.docs.push(doc);
			if (doc.truncated) toast(`${doc.name} was long; only the first part is included.`);
		} catch (err) {
			if (!(err instanceof AuthError)) toast(err.message || `Couldn't read ${file.name}`);
		} finally {
			state.processing--;
			renderAttachments();
		}
	}
}

async function downscale(file) {
	const url = URL.createObjectURL(file);
	try {
		const img = await new Promise((resolve, reject) => {
			const i = new Image();
			i.onload = () => resolve(i);
			i.onerror = reject;
			i.src = url;
		});
		const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
		const w = Math.max(1, Math.round(img.naturalWidth * scale));
		const h = Math.max(1, Math.round(img.naturalHeight * scale));
		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, w, h);
		ctx.drawImage(img, 0, 0, w, h);
		return canvas.toDataURL("image/jpeg", 0.85);
	} finally {
		URL.revokeObjectURL(url);
	}
}

function renderAttachments() {
	const docChips = state.docs.map((doc, index) => {
		const chip = el("div", "file-chip removable");
		chip.append(icon("i-file"), el("span", "", doc.name));
		const remove = el("button");
		remove.type = "button";
		remove.setAttribute("aria-label", `Remove ${doc.name}`);
		remove.append(icon("i-x"));
		remove.addEventListener("click", () => {
			state.docs.splice(index, 1);
			renderAttachments();
		});
		chip.append(remove);
		return chip;
	});
	if (state.processing) docChips.push(el("div", "file-chip pending", "Reading…"));
	els.attachments.replaceChildren(
		...docChips,
		...state.pending.map((src, index) => {
			const wrap = el("div", "thumb");
			const img = el("img");
			img.src = src;
			img.alt = "Attachment";
			const remove = el("button");
			remove.type = "button";
			remove.setAttribute("aria-label", "Remove image");
			remove.append(icon("i-x"));
			remove.addEventListener("click", () => {
				state.pending.splice(index, 1);
				renderAttachments();
			});
			wrap.append(img, remove);
			return wrap;
		}),
	);
	updateComposerCaps();
	updateSend();
}

function updateComposerCaps() {
	const model = currentModel();
	const vision = Boolean(model?.vision);
	const blocked = state.pending.length > 0 && model && !vision;
	els.notice.hidden = !blocked;
	if (blocked) els.notice.textContent = `${model.name} can't read images. Remove them or switch models.`;
}

/* ---------- Overlays ---------- */

let scrimTimer = 0;

function showScrim() {
	clearTimeout(scrimTimer);
	els.scrim.hidden = false;
	requestAnimationFrame(() => els.scrim.classList.add("show"));
}

function syncModal() {
	const overlay = [els.drawer, els.sheet, els.settings, els.voice].some((o) => o.classList.contains("open"));
	els.app.inert = overlay || !els.lock.hidden;
}

function closeOverlays() {
	closeSettings();
	voice.close();
	els.drawer.classList.remove("open");
	els.sheet.classList.remove("open");
	els.drawer.inert = true;
	els.sheet.inert = true;
	syncModal();
	els.scrim.classList.remove("show");
	clearTimeout(scrimTimer);
	scrimTimer = setTimeout(() => (els.scrim.hidden = true), 260);
}

function openDrawer() {
	renderChatList();
	els.input.blur();
	els.drawer.inert = false;
	els.drawer.classList.add("open");
	syncModal();
	showScrim();
}

function openSheet() {
	if (!state.models.length) {
		loadModels()
			.then(openSheet)
			.catch(() => {});
		return;
	}
	renderModelList();
	els.input.blur();
	els.sheet.inert = false;
	els.sheet.classList.add("open");
	syncModal();
	showScrim();
}

function renderModelList() {
	els.modelList.replaceChildren(
		...state.models.map((m) => {
			const row = el("button", `model-row${m.id === state.model ? " selected" : ""}`);
			row.type = "button";
			row.dataset.id = m.id;
			const info = el("div", "info");
			const name = el("div", "name", m.name);
			if (m.vision) name.append(el("span", "badge", "Vision"));
			if (settings.hasCustom(m.id)) name.append(el("span", "badge muted", "Custom"));
			const ctx = m.context >= 1000000 ? `${Math.round(m.context / 1048576)}M` : `${Math.round(m.context / 1000)}K`;
			const sub = el("div", "sub", `${m.vendor} · ${ctx} context · $${m.price[0]} / $${m.price[1]}`);
			info.append(name, sub);
			const tick = icon("i-check");
			tick.classList.add("tick");
			row.append(info, tick);
			return row;
		}),
	);
}

function openSettings() {
	const model = currentModel();
	if (!model) return;
	closeOverlays();
	els.settingsTitle.textContent = model.name;
	settings.render(els.settingsBody, model);
	els.settingsBody.scrollTop = 0;
	els.settings.inert = false;
	els.settings.classList.add("open");
	syncModal();
	els.settingsBack.focus();
}

function closeSettings() {
	if (!els.settings.classList.contains("open")) return;
	document.activeElement?.blur();
	els.settings.classList.remove("open");
	els.settings.inert = true;
	syncModal();
}

function selectModel(id) {
	state.model = id;
	storage.set(KEY_MODEL, id);
	updateModelUI();
	closeOverlays();
}

function updateModelUI() {
	const model = currentModel();
	els.modelName.textContent = model ? model.name : "Model";
	updateComposerCaps();
}

/* ---------- Utilities ---------- */

let toastTimer = 0;

function toast(text) {
	els.toast.textContent = text;
	els.toast.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (els.toast.hidden = true), 2400);
}

async function copyText(text, button) {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		const ta = el("textarea");
		ta.value = text;
		ta.setAttribute("readonly", "");
		ta.className = "sprite";
		document.body.append(ta);
		ta.select();
		document.execCommand("copy");
		ta.remove();
	}
	if (button?.classList.contains("copy-code")) {
		button.textContent = "Copied";
		setTimeout(() => (button.textContent = "Copy"), 1500);
	} else if (button) {
		const use = button.querySelector("use");
		use.setAttribute("href", "#i-check");
		setTimeout(() => use.setAttribute("href", "#i-copy"), 1500);
	} else {
		toast("Copied");
	}
}

function fitViewport() {
	const vv = window.visualViewport;
	if (!vv) return;
	const root = document.documentElement;
	const apply = () => {
		root.style.setProperty("--vv-h", `${vv.height}px`);
		root.style.setProperty("--vv-top", `${vv.offsetTop}px`);
		document.body.classList.toggle("keyboard", window.innerHeight - vv.height > 120);
		if (state.stick) scrollToBottom();
	};
	vv.addEventListener("resize", apply);
	vv.addEventListener("scroll", apply);
	apply();
}

function bindEvents() {
	els.form.addEventListener("submit", (e) => {
		e.preventDefault();
		if (state.controller) abortStream();
		else send();
	});
	els.input.addEventListener("input", autosize);
	els.input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !COARSE) {
			e.preventDefault();
			if (state.controller) return;
			els.form.requestSubmit();
		}
	});
	els.input.addEventListener("paste", (e) => {
		const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
		if (files.length) {
			e.preventDefault();
			addFiles(files);
		}
	});

	els.attachBtn.addEventListener("click", () => els.file.click());
	els.voiceBtn.addEventListener("click", () => {
		if (state.controller || state.busy) {
			toast("Wait for the reply to finish");
			return;
		}
		if (!state.models.length) {
			toast("Models haven't loaded yet");
			loadModels().catch(() => {});
			return;
		}
		voice.open();
	});
	els.toolChips.addEventListener("click", (e) => {
		const chip = e.target.closest(".chip");
		if (chip) toggleTool(chip.dataset.tool);
	});
	els.file.addEventListener("change", () => {
		const files = [...els.file.files];
		els.file.value = "";
		addFiles(files);
	});

	els.scroller.addEventListener(
		"scroll",
		() => {
			const s = els.scroller;
			const distance = s.scrollHeight - s.scrollTop - s.clientHeight;
			state.stick = distance < 80;
			els.toBottom.classList.toggle("show", distance > 240);
			els.topbar.classList.toggle("scrolled", s.scrollTop > 4);
		},
		{ passive: true },
	);
	els.toBottom.addEventListener("click", () => {
		state.stick = true;
		els.scroller.scrollTo({ top: els.scroller.scrollHeight, behavior: "smooth" });
	});

	els.messages.addEventListener("click", (e) => {
		const btn = e.target.closest(".copy-code");
		if (btn) copyText(btn.closest(".code").querySelector("code").textContent, btn);
	});

	els.menuBtn.addEventListener("click", openDrawer);
	els.newBtn.addEventListener("click", () => {
		newChat();
		renderChatList();
	});
	els.drawerNew.addEventListener("click", () => {
		newChat();
		closeOverlays();
	});
	els.scrim.addEventListener("click", closeOverlays);
	els.modelBtn.addEventListener("click", openSheet);
	els.settingsBtn.addEventListener("click", openSettings);
	els.settingsBack.addEventListener("click", () => {
		closeSettings();
		openSheet();
	});
	els.settingsReset.addEventListener("click", () => {
		const model = currentModel();
		if (!model || !confirm(`Reset all ${model.name} parameters to defaults?`)) return;
		settings.reset(model.id);
		settings.render(els.settingsBody, model);
	});
	els.modelList.addEventListener("click", (e) => {
		const row = e.target.closest(".model-row");
		if (row) selectModel(row.dataset.id);
	});
	els.chatList.addEventListener("click", async (e) => {
		const row = e.target.closest(".chat-item");
		if (!row) return;
		if (e.target.closest(".del")) {
			if (!confirm("Delete this chat?")) return;
			if (state.chat.id === row.dataset.id) state.chat.deleted = true;
			try {
				await db.deleteChat(row.dataset.id);
			} catch {}
			if (state.chat.id === row.dataset.id) newChat();
			renderChatList();
		} else {
			openChat(row.dataset.id);
		}
	});
	els.lockBtn.addEventListener("click", () => {
		state.passcode = null;
		storage.del(KEY_PASS);
		showLock();
	});
	els.lockForm.addEventListener("submit", unlock);
	els.passToggle.addEventListener("click", () => {
		const show = els.passInput.type === "password";
		els.passInput.type = show ? "text" : "password";
		els.passToggle.setAttribute("aria-label", show ? "Hide passcode" : "Show passcode");
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && !voice.isOpen) closeOverlays();
	});
}

init();
