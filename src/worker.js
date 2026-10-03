import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL, MODELS } from "./models.js";
import { ParamError, sanitizeParams } from "../public/params.js";

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_MESSAGES = 400;
const MAX_IMAGES = 24;
const MAX_INSTRUCTIONS = 20000;
const IMAGE_PREFIX = /^data:image\/(png|jpeg|webp|gif);base64,/;
const IMAGE_PLACEHOLDER = "[An image was attached here, but the current model cannot view images.]";
const IMAGE_DROPPED = "[An earlier image was omitted to stay within the per-request image limit.]";

const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
		try {
			return await api(request, env, url);
		} catch (err) {
			if (err instanceof HttpError) return json({ error: err.message }, err.status);
			if (err instanceof ParamError) return json({ error: err.message }, 400);
			console.error("api error", err);
			return json({ error: "Internal error" }, 500);
		}
	},
};

async function api(request, env, url) {
	if (!env.PASSCODE) throw new HttpError(503, "PASSCODE secret is not configured on the Worker.");
	if (!(await authorized(request, env.PASSCODE))) throw new HttpError(401, "Unauthorized");

	switch (url.pathname) {
		case "/api/auth":
			requireMethod(request, "POST");
			return new Response(null, { status: 204, headers: NO_STORE });
		case "/api/models":
			requireMethod(request, "GET");
			return json({ models: MODELS, default: DEFAULT_MODEL });
		case "/api/chat":
			requireMethod(request, "POST");
			return chat(request, env);
		default:
			throw new HttpError(404, "Not found");
	}
}

async function chat(request, env) {
	const length = Number(request.headers.get("content-length") || 0);
	if (length > MAX_BODY_BYTES) throw new HttpError(413, "Request too large.");

	let body;
	try {
		body = JSON.parse(await readBody(request, MAX_BODY_BYTES));
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw new HttpError(400, "Body must be JSON.");
	}

	const model = MODELS.find((m) => m.id === body?.model);
	if (!model) throw new HttpError(400, "Unknown model.");
	const messages = sanitizeMessages(body.messages, model.vision);
	const params = sanitizeParams(body.params, model);
	const instructions = sanitizeInstructions(body.instructions);
	if (instructions) messages.unshift({ role: "system", content: instructions });

	const input = { ...params, messages, stream: true };
	if (input.max_completion_tokens === undefined && input.max_tokens === undefined) {
		// gpt-oss-120b truncates at 256 tokens when no cap is sent.
		input.max_completion_tokens = DEFAULT_MAX_TOKENS;
	}

	const options = env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined;
	let stream;
	try {
		stream = await env.AI.run(model.id, input, options);
	} catch (err) {
		console.error("AI.run failed", model.id, err);
		throw new HttpError(502, `Model request failed: ${err?.message || String(err)}`);
	}

	return new Response(stream, {
		headers: { "content-type": "text/event-stream; charset=utf-8", ...NO_STORE },
	});
}

export function sanitizeMessages(input, vision) {
	if (!Array.isArray(input) || input.length === 0) throw new HttpError(400, "messages must be a non-empty array.");
	if (input.length > MAX_MESSAGES) throw new HttpError(400, "Conversation is too long.");

	// Only the most recent MAX_IMAGES images are sent; older ones become a text note.
	let total = 0;
	for (const m of input) if (Array.isArray(m?.content)) total += m.content.filter((p) => p?.type === "image_url").length;
	let skip = Math.max(0, total - MAX_IMAGES);
	const out = input.map((m) => {
		if (!m || (m.role !== "user" && m.role !== "assistant")) throw new HttpError(400, "Invalid message role.");
		if (typeof m.content === "string") return { role: m.role, content: m.content };
		if (m.role !== "user" || !Array.isArray(m.content) || m.content.length === 0) {
			throw new HttpError(400, "Invalid message content.");
		}
		const parts = m.content.map((p) => {
			if (p?.type === "text" && typeof p.text === "string") return { type: "text", text: p.text };
			const src = p?.type === "image_url" ? p.image_url?.url : undefined;
			if (typeof src === "string" && IMAGE_PREFIX.test(src)) {
				if (!vision) return { type: "text", text: IMAGE_PLACEHOLDER };
				if (skip > 0) {
					skip--;
					return { type: "text", text: IMAGE_DROPPED };
				}
				return { type: "image_url", image_url: { url: src } };
			}
			throw new HttpError(400, "Invalid content part.");
		});
		if (vision) return { role: "user", content: parts };
		return { role: "user", content: parts.map((p) => p.text).join("\n\n") };
	});

	if (out[out.length - 1].role !== "user") throw new HttpError(400, "Last message must be from the user.");
	return out;
}

export function sanitizeInstructions(input) {
	if (input === undefined || input === null) return "";
	if (typeof input !== "string") throw new HttpError(400, "instructions must be a string.");
	if (input.length > MAX_INSTRUCTIONS) throw new HttpError(400, `Instructions are limited to ${MAX_INSTRUCTIONS} characters.`);
	return input.trim();
}

async function readBody(request, limit) {
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks = [];
	let size = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			throw new HttpError(413, "Request too large.");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const c of chunks) {
		bytes.set(c, offset);
		offset += c.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

// The app percent-encodes the passcode (header values must be ISO-8859-1); raw values are accepted too.
async function authorized(request, passcode) {
	const header = request.headers.get("authorization") || "";
	const raw = header.startsWith("Bearer ") ? header.slice(7) : "";
	let decoded = raw;
	try {
		decoded = decodeURIComponent(raw);
	} catch {}
	const enc = new TextEncoder();
	const digest = (s) => crypto.subtle.digest("SHA-256", enc.encode(s));
	const [expected, a, b] = await Promise.all([digest(passcode), digest(raw), digest(decoded)]);
	const okRaw = crypto.subtle.timingSafeEqual(a, expected);
	const okDecoded = crypto.subtle.timingSafeEqual(b, expected);
	return okRaw || okDecoded;
}

function requireMethod(request, method) {
	if (request.method !== method) throw new HttpError(405, `Use ${method}.`);
}

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE },
	});
}
