import { test } from "node:test";
import assert from "node:assert/strict";
import { GLOBAL, LOCKOUT, afterFailure, afterGlobalFailure, attempt } from "../src/lockout.js";

// The subset of Durable Object storage that lockout.js uses.
class MemoryStorage {
	constructor() {
		this.map = new Map();
	}
	async get(key) {
		return this.map.get(key);
	}
	async put(key, value) {
		this.map.set(key, structuredClone(value));
	}
	async delete(keys) {
		for (const key of [keys].flat()) this.map.delete(key);
	}
	async list({ prefix = "" } = {}) {
		return new Map([...this.map].filter(([key]) => key.startsWith(prefix)));
	}
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

test("per IP: five wrong passcodes lock the IP for 15 minutes, then each lockout doubles up to 24 hours", () => {
	let row;
	let now = 0;
	for (let i = 1; i < LOCKOUT.maxFails; i++) {
		row = afterFailure(row, now);
		assert.equal(row.until, 0);
		assert.equal(row.fails, i);
	}
	row = afterFailure(row, now);
	assert.equal(row.until, 15 * MIN);
	assert.equal(row.fails, 0);

	const lengths = [];
	for (let n = 0; n < 9; n++) {
		now = row.until;
		for (let i = 0; i < LOCKOUT.maxFails; i++) row = afterFailure(row, now);
		lengths.push((row.until - now) / MIN);
	}
	assert.deepEqual(lengths, [30, 60, 120, 240, 480, 960, 1440, 1440, 1440]);
});

test("per IP: a day without failures after a lockout ends starts the count over", () => {
	let row;
	for (let i = 0; i < LOCKOUT.maxFails * 3; i++) row = afterFailure(row, 0);
	assert.equal(row.lockouts, 3);
	row = afterFailure(row, row.until + 24 * HOUR + 1);
	assert.deepEqual([row.fails, row.lockouts], [1, 0]);
});

test("global: the 4th wrong passcode within an hour warns, the 5th freezes logins for 8 hours", () => {
	let state;
	const events = [];
	for (let i = 0; i < 5; i++) {
		const r = afterGlobalFailure(state, i * 10 * MIN);
		state = r.state;
		events.push(r.event);
	}
	assert.deepEqual(events, [null, null, null, "warning", "locked"]);
	assert.equal(state.until, 40 * MIN + GLOBAL.lockMs);
	assert.equal(GLOBAL.lockMs, 8 * HOUR);
});

test("global: failures older than an hour drop out of the count", () => {
	let state;
	const events = [];
	for (let i = 0; i < 8; i++) {
		const r = afterGlobalFailure(state, i * 20 * MIN);
		state = r.state;
		events.push(r.event);
	}
	assert.deepEqual(events, [null, null, null, null, null, null, null, null], "at most 3 in any hour");
});

test("attempt: after 5 wrong passcodes in an hour every passcode is refused, from any IP, for 8 hours", async () => {
	const storage = new MemoryStorage();
	const results = [];
	for (let i = 0; i < 5; i++) results.push(await attempt(storage, `10.0.0.${i}`, false, i * MIN));
	assert.deepEqual(
		results.map((r) => r.event),
		[null, null, null, "warning", "locked"],
	);
	assert.deepEqual(results[4], { allowed: false, until: 4 * MIN + 8 * HOUR, scope: "global", event: "locked" });
	assert.deepEqual(await attempt(storage, "192.0.2.1", true, 5 * HOUR), { allowed: false, until: 4 * MIN + 8 * HOUR, scope: "global", event: null });
	assert.equal((await attempt(storage, "192.0.2.1", true, 4 * MIN + 8 * HOUR)).allowed, true);
});

test("attempt: slow guessing from one IP still hits the per-IP lockout", async () => {
	const storage = new MemoryStorage();
	let r;
	for (let i = 0; i < 5; i++) r = await attempt(storage, "ip", false, i * 25 * MIN);
	assert.deepEqual(r, { allowed: false, until: 100 * MIN + 15 * MIN, scope: "ip", event: null });
	assert.equal((await attempt(storage, "other", true, 101 * MIN)).allowed, true, "other IPs are not affected");
	assert.equal((await attempt(storage, "ip", true, 101 * MIN)).allowed, false, "the right passcode is refused while locked");
});

test("attempt: a correct passcode clears the IP's record but not the hour's global count", async () => {
	const storage = new MemoryStorage();
	for (let i = 0; i < 3; i++) await attempt(storage, "ip", false, 0);
	assert.equal((await attempt(storage, "ip", true, 1)).allowed, true);
	assert.equal(await storage.get("ip:ip"), undefined);
	assert.equal((await attempt(storage, "ip", false, 2)).event, "warning");
});

test("attempt: refused requests during a lockout do not extend it; idle IP records are pruned after a week", async () => {
	const storage = new MemoryStorage();
	for (let i = 0; i < 5; i++) await attempt(storage, "ip", false, 0);
	for (let i = 0; i < 20; i++) await attempt(storage, "ip", false, MIN);
	assert.equal((await storage.get("global")).until, 8 * HOUR);
	await attempt(storage, "new", false, 8 * 24 * HOUR);
	assert.deepEqual([...storage.map.keys()].filter((k) => k.startsWith("ip:")), ["ip:new"]);
});
