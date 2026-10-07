import { DurableObject } from "cloudflare:workers";
import { attempt } from "./lockout.js";
import { dropSubscription, listSubscriptions, saveSubscription } from "./push.js";

// Single instance (named "passcode"): passcode lockout counts (lockout.js) and the devices' push subscriptions.
export class Guard extends DurableObject {
	attempt(ip, ok) {
		return attempt(this.ctx.storage, ip, ok);
	}

	subscribe(device, subscription) {
		return saveSubscription(this.ctx.storage, device, subscription);
	}

	unsubscribe(device) {
		return dropSubscription(this.ctx.storage, device);
	}

	subscriptions() {
		return listSubscriptions(this.ctx.storage);
	}
}
