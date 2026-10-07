// Device sign-in tokens. Unlocking with the passcode returns "t1.<id>.<sig>", which the app sends instead of
// the passcode. sig is an HMAC of the id under a key derived from SESSION_SECRET and PASSCODE, so changing
// either secret signs every device out, and checking a token needs no storage. Tokens are accepted during a
// passcode lockout: only passcode logins are refused then.

import { HttpError, b64url, fromB64url } from "./http.js";

export const TOKEN_PREFIX = "t1.";
const TOKEN = /^t1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const enc = new TextEncoder();

async function tokenKey(env) {
	if (!env.SESSION_SECRET) throw new HttpError(503, "SESSION_SECRET secret is not configured on the Worker.");
	const base = await crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const derived = await crypto.subtle.sign("HMAC", base, enc.encode(`thread-token:${env.PASSCODE}`));
	return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function issueToken(env) {
	const id = b64url(crypto.getRandomValues(new Uint8Array(16)));
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await tokenKey(env), enc.encode(id)));
	return `${TOKEN_PREFIX}${id}.${b64url(sig)}`;
}

/** The device id of a valid token, or null. */
export async function verifyToken(env, token) {
	const m = TOKEN.exec(token);
	if (!m) return null;
	const ok = await crypto.subtle.verify("HMAC", await tokenKey(env), fromB64url(m[2]), enc.encode(m[1]));
	return ok ? m[1] : null;
}
