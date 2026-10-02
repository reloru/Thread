import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL, MODELS } from "./models.js";
import { ParamError, sanitizeParams } from "../public/params.js";

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_MESSAGES = 400;
const MAX_IMAGES = 24;
const MAX_INSTRUCTIONS = 20000;
const IMAGE_PREFIX = /^data:image\/(png|jpeg|webp|gif);base64,/;
const IMAGE_PLACEHOLDER = "[An image was attached here, but the current model cannot view images.]";

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
		body = await request.json();
	} catch {
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

	let images = 0;
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
				if (++images > MAX_IMAGES) throw new HttpError(400, `At most ${MAX_IMAGES} images per conversation.`);
				return vision ? { type: "image_url", image_url: { url: src } } : { type: "text", text: IMAGE_PLACEHOLDER };
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

async function authorized(request, passcode) {
	const header = request.headers.get("authorization") || "";
	const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
	const enc = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(provided)),
		crypto.subtle.digest("SHA-256", enc.encode(passcode)),
	]);
	return crypto.subtle.timingSafeEqual(a, b);
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
