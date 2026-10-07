// Service worker for notifications only. The app has no offline mode, so there is no fetch handler.
// A push carries JSON { title, body, until? }; "{until}" in the body becomes the local time of `until`.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {}
	const until = data.until ? new Date(data.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
	const body = String(data.body || "").replace("{until}", until);
	event.waitUntil(self.registration.showNotification(data.title || "Thread", { body, icon: "/icons/icon-192.png", tag: data.tag }));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
			const open = windows[0];
			return open ? open.focus() : self.clients.openWindow("/");
		}),
	);
});
