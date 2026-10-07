// Web Push from the Worker, without libraries: VAPID signing (RFC 8292) and aes128gcm payload encryption
// (RFC 8291). Subscriptions live in the Guard Durable Object's storage, one per signed-in device.
// VAPID_JWK is the server's P-256 signing key as a private JWK (secret); the public key is derived from it.

import { b64url, fromB64url } from "./http.js";

const enc = new TextEncoder();
const RECORD_SIZE = 4096;
const TTL_SECONDS = 24 * 60 * 60;

const concat = (...parts) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

function vapidJwk(env) {
	if (!env.VAPID_JWK) throw new Error("VAPID_JWK secret is not configured.");
	const { x, y, d } = JSON.parse(env.VAPID_JWK);
	return { kty: "EC", crv: "P-256", x, y, d };
}

/** The application server key the app subscribes with: uncompressed P-256 point, base64url. */
export function vapidPublicKey(env) {
	const { x, y } = vapidJwk(env);
	return b64url(concat([4], fromB64url(x), fromB64url(y)));
}

/** Authorization header value for one push request (RFC 8292 section 3). */
export async function vapidAuthorization(env, endpoint, subject, now = Date.now()) {
	const jwk = vapidJwk(env);
	const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	// exp may be at most 24 hours ahead; 12 leaves room for clock differences.
	const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
	const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
	return `vapid t=${header}.${claims}.${b64url(new Uint8Array(signature))}, k=${vapidPublicKey(env)}`;
}

async function hkdf(salt, ikm, info, bytes) {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/**
 * Encrypts a payload for one subscription (RFC 8291 section 3.4) as a single aes128gcm record.
 * test: { salt, serverKeys } fixes the random values, for checking against the RFC's example.
 */
export async function encryptPayload(plaintext, p256dh, authSecret, test = {}) {
	const uaPublic = fromB64url(p256dh);
	const auth = fromB64url(authSecret);
	// Importing the raw point checks that it is on the P-256 curve.
	const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const serverKeys = test.serverKeys || (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
	const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));
	const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, serverKeys.privateKey, 256));
	const ikm = await hkdf(auth, ecdhSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
	const salt = test.salt || crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
	const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
	// 0x02 marks the last (only) record; no padding.
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(plaintext, [2])));
	const header = new Uint8Array(21 + asPublic.length);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, RECORD_SIZE);
	header[20] = asPublic.length;
	header.set(asPublic, 21);
	return concat(header, ciphertext);
}

/** Sends one notification ({ title, body, ... } as JSON). Returns the push service's HTTP status. */
export async function sendPush(env, subscription, message, subject) {
	const body = await encryptPayload(enc.encode(JSON.stringify(message)), subscription.keys.p256dh, subscription.keys.auth);
	const res = await fetch(subscription.endpoint, {
		method: "POST",
		headers: {
			authorization: await vapidAuthorization(env, subscription.endpoint, subject),
			"content-encoding": "aes128gcm",
			"content-type": "application/octet-stream",
			ttl: String(TTL_SECONDS),
			urgency: "high",
		},
		body,
	});
	await res.body?.cancel();
	return res.status;
}

/** Validates a PushSubscription's toJSON() output. Returns { endpoint, keys } or null. */
export function cleanSubscription(input) {
	try {
		const url = new URL(input.endpoint);
		const p256dh = fromB64url(input.keys.p256dh);
		const auth = fromB64url(input.keys.auth);
		if (url.protocol !== "https:" || input.endpoint.length > 2000 || p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) return null;
		return { endpoint: url.href, keys: { p256dh: input.keys.p256dh, auth: input.keys.auth } };
	} catch {
		return null;
	}
}

// Storage of subscriptions in the Guard Durable Object, keyed by device (sign-in token id).
export const saveSubscription = (storage, device, subscription) => storage.put(`push:${device}`, subscription);
export const dropSubscription = (storage, device) => storage.delete(`push:${device}`);
export async function listSubscriptions(storage) {
	return [...(await storage.list({ prefix: "push:" }))].map(([key, subscription]) => ({ device: key.slice(5), subscription }));
}
