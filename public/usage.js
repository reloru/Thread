// Workers AI usage counter beside the tool chips: neurons and billed USD for today (UTC) or this month.
// The base figures come from /api/usage (account analytics, about 10 minutes behind). Replies that finished on
// this device after the newest analytics row are added from the neurons each reply reports when it ends.

const KEY_DATA = "thread.usage.data";
const KEY_LIVE = "thread.usage.live";
const KEY_VIEW = "thread.usage.view";
const REFRESH_MS = 60 * 1000;
const MAX_LIVE = 500;

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// Analytics times have whole seconds, so a reply counts as newer only from the next second on.
const afterCutoff = (t, through) => !through || Math.floor(t / 1000) * 1000 > Date.parse(through);

/**
 * data: /api/usage response; live: [{ t, n }] (request start in ms, neurons); view: "day" | "month".
 * Returns { neurons, usd, label } or null without data.
 */
export function usageFigures(data, live, view, now = Date.now()) {
	if (!data) return null;
	const today = isoDay(now);
	const month = today.slice(0, 7);
	const days = new Map();
	if (data.today?.slice(0, 7) === month) for (const d of data.days) days.set(d.date, d.neurons);
	for (const { t, n } of live) {
		const date = isoDay(t);
		if (date.slice(0, 7) !== month || !afterCutoff(t, data.through)) continue;
		days.set(date, (days.get(date) || 0) + n);
	}
	const billed = (neurons) => (Math.max(0, neurons - data.freeNeuronsPerDay) * data.usdPer1000Neurons) / 1000;
	if (view === "month") {
		let neurons = 0;
		let usd = 0;
		for (const n of days.values()) {
			neurons += n;
			usd += billed(n);
		}
		return { neurons, usd, label: new Date(now).toLocaleString("en-US", { month: "short", timeZone: "UTC" }) };
	}
	const neurons = days.get(today) || 0;
	return { neurons, usd: billed(neurons), label: "today" };
}

export function formatNeurons(n) {
	if (n < 100000) return Math.round(n).toLocaleString("en-US");
	return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function formatUsd(x) {
	if (x <= 0) return "$0.00";
	if (x < 0.01) return "<$0.01";
	return `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** deps: { storage, el, api, canFetch, button } */
export function createUsage(deps) {
	const { storage, el, api, button } = deps;
	const read = (key, fallback) => {
		try {
			return JSON.parse(storage.get(key) || "null") ?? fallback;
		} catch {
			return fallback;
		}
	};
	let data = read(KEY_DATA, null);
	let live = read(KEY_LIVE, []).filter((e) => Number.isFinite(e?.t) && Number.isFinite(e?.n));
	let view = storage.get(KEY_VIEW) === "month" ? "month" : "day";
	let busy = false;
	let off = false;
	let started = false;

	const neuronsLine = el("span", "usage-neurons");
	const costLine = el("span", "usage-cost");
	button.replaceChildren(neuronsLine, costLine);

	function render() {
		const f = off ? null : usageFigures(data, live, view);
		button.hidden = !f;
		if (!f) return;
		neuronsLine.textContent = `${formatNeurons(f.neurons)} neurons`;
		costLine.textContent = `${formatUsd(f.usd)} · ${f.label}`;
		const period = view === "month" ? "this month" : "today";
		button.setAttribute(
			"aria-label",
			`Workers AI usage ${period}: ${Math.round(f.neurons).toLocaleString("en-US")} neurons, ${formatUsd(f.usd)} billed after the free ` +
				`${data.freeNeuronsPerDay.toLocaleString("en-US")} neurons a day. Tap to show ${view === "month" ? "today" : "this month"}.`,
		);
	}

	async function refresh() {
		if (off || busy || !deps.canFetch()) return;
		busy = true;
		try {
			const res = await api("/api/usage");
			if (res.status === 503) {
				off = true;
				data = null;
				storage.del(KEY_DATA);
			} else if (res.ok) {
				data = await res.json();
				const month = data.today.slice(0, 7);
				live = live.filter((e) => isoDay(e.t).slice(0, 7) === month && afterCutoff(e.t, data.through));
				storage.set(KEY_DATA, JSON.stringify(data));
				storage.set(KEY_LIVE, JSON.stringify(live));
			}
		} catch {
			// Keep the last figures; the next refresh tries again.
		} finally {
			busy = false;
			render();
		}
	}

	button.addEventListener("click", () => {
		view = view === "month" ? "day" : "month";
		storage.set(KEY_VIEW, view);
		render();
	});

	render();

	return {
		/** Adds the neurons of a reply that started at time t (ms). */
		record(neurons, t) {
			if (!(neurons > 0) || !Number.isFinite(t)) return;
			live.push({ t, n: neurons });
			if (live.length > MAX_LIVE) live = live.slice(-MAX_LIVE);
			storage.set(KEY_LIVE, JSON.stringify(live));
			render();
		},
		/** Fetches now and every minute while the page is visible. Safe to call more than once. */
		start() {
			refresh();
			if (started) return;
			started = true;
			setInterval(() => {
				if (!document.hidden) refresh();
			}, REFRESH_MS);
			document.addEventListener("visibilitychange", () => {
				if (!document.hidden) refresh();
			});
		},
	};
}
