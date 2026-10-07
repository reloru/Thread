// Notifications: a card that asks once (iPhone shows the permission prompt only in response to a tap), the
// on/off switch in Settings, the push subscription for this device, and keeping it registered with the
// Worker. sw.js shows what arrives.

const KEY_LATER = "thread.notify.later";
// Set when notifications are switched off in Settings. The browser permission stays; the Worker stops sending.
const KEY_OFF = "thread.notify.off";
const LATER_MS = 7 * 24 * 60 * 60 * 1000;

const decodeKey = (b64url) => {
	const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
	return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

/** deps: { storage, api, toast, card, allow, later } */
export function createNotify(deps) {
	const { storage, api, toast, card } = deps;
	const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
	const isOff = () => storage.get(KEY_OFF) === "1";

	// welcome: ask the Worker for a test notification (after the user just turned them on).
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

	function unsubscribe() {
		api("/api/push/unsubscribe", { method: "POST" }).catch(() => {});
	}

	/** Must be called from a tap: the permission prompt is requested before any other await. */
	async function enable() {
		card.hidden = true;
		storage.del(KEY_OFF);
		try {
			const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
			if (permission !== "granted") return;
			await register(true);
			toast("Notifications are on");
		} catch {
			storage.set(KEY_OFF, "1");
			toast("Couldn't turn on notifications");
		}
	}

	deps.allow.addEventListener("click", () => enable());
	deps.later.addEventListener("click", () => {
		card.hidden = true;
		storage.set(KEY_LATER, String(Date.now() + LATER_MS));
	});

	return {
		/** After sign-in: keeps an allowed device subscribed, or shows the card if it was never asked. */
		start() {
			if (!supported) return;
			if (Notification.permission === "granted") {
				// Switched off: repeated in case the request made when switching off did not get through.
				if (isOff()) unsubscribe();
				else register().catch(() => {});
			} else if (Notification.permission === "default" && !isOff() && !(Number(storage.get(KEY_LATER)) > Date.now())) {
				card.hidden = false;
			}
		},
		/** "unsupported", "blocked" (denied in the browser or system), "on" or "off". */
		status() {
			if (!supported) return "unsupported";
			if (Notification.permission === "denied") return "blocked";
			return Notification.permission === "granted" && !isOff() ? "on" : "off";
		},
		enable,
		disable() {
			storage.set(KEY_OFF, "1");
			unsubscribe();
		},
	};
}
