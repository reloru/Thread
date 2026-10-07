// Notifications: a card that asks once (iPhone shows the permission prompt only in response to a tap), the
// push subscription for this device, and keeping it registered with the Worker. sw.js shows what arrives.

const KEY_LATER = "thread.notify.later";
const LATER_MS = 7 * 24 * 60 * 60 * 1000;

const decodeKey = (b64url) => {
	const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
	return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

/** deps: { storage, api, toast, card, allow, later } */
export function createNotify(deps) {
	const { storage, api, toast, card } = deps;
	const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

	// welcome: ask the Worker for a test notification (after the user just allowed them).
	async function register(welcome = false) {
		await navigator.serviceWorker.register("/sw.js");
		const reg = await navigator.serviceWorker.ready;
		let sub = await reg.pushManager.getSubscription();
		if (!sub) {
			const res = await api("/api/push/key");
			if (!res.ok) throw new Error("Notifications are not available.");
			const { key } = await res.json();
			sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(key) });
		}
		const res = await api(`/api/push/subscribe${welcome ? "?welcome=1" : ""}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(sub.toJSON()),
		});
		if (!res.ok) throw new Error("The server did not accept the subscription.");
	}

	deps.allow.addEventListener("click", () => {
		card.hidden = true;
		// Requested directly in the tap handler, before any other await.
		Notification.requestPermission()
			.then((permission) => {
				if (permission !== "granted") return;
				return register(true).then(() => toast("Notifications are on"));
			})
			.catch(() => toast("Couldn't turn on notifications"));
	});
	deps.later.addEventListener("click", () => {
		card.hidden = true;
		storage.set(KEY_LATER, String(Date.now() + LATER_MS));
	});

	return {
		/** After sign-in: keeps an allowed device subscribed, or shows the card if it was never asked. */
		start() {
			if (!supported) return;
			if (Notification.permission === "granted") register().catch(() => {});
			else if (Notification.permission === "default" && !(Number(storage.get(KEY_LATER)) > Date.now())) card.hidden = false;
		},
		/** Before signing this device out: stops alerts to it. */
		signOut() {
			card.hidden = true;
			if (supported && Notification.permission === "granted") api("/api/push/unsubscribe", { method: "POST" }).catch(() => {});
		},
	};
}
