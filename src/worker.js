import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL, MODELS } from "./models.js";
import { ParamError, isPlainObject, sanitizeParams } from "../public/params.js";
import { agentStream, reasoningAsContent, sanitizeTools } from "./agent.js";
import { HttpError, NO_STORE, aiOptions, json, readBytes, requireMethod } from "./http.js";
import { VOICE_LANGS, speak, transcribe, turn, voiceConfig, voiceInstruction } from "./voice.js";
import { usage } from "./usage.js";
import { TOKEN_PREFIX, issueToken, verifyToken } from "./auth.js";
import { ALERTS, LAST_TRY, notifyAll } from "./alerts.js";
import { cleanSubscription, sendPush, vapidPublicKey } from "./push.js";

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_MESSAGES = 400;
const MAX_IMAGES = 24;
const MAX_INSTRUCTIONS = 20000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_TEXT = 100000;
const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Document formats from env.AI.toMarkdown().supported(); images use the vision path instead.
export const DOCUMENT_EXTENSIONS = [
	".csv", ".docx", ".et", ".htm", ".html", ".numbers", ".odp", ".ods", ".odt", ".otp", ".pdf",
	".potx", ".ppsm", ".ppsx", ".pptm", ".pptx", ".xls", ".xlsb", ".xlsm", ".xlsx", ".xml",
];
const IMAGE_PREFIX = /^data:image\/(png|jpeg|webp|gif);base64,/;
const IMAGE_PLACEHOLDER = "[An image was attached here, but the current model cannot view images.]";
const IMAGE_DROPPED = "[An earlier image was omitted to stay within the per-request image limit.]";

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
		try {
			return await api(request, env, url, ctx);
		} catch (err) {
			if (err instanceof HttpError) return json({ error: err.message }, err.status, err.headers);
			if (err instanceof ParamError) return json({ error: err.message }, 400);
			console.error("api error", err);
			return json({ error: "Internal error" }, 500);
		}
	},
};

async function api(request, env, url, ctx) {
	if (!env.PASSCODE) throw new HttpError(503, "PASSCODE secret is not configured on the Worker.");
	const header = request.headers.get("authorization") || "";
	const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
	// A signed-in device sends its token; the passcode comes from the lock screen, or from an app that has
	// not switched to a token yet. Only passcodes count toward lockouts.
	let device = null;
	if (bearer.startsWith(TOKEN_PREFIX)) {
		device = await verifyToken(env, bearer);
		if (!device) throw new HttpError(401, "Unauthorized");
	} else if (!bearer) {
		// No credentials at all (a crawler, a stale tab) is not a guess.
		throw new HttpError(401, "Unauthorized");
	} else {
		await checkPasscode(request, env, url, ctx, bearer);
	}

	switch (url.pathname) {
		case "/api/auth":
			requireMethod(request, "POST");
			return json({ token: await issueToken(env) });
		case "/api/push/key":
			requireMethod(request, "GET");
			if (!env.VAPID_JWK) throw new HttpError(503, "Notifications are not configured.");
			return json({ key: vapidPublicKey(env) });
		case "/api/push/subscribe": {
			requireMethod(request, "POST");
			if (!device) throw new HttpError(400, "Sign in again to turn on notifications.");
			let subscription;
			try {
				subscription = cleanSubscription(JSON.parse(new TextDecoder().decode(await readBytes(request, 8192, "Request too large."))));
			} catch (err) {
				if (err instanceof HttpError) throw err;
			}
			if (!subscription) throw new HttpError(400, "Invalid push subscription.");
			await env.GUARD.getByName("passcode").subscribe(device, subscription);
			// ?welcome=1 when the user just tapped Allow: one notification so they see it works.
			if (url.searchParams.get("welcome") === "1") {
				ctx?.waitUntil(sendPush(env, subscription, ALERTS.welcome, url.origin).catch((err) => console.error("welcome push failed", err?.message)));
			}
			return new Response(null, { status: 204, headers: NO_STORE });
		}
		case "/api/push/unsubscribe":
			requireMethod(request, "POST");
			if (device) await env.GUARD.getByName("passcode").unsubscribe(device);
			return new Response(null, { status: 204, headers: NO_STORE });
		case "/api/models":
			requireMethod(request, "GET");
			return json({ models: MODELS, default: DEFAULT_MODEL });
		case "/api/chat":
			requireMethod(request, "POST");
			return chat(request, env);
		case "/api/convert":
			requireMethod(request, "POST");
			return convert(request, env);
		case "/api/voices":
			requireMethod(request, "GET");
			return voiceConfig();
		case "/api/voice/transcribe":
			requireMethod(request, "POST");
			return transcribe(request, env);
		case "/api/voice/turn":
			requireMethod(request, "POST");
			return turn(request, env);
		case "/api/voice/speak":
			requireMethod(request, "POST");
			return speak(request, env);
		case "/api/usage":
			requireMethod(request, "GET");
			return usage(env);
		default:
			throw new HttpError(404, "Not found");
	}
}

async function chat(request, env) {
	// Sent back as x-thread-started: the app files the reply's neurons under this time, which precedes every
	// model request the reply makes, so the usage counter can tell which replies analytics already includes.
	const started = Date.now();
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
	const voice = sanitizeVoice(body.voice);
	const params = sanitizeParams(body.params, model);
	if (voice) applyVoiceParams(params, model);
	const instructions = [sanitizeInstructions(body.instructions), voice && voiceInstruction(voice)].filter(Boolean).join("\n\n");
	if (instructions) messages.unshift({ role: "system", content: instructions });
	let tools;
	try {
		tools = sanitizeTools(body.tools);
	} catch (err) {
		throw new HttpError(400, err.message);
	}
	if (tools.length && (params.tools || params.functions)) {
		throw new HttpError(400, "Turn off the Code and Web tools to send your own tools in Advanced JSON.");
	}
	if (tools.includes("python") && !(typeof body.chatId === "string" && CHAT_ID.test(body.chatId))) {
		throw new HttpError(400, "chatId must be a UUID when the Code tool is on.");
	}

	const input = { ...params, messages, stream: true };
	if (input.max_completion_tokens === undefined && input.max_tokens === undefined) {
		// gpt-oss-120b and Llama 3.3 truncate at 256 tokens when no cap is sent.
		input.max_completion_tokens = model.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
	}

	const options = aiOptions(env);
	const asContent = Boolean(model.replyInReasoningWhenThinkingOff && input.chat_template_kwargs?.enable_thinking === false);
	const headers = { "content-type": "text/event-stream; charset=utf-8", "x-thread-started": String(started), ...NO_STORE };
	if (tools.length) {
		const stream = agentStream({ env, model: model.id, input, tools, chatId: body.chatId, options, asContent });
		return new Response(stream, { headers });
	}
	let stream;
	try {
		stream = await env.AI.run(model.id, input, options);
	} catch (err) {
		console.error("AI.run failed", model.id, err);
		throw new HttpError(502, `Model request failed: ${err?.message || String(err)}`);
	}

	return new Response(asContent ? reasoningAsContent(stream) : stream, { headers });
}

async function convert(request, env) {
	const name = decodeURIComponent(request.headers.get("x-filename") || "").trim();
	const ext = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
	if (!name || name.length > 255 || !DOCUMENT_EXTENSIONS.includes(ext)) {
		throw new HttpError(415, `Unsupported file type. Supported: ${DOCUMENT_EXTENSIONS.join(" ")}`);
	}
	const length = Number(request.headers.get("content-length") || 0);
	if (length > MAX_FILE_BYTES) throw new HttpError(413, "Files are limited to 10 MB.");
	const bytes = await readBytes(request, MAX_FILE_BYTES, "Files are limited to 10 MB.");
	if (!bytes.byteLength) throw new HttpError(400, "The file is empty.");

	let result;
	try {
		[result] = await env.AI.toMarkdown([{ name, blob: new Blob([bytes], { type: "application/octet-stream" }) }]);
	} catch (err) {
		throw new HttpError(502, `Conversion failed: ${err?.message || String(err)}`);
	}
	if (!result || result.format === "error" || typeof result.data !== "string") {
		throw new HttpError(422, `Could not read ${name}${result?.error ? `: ${result.error}` : "."}`);
	}
	const truncated = result.data.length > MAX_FILE_TEXT;
	return json({ name, text: truncated ? result.data.slice(0, MAX_FILE_TEXT) : result.data, truncated });
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

// Voice mode: { lang } of the selected voice, or null for a normal chat.
export function sanitizeVoice(input) {
	if (input === undefined || input === null) return null;
	if (!isPlainObject(input) || !VOICE_LANGS.includes(input.lang)) {
		throw new HttpError(400, `voice.lang must be one of ${VOICE_LANGS.join(", ")}.`);
	}
	return input.lang;
}

function applyVoiceParams(params, model) {
	for (const [key, value] of Object.entries(model.voiceParams || {})) {
		params[key] = isPlainObject(value) && isPlainObject(params[key]) ? { ...params[key], ...value } : value;
	}
}

export function sanitizeInstructions(input) {
	if (input === undefined || input === null) return "";
	if (typeof input !== "string") throw new HttpError(400, "instructions must be a string.");
	if (input.length > MAX_INSTRUCTIONS) throw new HttpError(400, `Instructions are limited to ${MAX_INSTRUCTIONS} characters.`);
	return input.trim();
}

function waitText(seconds) {
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	const hours = Math.ceil(minutes / 60);
	return `${hours} hour${hours === 1 ? "" : "s"}`;
}

async function readBody(request, limit) {
	return new TextDecoder().decode(await readBytes(request, limit, "Request too large."));
}

// Checks a passcode against the lockouts (lockout.js); throws 401 or 429 unless it is right and not locked out.
// Crossing a global threshold notifies every device that allowed notifications.
async function checkPasscode(request, env, url, ctx, bearer) {
	const ok = await passcodeMatches(bearer, env.PASSCODE);
	const ip = request.headers.get("cf-connecting-ip") || "unknown";
	const guard = env.GUARD.getByName("passcode");
	const verdict = await guard.attempt(ip, ok);
	if (verdict.event) {
		const sending = notifyAll(env, guard, { ...ALERTS[verdict.event], until: verdict.until || undefined }, url.origin).catch((err) =>
			console.error("alert failed", err?.message || String(err)),
		);
		ctx?.waitUntil(sending);
	}
	if (verdict.until) {
		const seconds = Math.max(1, Math.ceil((verdict.until - Date.now()) / 1000));
		const message =
			verdict.scope === "global"
				? `Too many wrong passcodes, so logins are frozen for ${waitText(seconds)}. Go touch grass. 🌱`
				: `Too many wrong passcodes. Try again in ${waitText(seconds)}.`;
		throw new HttpError(429, message, { "retry-after": String(seconds) });
	}
	if (!verdict.allowed) throw new HttpError(401, verdict.event === "warning" ? LAST_TRY : "Unauthorized");
}

// The app percent-encodes the passcode (header values must be ISO-8859-1); raw values are accepted too.
async function passcodeMatches(raw, passcode) {
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
