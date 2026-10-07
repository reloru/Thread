// Passcode lockout per client IP. Five wrong passcodes lock the IP for 15 minutes; each further lockout
// doubles, up to 24 hours. A correct passcode, or 24 hours without a failure after a lockout ends, clears it.
// While an IP is locked every request from it is refused, right passcode or not, so guessing stops there.

export const LOCKOUT = {
	maxFails: 5,
	baseMs: 15 * 60 * 1000,
	maxMs: 24 * 60 * 60 * 1000,
	forgetMs: 24 * 60 * 60 * 1000,
	keepMs: 7 * 24 * 60 * 60 * 1000,
};

/** State after one wrong passcode. row: { fails, lockouts, last, until } or undefined. */
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
 * Records one request and decides it. storage: Durable Object storage (get, put, delete, list).
 * Returns { allowed: true } or { allowed: false, until } where until > 0 while the IP is locked.
 */
export async function attempt(storage, ip, ok, now = Date.now()) {
	const key = `ip:${ip}`;
	const row = await storage.get(key);
	if (row && row.until > now) return { allowed: false, until: row.until };
	if (ok) {
		if (row) await storage.delete(key);
		return { allowed: true };
	}
	const next = afterFailure(row, now);
	await storage.put(key, next);
	await prune(storage, now);
	return { allowed: false, until: next.until > now ? next.until : 0 };
}

async function prune(storage, now) {
	const stale = [];
	for (const [key, row] of await storage.list({ prefix: "ip:" })) {
		if (now - Math.max(row.last || 0, row.until || 0) > LOCKOUT.keepMs) stale.push(key);
	}
	if (stale.length) await storage.delete(stale);
}
