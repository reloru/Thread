// IndexedDB storage. Chat metadata and message bodies live in separate stores so the
// history list loads without pulling image data.
//
// Search has a database of its own ("thread-search"): one row of plain text per chat, made from the chat when a
// search finds the row missing or older than the chat. It can be deleted at any time and is rebuilt on the next
// search, and nothing about it can stop the chats themselves from opening.

import { chatText } from "./chats.js";

const MAIN = {
	name: "thread",
	version: 1,
	upgrade(db) {
		if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
		if (!db.objectStoreNames.contains("chats")) db.createObjectStore("chats", { keyPath: "id" });
	},
};
const SEARCH = {
	name: "thread-search",
	version: 1,
	upgrade(db) {
		if (!db.objectStoreNames.contains("text")) db.createObjectStore("text", { keyPath: "id" });
	},
};
const promises = new Map();

function open(spec) {
	if (!promises.has(spec.name)) {
		const forget = () => promises.delete(spec.name);
		promises.set(
			spec.name,
			new Promise((resolve, reject) => {
				const req = indexedDB.open(spec.name, spec.version);
				req.onupgradeneeded = () => spec.upgrade(req.result);
				req.onsuccess = () => {
					const db = req.result;
					// The browser can close the connection (e.g. Safari after backgrounding); reopen on next use.
					db.onclose = forget;
					db.onversionchange = () => {
						db.close();
						forget();
					};
					resolve(db);
				};
				req.onerror = () => {
					forget();
					reject(req.error);
				};
			}),
		);
	}
	return promises.get(spec.name);
}

async function transaction(spec, stores, mode) {
	try {
		return (await open(spec)).transaction(stores, mode);
	} catch (err) {
		if (err?.name !== "InvalidStateError") throw err;
		promises.delete(spec.name);
		return (await open(spec)).transaction(stores, mode);
	}
}

function done(tx) {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

function request(req) {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

export async function listChats() {
	const all = await request((await transaction(MAIN, "meta")).objectStore("meta").getAll());
	return all.sort((a, b) => b.updated - a.updated);
}

export async function getChat(id) {
	const tx = await transaction(MAIN, ["meta", "chats"]);
	const [meta, body] = await Promise.all([
		request(tx.objectStore("meta").get(id)),
		request(tx.objectStore("chats").get(id)),
	]);
	return meta && body ? { ...meta, messages: body.messages, instructions: body.instructions, tools: body.tools || [] } : null;
}

export async function saveChat(chat) {
	const tx = await transaction(MAIN, ["meta", "chats"], "readwrite");
	const meta = { id: chat.id, title: chat.title, created: chat.created, updated: chat.updated };
	// Set when the title was typed by hand, so later edits of the first message leave it alone.
	if (chat.renamed) meta.renamed = true;
	tx.objectStore("meta").put(meta);
	tx.objectStore("chats").put({ id: chat.id, messages: chat.messages, instructions: chat.instructions, tools: chat.tools });
	await done(tx);
}

export async function renameChat(id, title) {
	const tx = await transaction(MAIN, "meta", "readwrite");
	const store = tx.objectStore("meta");
	const meta = await request(store.get(id));
	if (meta) store.put({ ...meta, title, renamed: true });
	await done(tx);
}

export async function deleteChat(id) {
	const tx = await transaction(MAIN, ["meta", "chats"], "readwrite");
	tx.objectStore("meta").delete(id);
	tx.objectStore("chats").delete(id);
	await done(tx);
}

/**
 * Every chat's searchable text: [{ id, title, updated, text }], newest first. Rows for chats that changed since the
 * last search are rebuilt first, and rows of deleted chats removed. A chat whose row can't be made is still
 * returned, with its title only.
 */
export async function searchIndex() {
	const metas = await listChats();
	let rows = new Map();
	try {
		const stored = await request((await transaction(SEARCH, "text")).objectStore("text").getAll());
		rows = new Map(stored.map((r) => [r.id, r]));
	} catch {}
	const fresh = [];
	for (const meta of metas) {
		if (rows.get(meta.id)?.updated === meta.updated) continue;
		try {
			const chat = await getChat(meta.id);
			if (!chat) continue;
			const row = { id: meta.id, updated: meta.updated, text: chatText(chat) };
			rows.set(meta.id, row);
			fresh.push(row);
		} catch {}
	}
	const ids = new Set(metas.map((m) => m.id));
	const gone = [...rows.keys()].filter((id) => !ids.has(id));
	if (fresh.length || gone.length) {
		try {
			const tx = await transaction(SEARCH, "text", "readwrite");
			const store = tx.objectStore("text");
			for (const row of fresh) store.put(row);
			for (const id of gone) store.delete(id);
			await done(tx);
		} catch {}
	}
	return metas.map((m) => ({ id: m.id, title: m.title || "", updated: m.updated, text: rows.get(m.id)?.text || "" }));
}
