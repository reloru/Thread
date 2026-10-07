import { test } from "node:test";
import assert from "node:assert/strict";
import { formatNeurons, formatUsd, usageFigures } from "../public/usage.js";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const DATA = {
	today: "2026-10-07",
	days: [
		{ date: "2026-10-05", neurons: 177944 },
		{ date: "2026-10-06", neurons: 8000 },
		{ date: "2026-10-07", neurons: 12000 },
	],
	through: "2026-10-07T11:50:00Z",
	freeNeuronsPerDay: 10000,
	usdPer1000Neurons: 0.011,
};

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("today: neurons since 00:00 UTC, billed above the free 10,000", () => {
	const f = usageFigures(DATA, [], "day", NOW);
	assert.equal(f.neurons, 12000);
	close(f.usd, 0.022);
	assert.equal(f.label, "today");
});

test("month: each day billed on its own above 10,000", () => {
	const f = usageFigures(DATA, [], "month", NOW);
	assert.equal(f.neurons, 197944);
	close(f.usd, ((177944 - 10000) + 0 + (12000 - 10000)) * 0.011 / 1000);
	assert.equal(f.label, "Oct");
});

test("live replies count only when they started after the newest analytics row", () => {
	const through = Date.parse(DATA.through);
	const live = [
		{ t: through - 5000, n: 100 }, // already in analytics
		{ t: through + 400, n: 200 }, // same second as the newest row: may be that row
		{ t: through + 1000, n: 300 },
		{ t: Date.parse("2026-09-30T23:59:00Z"), n: 999 }, // last month
	];
	assert.equal(usageFigures(DATA, live, "day", NOW).neurons, 12300);
	assert.equal(usageFigures({ ...DATA, through: null }, live, "day", NOW).neurons, 12000 + 100 + 200 + 300);
});

test("data from an earlier day or month is used as far as it still applies", () => {
	const tomorrow = Date.parse("2026-10-08T01:00:00Z");
	const live = [{ t: tomorrow - 1000, n: 50 }];
	assert.equal(usageFigures(DATA, live, "day", tomorrow).neurons, 50);
	assert.equal(usageFigures(DATA, live, "month", tomorrow).neurons, 197994);
	const nextMonth = Date.parse("2026-11-01T00:10:00Z");
	assert.equal(usageFigures(DATA, [], "month", nextMonth).neurons, 0);
	assert.equal(usageFigures(null, live, "day", NOW), null);
});

test("formatting", () => {
	assert.equal(formatNeurons(0.4), "0");
	assert.equal(formatNeurons(48210.6), "48,211");
	assert.equal(formatNeurons(184230), "184.2K");
	assert.equal(formatNeurons(1234567), "1.2M");
	assert.equal(formatUsd(0), "$0.00");
	assert.equal(formatUsd(0.004), "<$0.01");
	assert.equal(formatUsd(1.8473), "$1.85");
	assert.equal(formatUsd(1234.5), "$1,234.50");
});
