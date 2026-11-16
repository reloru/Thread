// Runs the app in plain Node, for trying a change in a browser where `wrangler dev` can't run (it needs Docker
// for the sandbox image). The real Worker code handles every request; only the bindings are stand-ins:
//
//   ASSETS   public/, with the headers from public/_headers (so the CSP applies as in production)
//   AI       the Workers AI REST API when CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are set (billed), or
//            with --fake / without credentials a canned reply (the text of FAKE_REPLY, or the file named by
//            --reply), streamed in small pieces
//   BROWSER  Browser Run Quick Actions over REST with the same credentials; unavailable with --fake
//   REPLY    src/replylog.js with its rows in memory
//   GUARD    src/lockout.js and src/push.js with storage in memory
//   SANDBOX  not available (Python runs report an error)
//
// node tools/dev-server.mjs [--port 8787] [--fake] [--reply file.md] [--delay ms]    passcode: "dev" (or $PASSCODE)

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/worker.js";
import { attempt } from "../src/lockout.js";
import { dropSubscription, listSubscriptions, saveSubscription } from "../src/push.js";
import { ReplyLog } from "../src/replylog.js";
import { generate } from "../src/generate.js";

// Workers-only Web Crypto extension.
crypto.subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT = Number(option("--port", 8787));
const DELAY = Number(option("--delay", 30));
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const FAKE = args.includes("--fake") || !TOKEN || !ACCOUNT;
const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
const FAKE_REPLY =
	"This is the **dev server's** canned reply.\n\n- It streams in small pieces\n- No model was called\n\n```js\nconsole.log(\"hello\");\n```\n";
const replyText = option("--reply") ? readFileSync(option("--reply"), "utf8") : FAKE_REPLY;

const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".png": "image/png",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
};

// public/_headers: a path line, then indented "Name: value" lines. "/*" applies to every path.
function headerRules() {
	const rules = [];
	for (const line of readFileSync(join(PUBLIC, "_headers"), "utf8").split("\n")) {
		if (!line.trim()) continue;
		if (!/^\s/.test(line)) rules.push({ path: line.trim(), headers: [] });
		else rules.at(-1)?.headers.push(line.trim().split(/:\s*(.*)/s).slice(0, 2));
	}
	return rules;
}

async function asset(request) {
	let path = decodeURIComponent(new URL(request.url).pathname);
	const headers = new Headers({ "cache-control": "public, max-age=0, must-revalidate" });
	for (const rule of headerRules()) {
		const all = rule.path.endsWith("/*") && path.startsWith(rule.path.slice(0, -1));
		if (all || rule.path === path) for (const [name, value] of rule.headers) headers.set(name, value);
	}
	if (path.endsWith("/")) path += "index.html";
	const file = normalize(join(PUBLIC, path));
	if (!file.startsWith(PUBLIC) || path.endsWith("/_headers")) return new Response("Not found", { status: 404 });
	try {
		headers.set("content-type", TYPES[extname(file)] || "application/octet-stream");
		return new Response(await readFile(file), { headers });
	} catch {
		return new Response("Not found", { status: 404 });
	}
}

function memoryStorage() {
	const map = new Map();
	return {
		get: async (k) => map.get(k),
		put: async (k, v) => void map.set(k, structuredClone(v)),
		delete: async (keys) => [keys].flat().forEach((k) => map.delete(k)),
		list: async ({ prefix = "" } = {}) => new Map([...map].filter(([k]) => k.startsWith(prefix))),
	};
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeStream(text) {
	const encoder = new TextEncoder();
	const frame = (data) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
	const pieces = text.match(/[\s\S]{1,12}/g) || [];
	return new ReadableStream({
		async start(c) {
			for (const piece of pieces) {
				c.enqueue(frame({ choices: [{ index: 0, delta: { content: piece } }] }));
				await sleep(DELAY);
			}
			c.enqueue(frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
			c.enqueue(frame({ usage: { neurons: 1.5 } }));
			c.enqueue(encoder.encode("data: [DONE]\n\n"));
			c.close();
		},
	});
}

async function rest(path, body) {
	return fetch(`${API}${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const AI = {
	async run(model, input) {
		if (FAKE) return fakeStream(replyText);
		const res = await rest(`/ai/run/${model}`, input);
		if (!res.ok) throw new Error(`Workers AI returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
		return res.body;
	},
	async toMarkdown() {
		throw new Error("File conversion isn't available in the dev server.");
	},
};

const BROWSER = {
	quickAction(action, body) {
		if (FAKE) throw new Error("Browser Run isn't available in the dev server's fake mode.");
		return rest(`/browser-run/${action}`, body);
	},
};

const guardStorage = memoryStorage();
const guard = {
	attempt: (ip, ok) => attempt(guardStorage, ip, ok),
	subscribe: (device, sub) => saveSubscription(guardStorage, device, sub),
	unsubscribe: (device) => dropSubscription(guardStorage, device),
	subscriptions: () => listSubscriptions(guardStorage),
};

const env = {
	PASSCODE: process.env.PASSCODE || "dev",
	SESSION_SECRET: "dev-session-secret",
	AI_GATEWAY_ID: "",
	AI,
	BROWSER,
	ASSETS: { fetch: asset },
	GUARD: { getByName: () => guard },
	SANDBOX: { getByName: () => ({ run: async () => ({ stdout: "", stderr: "", error: "The Python sandbox isn't available in the dev server.", images: [] }) }) },
};

// The Reply Durable Object (src/reply.js), with its storage in memory.
const replies = new Map();
function replyObject(id) {
	if (!replies.has(id)) {
		let meta;
		let text = "";
		const log = new ReplyLog({
			getMeta: () => meta,
			setMeta: (m) => void (meta = m),
			append: (t) => void (text += t),
			readAll: () => text,
			clear: () => void replies.delete(id),
			setAlarm: () => {},
		});
		const stream = async (after) => {
			const body = await log.follow(after);
			if (!body) return Response.json({ error: "This reply is no longer on the server." }, { status: 404 });
			return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "x-thread-started": String(log.meta.started), "cache-control": "no-store" } });
		};
		replies.set(id, {
			async fetch(url, init = {}) {
				const { pathname, searchParams } = new URL(url);
				if (pathname === "/start") {
					const job = JSON.parse(init.body);
					await log.start(job.started, (signal) => generate(env, job, signal));
					return stream(0);
				}
				if (pathname === "/follow") return stream(Number(searchParams.get("after")) || 0);
				await log.cancel();
				return new Response(null, { status: 204 });
			},
		});
	}
	return replies.get(id);
}
env.REPLY = { getByName: replyObject };

createServer(async (req, res) => {
	try {
		const hasBody = req.method !== "GET" && req.method !== "HEAD";
		const request = new Request(`http://${req.headers.host}${req.url}`, {
			method: req.method,
			headers: req.headers,
			body: hasBody ? Readable.toWeb(req) : undefined,
			duplex: hasBody ? "half" : undefined,
		});
		const response = await worker.fetch(request, env, { waitUntil() {} });
		res.writeHead(response.status, Object.fromEntries(response.headers));
		if (!response.body) return res.end();
		const reader = response.body.getReader();
		res.on("close", () => reader.cancel().catch(() => {}));
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			res.write(value);
		}
		res.end();
	} catch (err) {
		console.error(err);
		if (!res.headersSent) res.writeHead(500);
		res.end();
	}
}).listen(PORT, () => {
	console.log(`Thread dev server on http://localhost:${PORT} (passcode "${env.PASSCODE}", ${FAKE ? "canned replies" : "Workers AI over REST, billed"})`);
});
