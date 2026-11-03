// Server-side tool loop. Model deltas are relayed to the client unchanged (minus tool-call
// fragments); tool activity is sent as {"thread": {...}} events that only the app reads.

export const MAX_ROUNDS = 6;
const MAX_TOOL_TEXT = 20000;
const encoder = new TextEncoder();

export const TOOLS = {
	python: {
		type: "function",
		function: {
			name: "run_python",
			description:
				"Run Python 3.12 code in a sandbox and return stdout, stderr and errors. State (variables, imports, files in /workspace) persists between calls in this chat. numpy, pandas, matplotlib, scipy, sympy and pillow are installed. There is no internet access. Each call may run for up to 60 seconds. Matplotlib figures are shown to the user automatically; do not call plt.savefig unless asked for a file. The value of a final bare expression is printed.",
			parameters: {
				type: "object",
				properties: { code: { type: "string", description: "Python source to execute." } },
				required: ["code"],
			},
		},
	},
	web: {
		type: "function",
		function: {
			name: "fetch_url",
			description:
				"Load a web page in a headless browser and return its main content as Markdown. Use for reading pages the user mentions or that you know the URL of. There is no search; you need a full http(s) URL.",
			parameters: {
				type: "object",
				properties: { url: { type: "string", description: "Absolute http(s) URL." } },
				required: ["url"],
			},
		},
	},
};

const TOOL_BY_FUNCTION = { run_python: "python", fetch_url: "web" };

// Longest arguments a call may have, in characters. gpt-oss once spent a whole 16,384-token reply writing a single
// call; past these sizes the model is stopped instead. Unknown function names get the smallest limit.
export const MAX_ARGS = { run_python: 30000, fetch_url: 4000 };
const maxArgs = (name) => MAX_ARGS[name] ?? MAX_ARGS.fetch_url;
const TOOL_LABEL = { run_python: "Python", fetch_url: "page request" };

export function sanitizeTools(input) {
	if (input === undefined || input === null) return [];
	if (!Array.isArray(input) || input.some((t) => !Object.hasOwn(TOOLS, t))) {
		throw new Error(`tools must be a list drawn from: ${Object.keys(TOOLS).join(", ")}.`);
	}
	return [...new Set(input)];
}

const truncate = (text, max = MAX_TOOL_TEXT) =>
	text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]` : text;

// signal (optional) stops the loop: the model stream in progress is cancelled and no further tool or round runs.
export function agentStream({ env, model, input, tools, chatId, options, asContent = false, signal }) {
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	// Writes fail once the reader has gone; the loop stops on `signal`, not on write errors.
	const send = (data) => writer.write(encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`)).catch(() => {});
	const defs = tools.map((t) => TOOLS[t]);

	(async () => {
		const messages = [...input.messages];
		try {
			for (let round = 0; round < MAX_ROUNDS; round++) {
				if (signal?.aborted) return;
				// Tools stay defined on every round: without them some models print raw tool-call markup.
				const stream = await env.AI.run(model, { ...input, messages, tools: defs }, options);
				const { calls, content, failed } = await relay(asContent ? reasoningAsContent(stream) : stream, send, round, signal);
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
				for (const call of calls) {
					if (signal?.aborted) return;
					send({ thread: { type: "tool_start", id: call.id, name: call.name, args: safeArgs(call.args) } });
					const { forModel, forUser } = await runTool(env, call, tools, chatId);
					send({ thread: { type: "tool_result", id: call.id, name: call.name, result: forUser } });
					messages.push({ role: "tool", tool_call_id: call.id, content: forModel });
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

// Rewrites a model SSE stream so reasoning deltas arrive as reply content. Other lines pass through unchanged.
export function reasoningAsContent(stream) {
	const decoder = new TextDecoder();
	let buffer = "";
	const rewrite = (line) => {
		const data = line.startsWith("data:") ? line.slice(5).trim() : "";
		if (!data || data === "[DONE]") return line;
		let evt;
		try {
			evt = JSON.parse(data);
		} catch {
			return line;
		}
		let changed = false;
		for (const choice of evt.choices || []) {
			const delta = choice?.delta;
			const text = delta?.reasoning_content ?? delta?.reasoning;
			if (typeof text !== "string" || !text) continue;
			delta.content = (typeof delta.content === "string" ? delta.content : "") + text;
			delete delta.reasoning_content;
			delete delta.reasoning;
			changed = true;
		}
		return changed ? `data: ${JSON.stringify(evt)}` : line;
	};
	return stream.pipeThrough(
		new TransformStream({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true });
				const end = buffer.lastIndexOf("\n");
				if (end === -1) return;
				const lines = buffer.slice(0, end).split("\n");
				buffer = buffer.slice(end + 1);
				controller.enqueue(encoder.encode(`${lines.map(rewrite).join("\n")}\n`));
			},
			flush(controller) {
				buffer += decoder.decode();
				if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
			},
		}),
	);
}

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
					call.id ||= tc.id || `call_${round}_${key}`;
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

export async function runTool(env, call, enabled, chatId) {
	const tool = TOOL_BY_FUNCTION[call.name];
	if (!tool || !enabled.includes(tool)) {
		const msg = `Tool ${call.name} is not available.`;
		return { forModel: msg, forUser: { error: msg } };
	}
	let args;
	try {
		args = JSON.parse(call.args || "{}");
	} catch {
		const msg = "Tool arguments were not valid JSON.";
		return { forModel: msg, forUser: { error: msg } };
	}
	try {
		return tool === "python" ? await runPython(env, args, chatId) : await fetchUrl(env, args);
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
		forModel: truncate(parts.join("\n\n")),
		forUser: { stdout: result.stdout || "", stderr: result.stderr || "", error: result.error || null, images },
	};
}

async function fetchUrl(env, args) {
	let url;
	try {
		url = new URL(args.url);
	} catch {
		url = null;
	}
	if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
		const msg = "fetch_url needs an absolute http(s) URL.";
		return { forModel: msg, forUser: { error: msg } };
	}
	const markdown = await quickMarkdown(env, url.href);
	const text = truncate(markdown.trim() || "(the page had no readable content)");
	return { forModel: text, forUser: { url: url.href, chars: markdown.length } };
}

// The binding's return shape for "markdown" is normalised here: string, Response, or {result}.
async function quickMarkdown(env, url) {
	let out = await env.BROWSER.quickAction("markdown", { url });
	if (out instanceof Response) {
		if (!out.ok) throw new Error(`Browser Run returned HTTP ${out.status}`);
		const type = out.headers.get("content-type") || "";
		out = type.includes("json") ? await out.json() : await out.text();
	}
	if (typeof out === "string") return out;
	if (out && typeof out.result === "string") return out.result;
	if (out && out.success === false) throw new Error(JSON.stringify(out.errors || out).slice(0, 300));
	throw new Error("Browser Run returned an unexpected result.");
}
