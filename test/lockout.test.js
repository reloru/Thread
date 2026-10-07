import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCKOUT, afterFailure, attempt } from "../src/lockout.js";

// The subset of Durable Object storage that lockout.js uses.
export class MemoryStorage {
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

test("five wrong passcodes lock the IP for 15 minutes, then each lockout doubles up to 24 hours", () => {
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

test("a day without failures after a lockout ends starts the count over", () => {
	let row;
	for (let i = 0; i < LOCKOUT.maxFails * 3; i++) row = afterFailure(row, 0);
	assert.equal(row.lockouts, 3);
	row = afterFailure(row, row.until + 24 * HOUR + 1);
	assert.deepEqual([row.fails, row.lockouts], [1, 0]);
});

test("attempt: a locked IP is refused even with the right passcode; other IPs are not affected", async () => {
	const storage = new MemoryStorage();
	for (let i = 1; i < LOCKOUT.maxFails; i++) assert.deepEqual(await attempt(storage, "1.1.1.1", false, 0), { allowed: false, until: 0 });
	const locked = await attempt(storage, "1.1.1.1", false, 0);
	assert.deepEqual(locked, { allowed: false, until: 15 * MIN });
	assert.deepEqual(await attempt(storage, "1.1.1.1", true, 14 * MIN), { allowed: false, until: 15 * MIN });
	assert.deepEqual(await attempt(storage, "2.2.2.2", true, 14 * MIN), { allowed: true });
	assert.deepEqual(await attempt(storage, "1.1.1.1", true, 15 * MIN), { allowed: true });
	assert.equal(await storage.get("ip:1.1.1.1"), undefined, "a correct passcode clears the record");
});

test("attempt: refused requests during a lockout do not extend it", async () => {
	const storage = new MemoryStorage();
	for (let i = 0; i < LOCKOUT.maxFails; i++) await attempt(storage, "ip", false, 0);
	for (let i = 0; i < 20; i++) await attempt(storage, "ip", false, MIN);
	assert.equal((await storage.get("ip:ip")).until, 15 * MIN);
});

test("attempt: correct passcodes write nothing; records idle for a week are pruned", async () => {
	const storage = new MemoryStorage();
	await attempt(storage, "ok", true, 0);
	assert.equal(storage.map.size, 0);
	await attempt(storage, "old", false, 0);
	await attempt(storage, "new", false, 8 * 24 * HOUR);
	assert.deepEqual([...storage.map.keys()], ["ip:new"]);
});
