// Getting chats off the device and back on: one chat as a Markdown file, and a backup file with every chat and
// the settings (chats.js builds and checks the contents). Files go to the share sheet where the browser can share
// files (iPhone: Save to Files, AirDrop, Notes…), otherwise they download.

import { BACKUP_KEYS, backupParts, chatMarkdown, fileName, mergePlan, parseBackup } from "./chats.js";

/**
 * Hands a file to the user. Returns "shared", "cancelled" (the share sheet was closed), "saved" (downloaded), or
 * "blocked": the browser wants a tap right before sharing, and too long has passed since the last one.
 */
export async function deliver(file) {
	if (navigator.canShare?.({ files: [file] })) {
		try {
			await navigator.share({ files: [file] });
			return "shared";
		} catch (err) {
			if (err?.name === "AbortError") return "cancelled";
			if (err?.name === "NotAllowedError") return "blocked";
		}
	}
	const url = URL.createObjectURL(file);
	const a = document.createElement("a");
	a.href = url;
	a.download = file.name;
	a.hidden = true;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60000);
	return "saved";
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** deps: { db, storage } */
export function createBackup({ db, storage }) {
	return {
		/** A chat as a Markdown file. labelOf(modelId) names each reply's model. */
		chatFile(chat, labelOf) {
			return new File([chatMarkdown(chat, labelOf)], fileName(chat.title, "md"), { type: "text/markdown" });
		},
		/** The backup file: every chat on this device, images included, and the settings. */
		async backupFile(now = Date.now()) {
			const metas = await db.listChats();
			const chats = [];
			for (const meta of metas) {
				const chat = await db.getChat(meta.id);
				if (chat) chats.push(chat);
			}
			const settings = {};
			for (const key of BACKUP_KEYS) {
				const value = storage.get(key);
				if (typeof value === "string") settings[key] = value;
			}
			const file = new File(backupParts(chats, settings, now), `thread-backup-${isoDay(now)}.json`, { type: "application/json" });
			return { file, count: chats.length };
		},
		/**
		 * Stores the chats of a backup file that are new to this device or newer than its copy. Returns
		 * { saved: [ids], kept, skipped, settings }; settings are the backup's, for the caller to offer. Throws a
		 * BackupError (chats.js) when the file isn't a backup.
		 */
		async restore(file) {
			const { chats, settings, skipped } = parseBackup(await file.text());
			const existing = new Map((await db.listChats()).map((m) => [m.id, m.updated]));
			const { save, kept } = mergePlan(chats, existing);
			for (const chat of save) await db.saveChat(chat);
			return { saved: save.map((c) => c.id), kept, skipped, settings };
		},
		/** True when the backup's settings differ from the ones on this device. */
		settingsDiffer(settings) {
			return Object.entries(settings).some(([key, value]) => storage.get(key) !== value);
		},
		/** Replaces this device's settings with a backup's. The page has to reload for them to apply. */
		applySettings(settings) {
			for (const key of BACKUP_KEYS) {
				if (typeof settings[key] === "string") storage.set(key, settings[key]);
				else storage.del(key);
			}
		},
	};
}
