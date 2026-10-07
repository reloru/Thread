export const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export class HttpError extends Error {
	constructor(status, message, headers) {
		super(message);
		this.status = status;
		this.headers = headers;
	}
}

export async function readBytes(request, limit, message) {
	if (!request.body) return new Uint8Array(0);
	const reader = request.body.getReader();
	const chunks = [];
	let size = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			throw new HttpError(413, message);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const c of chunks) {
		bytes.set(c, offset);
		offset += c.byteLength;
	}
	return bytes;
}

export function b64url(bytes) {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes base64url (padding optional). Throws on invalid input. */
export function fromB64url(text) {
	const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
	return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

// Workers AI run options: route through an AI Gateway when AI_GATEWAY_ID is set.
export const aiOptions = (env) => (env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined);

export function requireMethod(request, method) {
	if (request.method !== method) throw new HttpError(405, `Use ${method}.`);
}

export function json(data, status = 200, headers = {}) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE, ...headers },
	});
}
