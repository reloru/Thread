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

export function sanitizeTools(input) {
	if (input === undefined || input === null) return [];
	if (!Array.isArray(input) || input.some((t) => !Object.hasOwn(TOOLS, t))) {
		throw new Error(`tools must be a list drawn from: ${Object.keys(TOOLS).join(", ")}.`);
	}
	return [...new Set(input)];
}

const truncate = (text, max = MAX_TOOL_TEXT) =>
	text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]` : text;

export function agentStream({ env, model, input, tools, chatId, options }) {
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const send = (data) => writer.write(encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`));
	const defs = tools.map((t) => TOOLS[t]);

	(async () => {
		const messages = [...input.messages];
		try {
			for (let round = 0; round < MAX_ROUNDS; round++) {
				// Tools stay defined on every round: without them some models print raw tool-call markup.
				const stream = await env.AI.run(model, { ...input, messages, tools: defs }, options);
				const { calls, content } = await relay(stream, send);
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

// Reads one model SSE stream, forwards content/reasoning chunks, and collects tool calls.
export async function relay(stream, send) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const calls = new Map();
	let content = "";
	let buffer = "";
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
			if (delta?.tool_calls) {
				for (const tc of delta.tool_calls) {
					const key = tc.index ?? 0;
					const call = calls.get(key) || { id: "", name: "", args: "" };
					call.id ||= tc.id || "";
					call.name += tc.function?.name || "";
					call.args += tc.function?.arguments || "";
					calls.set(key, call);
				}
				continue;
			}
			if (choice?.finish_reason === "tool_calls") continue;
			if (typeof delta?.content === "string") content += delta.content;
			send(data);
		}
		if (done) break;
	}
	const list = [...calls.values()].filter((c) => c.name);
	list.forEach((c, i) => (c.id ||= `call_${i}`));
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
