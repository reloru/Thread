// GET /api/usage: Workers AI neurons for the account this month, per UTC day, from the GraphQL Analytics API.
// Analytics rows appear about 10 minutes after a request; `through` is the request time of the newest row,
// so the app can add replies it saw finish after that. Account-wide: the dataset has no per-Worker field.

import { HttpError, json } from "./http.js";

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
// Workers AI pricing: $0.011 per 1,000 neurons above 10,000 free neurons per day, reset at 00:00 UTC.
export const FREE_NEURONS_PER_DAY = 10000;
export const USD_PER_1000_NEURONS = 0.011;
const CACHE_MS = 30 * 1000;

const QUERY = `query($account: String!, $from: Date!, $since: Time!) {
	viewer { accounts(filter: { accountTag: $account }) {
		days: aiInferenceAdaptiveGroups(limit: 31, filter: { date_geq: $from }, orderBy: [date_ASC]) {
			sum { totalNeurons }
			dimensions { date }
		}
		latest: aiInferenceAdaptive(limit: 1, filter: { datetime_geq: $since }, orderBy: [datetime_DESC]) {
			datetime
		}
	} }
}`;

let cache = null;

export async function usage(env, now = Date.now()) {
	if (!env.USAGE_API_TOKEN || !env.USAGE_ACCOUNT_ID) throw new HttpError(503, "Usage tracking is not configured.");
	const today = new Date(now).toISOString().slice(0, 10);
	if (cache && cache.account === env.USAGE_ACCOUNT_ID && cache.data.today === today && now - cache.at < CACHE_MS) {
		return json(cache.data);
	}
	const from = `${today.slice(0, 8)}01`;
	let body;
	try {
		const res = await fetch(GRAPHQL, {
			method: "POST",
			headers: { authorization: `Bearer ${env.USAGE_API_TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ query: QUERY, variables: { account: env.USAGE_ACCOUNT_ID, from, since: `${from}T00:00:00Z` } }),
		});
		body = await res.json();
		if (!res.ok && !body?.errors?.length) throw new Error(`HTTP ${res.status}`);
	} catch (err) {
		throw new HttpError(502, `Usage request failed: ${err?.message || String(err)}`);
	}
	if (body?.errors?.length) throw new HttpError(502, `Usage request failed: ${body.errors[0]?.message || "unknown error"}`);
	const account = body?.data?.viewer?.accounts?.[0];
	if (!account || !Array.isArray(account.days)) throw new HttpError(502, "Usage request returned an unexpected result.");

	const data = {
		today,
		days: account.days.map((d) => ({ date: d.dimensions.date, neurons: d.sum.totalNeurons })),
		through: account.latest?.[0]?.datetime || null,
		freeNeuronsPerDay: FREE_NEURONS_PER_DAY,
		usdPer1000Neurons: USD_PER_1000_NEURONS,
	};
	cache = { account: env.USAGE_ACCOUNT_ID, at: now, data };
	return json(data);
}
