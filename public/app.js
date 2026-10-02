import { renderMarkdown } from "./markdown.js";
import * as db from "./db.js";

const $ = (id) => document.getElementById(id);
const els = {
	scroller: $("scroller"),
	messages: $("messages"),
	topbar: document.querySelector(".topbar"),
	input: $("input"),
	form: $("form"),
	sendBtn: $("sendBtn"),
	attachBtn: $("attachBtn"),
	file: $("file"),
	attachments: $("attachments"),
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
	lock: $("lock"),
	lockForm: $("lockForm"),
	passInput: $("passInput"),
	passToggle: $("passToggle"),
	unlockBtn: $("unlockBtn"),
	lockError: $("lockError"),
	toast: $("toast"),
};

const KEY_PASS = "thread.passcode";
const KEY_MODEL = "thread.model";
const MAX_ATTACH = 4;
const MAX_IMAGE_EDGE = 1536;
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
	controller: null,
	stick: true,
};

class AuthError extends Error {}

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
		headers: { ...(options.headers || {}), authorization: `Bearer ${state.passcode || ""}` },
	});
	if (res.status === 401) {
		state.passcode = null;
		storage.del(KEY_PASS);
		showLock("Passcode is no longer valid.");
		throw new AuthError("Locked");
	}
	return res;
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
		const res = await fetch("/api/auth", { method: "POST", headers: { authorization: `Bearer ${pass}` } });
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
	state.chat = { id: uid(), title: "New chat", created: now, updated: now, messages: [] };
	renderConversation();
}

async function openChat(id) {
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
	closeOverlays();
}

async function persist(chat) {
	if (!chat.messages.length) return;
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
		node.append(thinking, answer, error, actions);
		view = { node, thinking, thinkLabel, thinkBody, answer, error, actions, meta, msg };
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

	if (live && !msg.content && !hasReasoning) {
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
	if (msg.truncated) notes.push("Hit length limit");
	view.error.hidden = !msg.error;
	view.error.textContent = msg.error || "";
	view.actions.hidden = live;
	view.actions.querySelector(".copy").hidden = !msg.content;
	view.meta.textContent = [modelLabel(msg.model), ...notes].filter(Boolean).join(" · ");
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

function toApiMessages(messages) {
	return messages
		.filter((m) => !(m.role === "assistant" && !m.content))
		.map((m) => {
			if (m.role === "assistant") return { role: "assistant", content: m.content };
			if (!m.images?.length) return { role: "user", content: m.content };
			return {
				role: "user",
				content: [
					...(m.content ? [{ type: "text", text: m.content }] : []),
					...m.images.map((url) => ({ type: "image_url", image_url: { url } })),
				],
			};
		});
}

async function send() {
	if (state.controller) return;
	const text = els.input.value.trim();
	const images = state.pending.slice();
	if (!text && !images.length) return;
	if (!state.models.length) {
		await loadModels().catch(() => {});
		if (!state.models.length) return;
	}
	const model = currentModel();
	if (images.length && !model.vision) {
		toast(`${model.name} can't read images. Pick a model marked Vision.`);
		return;
	}

	const chat = state.chat;
	const userMsg = { id: uid(), role: "user", content: text, time: Date.now() };
	if (images.length) userMsg.images = images;
	chat.messages.push(userMsg);
	if (chat.messages.length === 1) chat.title = makeTitle(text || "Image");

	els.input.value = "";
	autosize();
	state.pending = [];
	renderAttachments();
	appendMessage(userMsg, false);
	updateEmpty();
	await respond(chat);
}

async function regenerate() {
	if (state.controller) return;
	const chat = state.chat;
	if (chat.messages.at(-1)?.role === "assistant") chat.messages.pop();
	if (chat.messages.at(-1)?.role !== "user") return;
	if (!state.models.length) await loadModels().catch(() => {});
	if (!currentModel()) return;
	renderConversation();
	await respond(chat);
}

async function respond(chat) {
	const model = currentModel();
	const history = toApiMessages(chat.messages);
	const msg = { id: uid(), role: "assistant", content: "", reasoning: "", model: model.id, time: Date.now() };
	chat.messages.push(msg);
	chat.updated = Date.now();
	persist(chat).then(renderChatList);

	const view = appendMessage(msg, true);
	updateRegen();
	state.stick = true;
	scrollToBottom();

	const controller = new AbortController();
	state.controller = controller;
	setStreaming(true);

	let thinkStart = null;
	let frame = 0;
	const schedule = () => {
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			renderAssistant(view, msg, true);
			if (state.stick) scrollToBottom();
		});
	};

	try {
		const res = await api("/api/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: model.id, messages: history }),
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(await errorText(res));
		await readSSE(res.body, (evt) => {
			if (evt.error || evt.errors?.length) {
				const e = evt.error ?? evt.errors[0];
				throw new Error(typeof e === "string" ? e : e.message || "Model error");
			}
			const choice = evt.choices?.[0];
			const delta = choice?.delta || {};
			const reasoning = delta.reasoning_content ?? delta.reasoning;
			if (reasoning) {
				thinkStart ??= performance.now();
				msg.reasoning += reasoning;
			}
			const content = delta.content ?? (typeof evt.response === "string" ? evt.response : "");
			if (content) {
				if (thinkStart !== null && !msg.thinkMs) msg.thinkMs = Math.round(performance.now() - thinkStart);
				msg.content += content;
			}
			if (choice?.finish_reason === "length") msg.truncated = true;
			schedule();
		});
	} catch (err) {
		if (err.name === "AbortError") msg.stopped = true;
		else if (err instanceof AuthError) msg.error = "Locked. Unlock and regenerate.";
		else msg.error = err.message || String(err);
	} finally {
		if (frame) cancelAnimationFrame(frame);
		if (thinkStart !== null && !msg.thinkMs) msg.thinkMs = Math.round(performance.now() - thinkStart);
		if (state.controller === controller) {
			state.controller = null;
			setStreaming(false);
		}
		chat.updated = Date.now();
		renderAssistant(view, msg, false);
		if (state.stick) scrollToBottom();
		await persist(chat);
		renderChatList();
	}
}

async function readSSE(body, onEvent) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value, { stream: true });
			let nl;
			while ((nl = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, nl).replace(/\r$/, "");
				buffer = buffer.slice(nl + 1);
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (data === "[DONE]") return;
				let evt;
				try {
					evt = JSON.parse(data);
				} catch {
					continue;
				}
				onEvent(evt);
			}
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
	els.sendBtn.disabled = !state.controller && !els.input.value.trim() && !state.pending.length;
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
	if (model && !model.vision) {
		toast(`${model.name} can't read images. Pick a model marked Vision.`);
		return;
	}
	for (const file of files) {
		if (!file.type.startsWith("image/")) continue;
		if (state.pending.length >= MAX_ATTACH) {
			toast(`Up to ${MAX_ATTACH} images per message`);
			break;
		}
		try {
			state.pending.push(await downscale(file));
		} catch {
			toast("Couldn't read that image");
		}
	}
	renderAttachments();
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
	els.attachments.replaceChildren(
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
	els.attachBtn.classList.toggle("dim", Boolean(model) && !vision);
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

function closeOverlays() {
	els.drawer.classList.remove("open");
	els.sheet.classList.remove("open");
	els.drawer.inert = true;
	els.sheet.inert = true;
	els.scrim.classList.remove("show");
	clearTimeout(scrimTimer);
	scrimTimer = setTimeout(() => (els.scrim.hidden = true), 260);
}

function openDrawer() {
	renderChatList();
	els.input.blur();
	els.drawer.inert = false;
	els.drawer.classList.add("open");
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

	els.attachBtn.addEventListener("click", () => {
		const model = currentModel();
		if (model && !model.vision) {
			toast(`${model.name} can't read images. Pick a model marked Vision.`);
			return;
		}
		els.file.click();
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
	els.modelList.addEventListener("click", (e) => {
		const row = e.target.closest(".model-row");
		if (row) selectModel(row.dataset.id);
	});
	els.chatList.addEventListener("click", async (e) => {
		const row = e.target.closest(".chat-item");
		if (!row) return;
		if (e.target.closest(".del")) {
			if (!confirm("Delete this chat?")) return;
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
		if (e.key === "Escape") closeOverlays();
	});
}

init();
