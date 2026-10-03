// IndexedDB storage. Chat metadata and message bodies live in separate stores so the
// history list loads without pulling image data.

const DB_NAME = "thread";
const VERSION = 1;
let dbPromise;

function open() {
	dbPromise ??= new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
			if (!db.objectStoreNames.contains("chats")) db.createObjectStore("chats", { keyPath: "id" });
		};
		req.onsuccess = () => {
			const db = req.result;
			// The browser can close the connection (e.g. Safari after backgrounding); reopen on next use.
			db.onclose = () => (dbPromise = null);
			db.onversionchange = () => {
				db.close();
				dbPromise = null;
			};
			resolve(db);
		};
		req.onerror = () => {
			dbPromise = null;
			reject(req.error);
		};
	});
	return dbPromise;
}

async function transaction(stores, mode) {
	try {
		return (await open()).transaction(stores, mode);
	} catch (err) {
		if (err?.name !== "InvalidStateError") throw err;
		dbPromise = null;
		return (await open()).transaction(stores, mode);
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
	const all = await request((await transaction("meta")).objectStore("meta").getAll());
	return all.sort((a, b) => b.updated - a.updated);
}

export async function getChat(id) {
	const tx = await transaction(["meta", "chats"]);
	const [meta, body] = await Promise.all([
		request(tx.objectStore("meta").get(id)),
		request(tx.objectStore("chats").get(id)),
	]);
	return meta && body ? { ...meta, messages: body.messages, instructions: body.instructions } : null;
}

export async function saveChat(chat) {
	const tx = await transaction(["meta", "chats"], "readwrite");
	tx.objectStore("meta").put({ id: chat.id, title: chat.title, created: chat.created, updated: chat.updated });
	tx.objectStore("chats").put({ id: chat.id, messages: chat.messages, instructions: chat.instructions });
	await done(tx);
}

export async function deleteChat(id) {
	const tx = await transaction(["meta", "chats"], "readwrite");
	tx.objectStore("meta").delete(id);
	tx.objectStore("chats").delete(id);
	await done(tx);
}
