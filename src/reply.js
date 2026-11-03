import { DurableObject } from "cloudflare:workers";
import { ReplyLog } from "./replylog.js";
import { generate } from "./generate.js";
import { NO_STORE, json } from "./http.js";

// One instance per reply, named by the reply's message id. The Worker forwards three requests here:
// POST /start (body: the validated job), GET /follow?after=N, POST /cancel. See replylog.js.
export class Reply extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		const sql = ctx.storage.sql;
		sql.exec("CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)");
		this.log = new ReplyLog({
			getMeta: () => ctx.storage.get("meta"),
			setMeta: (meta) => ctx.storage.put("meta", meta),
			append: (text) => void sql.exec("INSERT INTO log (text) VALUES (?)", text),
			readAll: () => sql.exec("SELECT text FROM log ORDER BY seq").toArray().map((r) => r.text).join(""),
			clear: () => ctx.storage.deleteAll(),
			setAlarm: (time) => ctx.storage.setAlarm(time),
		});
	}

	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/start" && request.method === "POST") {
			const job = await request.json();
			await this.log.start(job.started, (signal) => generate(this.env, job, signal));
			return this.stream(0);
		}
		if (url.pathname === "/follow" && request.method === "GET") {
			return this.stream(Number(url.searchParams.get("after")) || 0);
		}
		if (url.pathname === "/cancel" && request.method === "POST") {
			await this.log.cancel();
			return new Response(null, { status: 204, headers: NO_STORE });
		}
		return json({ error: "Not found" }, 404);
	}

	async stream(after) {
		const body = await this.log.follow(after);
		if (!body) return json({ error: "This reply is no longer on the server." }, 404);
		return new Response(body, {
			headers: { "content-type": "text/event-stream; charset=utf-8", "x-thread-started": String(this.log.meta.started), ...NO_STORE },
		});
	}

	async alarm() {
		await this.log.expire();
	}
}
