// Passcode lockouts. Signed-in devices use tokens and are never locked out; these rules apply to passcodes.
// Global: 5 wrong passcodes within an hour, from anywhere, freeze passcode logins for 8 hours. The 4th sends a
// warning. Per IP: five wrong passcodes lock that IP for 15 minutes; each further lockout doubles, up to
// 24 hours; a correct passcode, or 24 hours without a failure after a lockout ends, clears it.
// While locked, every passcode is refused, right or wrong, so guessing stops there.

export const LOCKOUT = {
	maxFails: 5,
	baseMs: 15 * 60 * 1000,
	maxMs: 24 * 60 * 60 * 1000,
	forgetMs: 24 * 60 * 60 * 1000,
	keepMs: 7 * 24 * 60 * 60 * 1000,
};

export const GLOBAL = {
	maxFails: 5,
	windowMs: 60 * 60 * 1000,
	lockMs: 8 * 60 * 60 * 1000,
};

/** Per-IP state after one wrong passcode. row: { fails, lockouts, last, until } or undefined. */
export function afterFailure(row, now) {
	let { fails = 0, lockouts = 0, until = 0 } = row || {};
	if (row && now - Math.max(row.last || 0, until) > LOCKOUT.forgetMs) {
		fails = 0;
		lockouts = 0;
	}
	fails++;
	if (fails >= LOCKOUT.maxFails) {
		lockouts++;
		until = now + Math.min(LOCKOUT.maxMs, LOCKOUT.baseMs * 2 ** (lockouts - 1));
		fails = 0;
	}
	return { fails, lockouts, last: now, until };
}

/**
 * Global state after one wrong passcode. state: { fails: [times], until } or undefined.
 * event: "warning" at the 4th failure within the window, "locked" at the 5th, else null.
 */
export function afterGlobalFailure(state, now) {
	const fails = (state?.fails || []).filter((t) => now - t < GLOBAL.windowMs);
	fails.push(now);
	if (fails.length >= GLOBAL.maxFails) return { state: { fails: [], until: now + GLOBAL.lockMs }, event: "locked" };
	return { state: { fails, until: 0 }, event: fails.length === GLOBAL.maxFails - 1 ? "warning" : null };
}

/**
 * Records one passcode attempt and decides it. storage: Durable Object storage (get, put, delete, list).
 * Returns { allowed, until, scope, event }: until > 0 while locked ("global" or "ip" scope); event is
 * "warning" or "locked" when this attempt crossed a global threshold.
 */
export async function attempt(storage, ip, ok, now = Date.now()) {
	const global = await storage.get("global");
	if (global && global.until > now) return { allowed: false, until: global.until, scope: "global", event: null };
	const key = `ip:${ip}`;
	const row = await storage.get(key);
	if (row && row.until > now) return { allowed: false, until: row.until, scope: "ip", event: null };
	if (ok) {
		if (row) await storage.delete(key);
		return { allowed: true, until: 0, scope: null, event: null };
	}
	const next = afterFailure(row, now);
	const g = afterGlobalFailure(global, now);
	await storage.put(key, next);
	await storage.put("global", g.state);
	await prune(storage, now);
	if (g.event === "locked") return { allowed: false, until: g.state.until, scope: "global", event: "locked" };
	if (next.until > now) return { allowed: false, until: next.until, scope: "ip", event: g.event };
	return { allowed: false, until: 0, scope: null, event: g.event };
}

async function prune(storage, now) {
	const stale = [];
	for (const [key, row] of await storage.list({ prefix: "ip:" })) {
		if (now - Math.max(row.last || 0, row.until || 0) > LOCKOUT.keepMs) stale.push(key);
	}
	if (stale.length) await storage.delete(stale);
}
