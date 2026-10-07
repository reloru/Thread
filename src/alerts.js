// Notifications sent to every signed-in device that allowed them. {until} in a body is replaced on the device
// with the local time of `until` (public/sw.js).

import { sendPush } from "./push.js";

export const ALERTS = {
	welcome: {
		title: "Notifications are on 🎉",
		body: "This is what a passcode alert will look like, minus the panic.",
	},
	warning: {
		title: "Someone's jiggling the doorknob 🚪",
		body: "4 wrong passcodes in the last hour. One more and Thread changes the locks for 8 hours. You two stay signed in.",
	},
	locked: {
		title: "Thread changed the locks 🔒",
		body: "5 wrong passcodes in an hour, so new logins are frozen until {until}. You two stay signed in; the guesser gets to think about what they did.",
	},
};

// Shown on the lock screen to whoever typed the 4th wrong passcode.
export const LAST_TRY =
	"Wrong again. That's 4 this hour. One more and Thread changes the locks for 8 hours. No pressure. 🙃";

/** Sends a message to every subscribed device; subscriptions the push service reports gone are dropped. */
export async function notifyAll(env, guard, message, subject) {
	const subs = await guard.subscriptions();
	await Promise.all(
		subs.map(async ({ device, subscription }) => {
			try {
				const status = await sendPush(env, subscription, message, subject);
				if (status === 404 || status === 410) await guard.unsubscribe(device);
				else if (status >= 400) console.error("push rejected", status, new URL(subscription.endpoint).host);
			} catch (err) {
				console.error("push failed", err?.message || String(err));
			}
		}),
	);
}
