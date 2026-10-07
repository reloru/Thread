import { DurableObject } from "cloudflare:workers";
import { attempt } from "./lockout.js";

// Single instance (named "passcode") that counts wrong passcodes per client IP; see lockout.js.
export class Guard extends DurableObject {
	attempt(ip, ok) {
		return attempt(this.ctx.storage, ip, ok);
	}
}
