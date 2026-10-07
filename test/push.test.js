import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSubscription, encryptPayload, vapidAuthorization, vapidPublicKey } from "../src/push.js";
import { b64url, fromB64url } from "../src/http.js";

test("payload encryption reproduces the example in RFC 8291 section 5", async () => {
	const asPublic = fromB64url("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
	const jwk = {
		kty: "EC",
		crv: "P-256",
		x: b64url(asPublic.slice(1, 33)),
		y: b64url(asPublic.slice(33)),
		d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	};
	const serverKeys = {
		privateKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
		publicKey: await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, true, []),
	};
	const body = await encryptPayload(
		new TextEncoder().encode("When I grow up, I want to be a watermelon"),
		"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
		"BTBZMqHH6r4Tts7J_aSIgg",
		{ salt: fromB64url("DGv6ra1nlYgDCS1FRnbzlw"), serverKeys },
	);
	assert.equal(
		b64url(body),
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
	);
});

test("VAPID: an ES256 JWT for the push service's origin, signed by the key in k", async () => {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const env = { VAPID_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)) };
	const now = Date.parse("2026-10-07T12:00:00Z");
	const value = await vapidAuthorization(env, "https://web.push.apple.com/QGuQyavXutnMH-ABC", "https://thread.test", now);
	const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(value);
	assert.ok(m, value);
	assert.deepEqual(JSON.parse(new TextDecoder().decode(fromB64url(m[1]))), { typ: "JWT", alg: "ES256" });
	assert.deepEqual(JSON.parse(new TextDecoder().decode(fromB64url(m[2]))), {
		aud: "https://web.push.apple.com",
		exp: now / 1000 + 12 * 3600,
		sub: "https://thread.test",
	});
	assert.equal(m[4], vapidPublicKey(env));
	const key = await crypto.subtle.importKey("raw", fromB64url(m[4]), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
	const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64url(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`));
	assert.ok(ok);
});

test("subscriptions: https endpoint, 65-byte P-256 point and 16-byte auth secret", () => {
	const p256dh = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
	const auth = "BTBZMqHH6r4Tts7J_aSIgg";
	const good = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", expirationTime: null, keys: { p256dh, auth } };
	assert.deepEqual(cleanSubscription(good), { endpoint: good.endpoint, keys: { p256dh, auth } });
	for (const bad of [
		{ ...good, endpoint: "http://fcm.googleapis.com/x" },
		{ ...good, endpoint: "not a url" },
		{ ...good, keys: { p256dh, auth: "AAAA" } },
		{ ...good, keys: { p256dh: auth, auth } },
		{ endpoint: good.endpoint },
		null,
	]) {
		assert.equal(cleanSubscription(bad), null, JSON.stringify(bad));
	}
});
