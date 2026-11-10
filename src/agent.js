// Server-side tool loop. Model deltas are relayed to the client unchanged (minus tool-call
// fragments); tool activity is sent as {"thread": {...}} events that only the app reads.

import { DEFAULT_MAX_TOKENS, MODELS } from "./models.js";
import { readPage, truncate, webSearch } from "./web.js";

export const MAX_ROUNDS = 6;
const MAX_TOOL_TEXT = 20000;
// Models with less context than this (Llama 3.3, 24,000 tokens) get shorter page reads.
const SMALL_CONTEXT = 50000;
const SMALL_CONTEXT_PAGE = 6000;
const encoder = new TextEncoder();

// The chips in the app: "python" is the Code chip, "web" the Web chip.
const TOOL_NAMES = ["python", "web"];
const TOOL_BY_FUNCTION = { run_python: "python", fetch_url: "web", web_search: "web" };

const fn = (name, description, properties, required) => ({
	type: "function",
	function: { name, description, parameters: { type: "object", properties, required } },
});

/** The function definitions sent to the model for the enabled chips. show_page is offered to vision models only. */
export function toolDefs(tools, { vision = false } = {}) {
	const web = tools.includes("web");
	const defs = [];
	if (web) {
		defs.push(
			fn(
				"web_search",
				"Search the web (live results from DuckDuckGo, or Brave if that fails) and get up to 8 results, each with a title, URL and short snippet. Use it whenever you don't know the exact URL, for anything recent or that may have changed, and to check facts. Then read the most relevant results with fetch_url: snippets alone are often incomplete.",
				{ query: { type: "string", description: "Search terms, as you would type them into a search engine." } },
				["query"],
			),
			fn(
				"fetch_url",
				`Open a web page in a real browser (live internet access) and return its main content as Markdown. Use it for URLs the user gives and for the best results of web_search. Long pages come back in parts; each part says where the next one starts, so you can read on with start.${vision ? " Set show_page to also get a screenshot of the top of the page, to see its layout, pictures or charts." : ""}`,
				{
					url: { type: "string", description: "Absolute http(s) URL." },
					start: { type: "integer", description: "Character to start reading from, to read on in a long page. Leave it out to read from the beginning." },
					...(vision ? { show_page: { type: "boolean", description: "Also return a screenshot of the top of the page (1280×800). Slower; use it when the look of the page matters." } } : {}),
				},
				["url"],
			),
		);
	}
	if (tools.includes("python")) {
		defs.push(
			fn(
				"run_python",
				`Run Python 3.12 code in a sandbox and return stdout, stderr and errors. State (variables, imports, files in /workspace) persists between calls in this chat. numpy, pandas, matplotlib, scipy, sympy and pillow are installed. Each call may run for up to 60 seconds. Matplotlib figures are shown to the user automatically; do not call plt.savefig unless asked for a file. The value of a final bare expression is printed. The sandbox itself has no internet access${web ? "; get information from the web with web_search and fetch_url" : ""}.`,
				{ code: { type: "string", description: "Python source to execute." } },
				["code"],
			),
		);
	}
	return defs;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-11-10" → "Tuesday, November 10, 2026". Null unless it is a real calendar date in that form. */
export function longDate(iso) {
	if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
	const d = new Date(`${iso}T00:00:00Z`);
	if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
	return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * The note added to the system message when tools are on: which tools there are, that they reach the live internet
 * (search first when the URL isn't known) or run code, and today's date. Without it PhoneLLM said it had no web
 * access and guessed URLs. date: YYYY-MM-DD, the device's local date.
 */
export function toolNote(tools, { vision = false, date } = {}) {
	if (!tools.length) return "";
	const web = tools.includes("web");
	const python = tools.includes("python");
	const names = [...(web ? ["web_search", "fetch_url"] : []), ...(python ? ["run_python"] : [])];
	const list = names.length > 2 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join(" and ");
	const parts = [`You have tools: ${list}.`];
	if (web) {
		parts.push(
			`They give you live internet access${python ? " and code execution (Python in a sandbox)" : ""}. When you need information you don't have, or anything recent, search with web_search unless you already know the exact URL, then read the most relevant results with fetch_url before answering. Don't guess URLs, and don't say you can't browse the web.${vision ? " fetch_url can also show you a screenshot of the page (show_page)." : ""}`,
		);
	} else {
		parts.push("run_python executes code in a sandbox, for calculations, data and charts; it has no internet access.");
	}
	parts.push(`Today's date is ${longDate(date) || longDate(new Date().toISOString().slice(0, 10))}.`);
	return parts.join(" ");
}

// Longest arguments a call may have, in characters. gpt-oss once spent a whole 16,384-token reply writing a single
// call; past these sizes the model is stopped instead. Unknown function names get the smallest limit.
export const MAX_ARGS = { run_python: 30000, fetch_url: 4000, web_search: 1024 };
const maxArgs = (name) => MAX_ARGS[name] ?? Math.min(...Object.values(MAX_ARGS));
const TOOL_LABEL = { run_python: "Python", fetch_url: "page request", web_search: "search" };

export function sanitizeTools(input) {
	if (input === undefined || input === null) return [];
	if (!Array.isArray(input) || input.some((t) => !TOOL_NAMES.includes(t))) {
		throw new Error(`tools must be a list drawn from: ${TOOL_NAMES.join(", ")}.`);
	}
	return [...new Set(input)];
}

// Context budget. Tokens are estimated as characters / 3.5 for text and a flat figure per image (base64 length says
// nothing about an image's tokens: a screenshot cost 350 to 1,400 prompt tokens on the vision models).
const CHARS_PER_TOKEN = 3.5;
export const IMAGE_TOKENS = 1500;
const MESSAGE_TOKENS = 8;
// Before each round, once the request would pass this share of (context - output cap), the oldest tool results of
// this reply are replaced with a note. Results smaller than PRUNE_MIN_CHARS aren't worth replacing.
export const BUDGET_SHARE = 0.6;
const PRUNE_MIN_CHARS = 1000;
export const PAGE_REMOVED = "[page text removed to save space; read it again if needed]";
const OUTPUT_REMOVED = "[output removed to save space; run it again if needed]";
const RESULTS_REMOVED = "[search results removed to save space; search again if needed]";
const SCREENSHOT_REMOVED = "[screenshot removed to save space]";

export function estimateTokens(messages, defs = []) {
	let chars = JSON.stringify(defs).length;
	let images = 0;
	for (const m of messages) {
		if (typeof m.content === "string") chars += m.content.length;
		else if (Array.isArray(m.content)) {
			for (const part of m.content) {
				if (part?.type === "image_url") images++;
				else if (typeof part?.text === "string") chars += part.text.length;
			}
		}
		if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
	}
	return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS + messages.length * MESSAGE_TOKENS;
}

/** { soft, hard } in estimated tokens for a model and request, or null when it can't be worked out. */
export function budgetFor(spec, input) {
	const output = input.max_completion_tokens ?? input.max_tokens ?? spec?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
	const hard = (spec?.context ?? 0) - output;
	if (!spec?.context || !(hard > 0)) return null;
	return { soft: Math.floor(hard * BUDGET_SHARE), hard };
}

// Replaces the oldest prunable messages (this reply's own tool results and screenshots) until the request is under
// the soft budget. Returns the estimate after pruning. The chat itself is never changed.
function prune(messages, prunable, defs, soft) {
	let total = estimateTokens(messages, defs);
	while (total > soft && prunable.length) {
		const { message, note } = prunable.shift();
		message.content = note;
		total = estimateTokens(messages, defs);
	}
	return total;
}

const removedNote = (name) => (name === "fetch_url" ? PAGE_REMOVED : name === "web_search" ? RESULTS_REMOVED : OUTPUT_REMOVED);

// signal (optional) stops the loop: the model stream in progress is cancelled and no further tool or round runs.
export function agentStream({ env, model, input, tools, chatId, options, signal }) {
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	// Writes fail once the reader has gone; the loop stops on `signal`, not on write errors.
	const send = (data) => writer.write(encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`)).catch(() => {});
	const spec = MODELS.find((m) => m.id === model);
	const vision = Boolean(spec?.vision);
	const defs = toolDefs(tools, { vision });
	const budget = budgetFor(spec, input);
	const pageChars = spec?.context && spec.context < SMALL_CONTEXT ? SMALL_CONTEXT_PAGE : MAX_TOOL_TEXT;

	(async () => {
		const messages = input.messages.map((m) => ({ ...m }));
		// This reply's tool results and screenshots, oldest first: what the budget may replace.
		const prunable = [];
		try {
			for (let round = 0; round < MAX_ROUNDS; round++) {
				if (signal?.aborted) return;
				// The first round is sent as the app asked; only what the loop added can make a later one too big.
				if (budget && round > 0 && prune(messages, prunable, defs, budget.soft) > budget.hard) {
					send({ error: `The chat and the tool results no longer fit in ${spec.name}'s context window, so the reply was stopped. Start a new chat, or switch to a model with a larger context window.` });
					return;
				}
				// Tools stay defined on every round: without them some models print raw tool-call markup.
				const stream = await env.AI.run(model, { ...input, messages, tools: defs }, options);
				const { calls, content, failed } = await relay(stream, send, round, signal);
				if (signal?.aborted) return;
				if (failed) {
					// Not handed back to the model: another round could run away the same way.
					send({ thread: { type: "tool_result", id: failed.id, name: failed.name, result: { error: failed.note } } });
					send({ error: failed.error });
					return;
				}
				if (!calls.length) break;
				if (round === MAX_ROUNDS - 1) {
					send({ choices: [{ index: 0, delta: { content: `\n\n_Stopped after ${MAX_ROUNDS} rounds of tool use._` } }] });
					break;
				}
				messages.push({
					role: "assistant",
					content,
					tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })),
				});
				const shots = [];
				for (const call of calls) {
					if (signal?.aborted) return;
					send({ thread: { type: "tool_start", id: call.id, name: call.name, args: safeArgs(call.args) } });
					const { forModel, forUser, image } = await runTool(env, call, tools, chatId, { vision, pageChars });
					send({ thread: { type: "tool_result", id: call.id, name: call.name, result: forUser } });
					const message = { role: "tool", tool_call_id: call.id, content: forModel };
					messages.push(message);
					if (forModel.length >= PRUNE_MIN_CHARS) prunable.push({ message, note: removedNote(call.name) });
					if (image) shots.push({ url: forUser.url, image });
				}
				// Tool messages carry text only, so screenshots follow the round's results as one user message. It
				// comes after all of them: some chat templates need a call's results to stay together.
				if (shots.length) {
					const message = {
						role: "user",
						content: [
							{ type: "text", text: `Screenshot${shots.length > 1 ? "s" : ""} from fetch_url (show_page), sent by the tool, not typed by the user: ${shots.map((s) => s.url).join(", ")}` },
							...shots.map((s) => ({ type: "image_url", image_url: { url: s.image } })),
						],
					};
					messages.push(message);
					prunable.push({ message, note: SCREENSHOT_REMOVED });
				}
			}
			send("[DONE]");
		} catch (err) {
			console.error("agent error", err);
			send({ error: `Model request failed: ${err?.message || String(err)}` });
		} finally {
			writer.close().catch(() => {});
		}
	})();

	return readable;
}

// Ids for calls the model sent without one: 9 letters and digits, the only form Mistral accepts.
const callId = (round, index) => `call${String(round).padStart(2, "0")}${String(index % 1000).padStart(3, "0")}`;

// Reads one model SSE stream, forwards content/reasoning chunks, and collects tool calls. Announces each call
// with a tool_prepare event once its arguments start, since they are not forwarded. Returns `failed` instead of
// calls when a call's arguments pass MAX_ARGS (the stream is cancelled) or the reply hits its length limit
// while a call is unfinished.
export async function relay(stream, send, round = 0, signal) {
	const reader = stream.getReader();
	const stop = () => reader.cancel().catch(() => {});
	signal?.addEventListener("abort", stop, { once: true });
	try {
		return await relayFrom(reader, send, round);
	} finally {
		signal?.removeEventListener("abort", stop);
	}
}

async function relayFrom(reader, send, round) {
	const decoder = new TextDecoder();
	const calls = new Map();
	let content = "";
	let buffer = "";
	let finish = null;
	for (;;) {
		const { value, done } = await reader.read();
		buffer += done ? decoder.decode() + "\n" : decoder.decode(value, { stream: true });
		let nl;
		while ((nl = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, nl).replace(/\r$/, "");
			buffer = buffer.slice(nl + 1);
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (!data || data === "[DONE]") continue;
			let evt;
			try {
				evt = JSON.parse(data);
			} catch {
				continue;
			}
			const choice = evt.choices?.find((c) => (c.index ?? 0) === 0);
			const delta = choice?.delta;
			if (choice?.finish_reason) finish = choice.finish_reason;
			if (delta?.tool_calls) {
				for (const tc of delta.tool_calls) {
					const key = tc.index ?? 0;
					const call = calls.get(key) || { id: "", name: "", args: "", announced: false };
					// Ids are fixed at the first fragment so the tool_prepare and tool_start events agree.
					call.id ||= tc.id || callId(round, key);
					call.name += tc.function?.name || "";
					call.args += tc.function?.arguments || "";
					calls.set(key, call);
					if (!call.announced && call.name && call.args) {
						call.announced = true;
						send({ thread: { type: "tool_prepare", id: call.id, name: call.name } });
					}
					if (call.args.length > maxArgs(call.name)) {
						reader.cancel().catch(() => {});
						const limit = maxArgs(call.name).toLocaleString("en-US");
						const error = `The model kept writing one ${TOOL_LABEL[call.name] || "tool"} call past ${limit} characters, so the reply was stopped. Regenerate to try again.`;
						return { calls: [], content, failed: { id: call.id, name: call.name, error, note: `Not run: it grew past ${limit} characters.` } };
					}
				}
				// A chunk that ends the reply can carry the last fragment; its finish reason still has to reach the app.
				if (choice?.finish_reason && choice.finish_reason !== "tool_calls") {
					send({ choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] });
				}
				continue;
			}
			if (choice?.finish_reason === "tool_calls") continue;
			if (typeof delta?.content === "string") content += delta.content;
			send(data);
		}
		if (done) break;
	}
	const list = [...calls.values()].filter((c) => c.name).map(({ id, name, args }) => ({ id, name, args }));
	if (list.length && finish === "length") {
		const last = list.at(-1);
		const error = "The reply hit its length limit while the model was writing a tool call, so the call wasn't run. Raise Max output tokens in the model's settings, or regenerate.";
		return { calls: [], content, failed: { id: last.id, name: last.name, error, note: "Not run: the reply hit its length limit first." } };
	}
	return { calls: list, content };
}

function safeArgs(args) {
	try {
		return JSON.parse(args || "{}");
	} catch {
		return { raw: truncate(String(args), 2000) };
	}
}

/** Runs one call. options: { vision, pageChars }. Returns { forModel, forUser, image? }. */
export async function runTool(env, call, enabled, chatId, { vision = false, pageChars = MAX_TOOL_TEXT } = {}) {
	const tool = TOOL_BY_FUNCTION[call.name];
	if (!tool || !enabled.includes(tool)) {
		// gpt-oss reaches for the find and scroll tools of its own browser; naming the real ones lets it carry on.
		const names = Object.keys(TOOL_BY_FUNCTION).filter((name) => enabled.includes(TOOL_BY_FUNCTION[name]));
		const msg = `Tool ${String(call.name).slice(0, 80)} is not available. The tools you can call are: ${names.join(", ")}.`;
		return { forModel: msg, forUser: { error: msg } };
	}
	let args;
	try {
		args = JSON.parse(call.args || "{}");
	} catch {
		const msg = "Tool arguments were not valid JSON.";
		return { forModel: msg, forUser: { error: msg } };
	}
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		const msg = "Tool arguments must be a JSON object.";
		return { forModel: msg, forUser: { error: msg } };
	}
	try {
		if (call.name === "run_python") return await runPython(env, args, chatId);
		if (call.name === "web_search") return await webSearch(env, args);
		return await readPage(env, args, { vision, maxChars: pageChars });
	} catch (err) {
		const msg = `Tool failed: ${err?.message || String(err)}`;
		return { forModel: msg, forUser: { error: msg } };
	}
}

async function runPython(env, args, chatId) {
	if (typeof args.code !== "string" || !args.code.trim()) {
		return { forModel: "No code was provided.", forUser: { error: "No code was provided." } };
	}
	const result = await env.SANDBOX.getByName(chatId).run(args.code);
	const images = Array.isArray(result.images) ? result.images : [];
	const parts = [];
	if (result.restarted) parts.push("[The Python session had restarted; earlier state was lost.]");
	if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
	if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
	if (result.error) parts.push(`error:\n${result.error}`);
	if (images.length) parts.push(`[${images.length} figure(s) were displayed to the user.]`);
	if (!parts.length) parts.push("(no output)");
	return {
		forModel: truncate(parts.join("\n\n"), MAX_TOOL_TEXT),
		forUser: { stdout: result.stdout || "", stderr: result.stderr || "", error: result.error || null, images },
	};
}
