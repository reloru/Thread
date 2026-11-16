import { test } from "node:test";
import assert from "node:assert/strict";
import {
	BACKUP_KEYS,
	backupParts,
	chatMarkdown,
	chatText,
	cleanChat,
	fileName,
	makeTitle,
	matchesTerms,
	mergePlan,
	parseBackup,
	searchTerms,
	snippet,
} from "../public/chats.js";

const ID = "11111111-2222-4333-8444-555555555555";
const MSG = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const opts = { newId: () => "00000000-0000-4000-8000-000000000000", now: 1000 };

const chat = () => ({
	id: ID,
	title: "Trip plan",
	created: 10,
	updated: 20,
	tools: ["web"],
	messages: [
		{ id: MSG, role: "user", content: "Plan a trip to Lisbon", time: 11, images: [PNG], files: [{ name: "budget.csv", text: "a,b", truncated: false }] },
		{
			id: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			role: "assistant",
			content: "Start in **Alfama**.",
			reasoning: "thinking",
			model: "@cf/x/model",
			time: 12,
			thinkMs: 900,
			tools: [
				{ id: "c1", name: "web_search", args: { query: "lisbon sights" }, running: false, result: { results: [] } },
				{ id: "c2", name: "fetch_url", args: { url: "https://example.com/a" }, running: false, result: {} },
				{ id: "c3", name: "run_python", args: { code: "print('```')" }, running: false, result: { stdout: "```\n", images: ["x"] } },
			],
		},
	],
});

test("makeTitle: one line, at most 60 characters", () => {
	assert.equal(makeTitle("  hello\n\nworld "), "hello world");
	assert.equal(makeTitle("x".repeat(80)).length, 58);
	assert.equal(makeTitle(""), "New chat");
});

test("chatText covers message text and file names, and stops at its cap", () => {
	const text = chatText(chat());
	assert.ok(text.includes("budget.csv") && text.includes("Lisbon") && text.includes("Alfama"));
	assert.ok(!text.includes("thinking"), "reasoning is not searched");
	const long = chatText({ messages: [{ content: "a".repeat(150000) }, { content: "b".repeat(150000) }, { content: "c" }] });
	assert.ok(long.length <= 200001);
	assert.ok(!long.includes("c"));
});

test("search: every word has to appear, in the title or the text", () => {
	assert.deepEqual(searchTerms("  Lisbon  TRIP lisbon "), ["lisbon", "trip"]);
	assert.equal(searchTerms("a b c d e f g h i j").length, 8);
	const terms = searchTerms("trip alfama");
	assert.equal(matchesTerms(terms, "trip plan", "start in **alfama**."), true);
	assert.equal(matchesTerms(terms, "trip plan", "nothing here"), false);
	assert.equal(matchesTerms([], "x", "y"), true);
});

test("snippet shows the text around the first match and marks it", () => {
	const text = `${"intro ".repeat(40)}the Alfama\n\ndistrict ${"tail ".repeat(60)}`;
	const parts = snippet(text, text.toLowerCase(), ["alfama", "district"], 60);
	assert.deepEqual(parts.map((p) => p.hit), [false, true, false]);
	assert.equal(parts[1].text, "Alfama");
	assert.ok(parts[0].text.startsWith("…") && parts[2].text.endsWith("…"));
	assert.ok(parts[2].text.startsWith(" district"), "line breaks become one space");
	assert.ok(parts.map((p) => p.text).join("").length <= 62);
	assert.deepEqual(snippet("abc", "abc", ["zzz"]), []);
	assert.deepEqual(snippet("Alfama", "alfama", ["alfama"]), [{ text: "Alfama", hit: true }]);
});

test("chatMarkdown: headings per speaker, tool use summarized, code fenced safely", () => {
	const md = chatMarkdown(chat(), () => "Test Model");
	assert.ok(md.startsWith("# Trip plan\n\n## You\n\n_File: budget.csv_\n\n_1 image not included._\n\nPlan a trip to Lisbon\n\n## Test Model\n\n"));
	assert.ok(md.includes("> Searched the web for “lisbon sights”"));
	assert.ok(md.includes("> Read https://example.com/a"));
	assert.ok(md.includes("````python\nprint('```')\n````"), "a fence longer than the backticks in the code");
	assert.ok(md.includes("_1 figure not included._"));
	assert.ok(md.endsWith("Start in **Alfama**.\n"));
	assert.ok(!md.includes("thinking"));
});

test("fileName keeps letters, digits, spaces and dashes", () => {
	assert.equal(fileName('What is 2/3 of "x"?', "md"), "What is 2 3 of x.md");
	assert.equal(fileName("///", "md"), "chat.md");
	assert.equal(fileName("Größe über alles", "md"), "Größe über alles.md");
	assert.ok(fileName("y".repeat(200), "md").length <= 63);
});

test("a backup round-trips through backupParts and parseBackup", () => {
	const settings = { "thread.instructions": "Be brief.", "thread.theme": "dark" };
	const json = backupParts([chat(), { ...chat(), id: "22222222-2222-4333-8444-555555555555" }], settings, 0).join("");
	const data = JSON.parse(json);
	assert.equal(data.app, "thread");
	assert.equal(data.exported, "1970-01-01T00:00:00.000Z");
	const back = parseBackup(json, opts);
	assert.equal(back.chats.length, 2);
	assert.equal(back.skipped, 0);
	assert.deepEqual(back.settings, settings);
	assert.deepEqual(back.chats[0].messages[0], chat().messages[0]);
	assert.equal(back.chats[0].messages[1].tools.length, 3);
	assert.equal(backupParts([], {}, 0).join(""), '{"app":"thread","version":1,"exported":"1970-01-01T00:00:00.000Z","settings":{},"chats":[]}');
});

test("parseBackup refuses other files and newer versions", () => {
	assert.throws(() => parseBackup("not json"), /isn't JSON/);
	assert.throws(() => parseBackup("[]"), /isn't a Thread backup/);
	assert.throws(() => parseBackup(JSON.stringify({ app: "other", chats: [] })), /isn't a Thread backup/);
	assert.throws(() => parseBackup(JSON.stringify({ app: "thread", version: 99, chats: [] })), /newer version/);
});

test("parseBackup keeps only settings that belong in a backup", () => {
	const json = JSON.stringify({ app: "thread", version: 1, chats: [], settings: { "thread.token": "t1.secret", "thread.theme": "dark", "thread.model": 5 } });
	assert.deepEqual(parseBackup(json).settings, { "thread.theme": "dark" });
	assert.ok(!BACKUP_KEYS.includes("thread.token"));
});

test("cleanChat drops what the app can't use and repairs what it can", () => {
	assert.equal(cleanChat(null), null);
	assert.equal(cleanChat({ id: "nope", messages: [{ role: "user", content: "x" }] }), null);
	assert.equal(cleanChat({ id: ID, messages: [] }), null);
	assert.equal(cleanChat({ id: ID, messages: [{ role: "system", content: "x" }, { role: "user", content: "" }] }), null);

	const cleaned = cleanChat(
		{
			id: ID,
			title: 7,
			updated: "soon",
			tools: ["web", "shell"],
			extra: "dropped",
			messages: [
				{ id: "bad", role: "user", content: "Hello there", images: [PNG, "https://evil.example/x.png", 5], files: [{ name: "a.txt" }, { name: "b.txt", text: "ok" }] },
				{
					role: "assistant",
					content: 12,
					pending: true,
					model: "m",
					tools: [
						{ id: "1", name: "run_python", args: "bad", running: true },
						{ id: "2", name: "web_search", preparing: true, running: true },
						"junk",
					],
				},
			],
		},
		opts,
	);
	assert.equal(cleaned.title, "Hello there");
	assert.equal(cleaned.created, 1000);
	assert.equal(cleaned.updated, 1000);
	assert.deepEqual(cleaned.tools, ["web"]);
	assert.equal("extra" in cleaned, false);
	const [user, reply] = cleaned.messages;
	assert.equal(user.id, "00000000-0000-4000-8000-000000000000");
	assert.deepEqual(user.images, [PNG]);
	assert.deepEqual(user.files, [{ name: "b.txt", text: "ok", truncated: false }]);
	assert.equal(reply.content, "");
	assert.equal(reply.lost, true);
	assert.equal("pending" in reply, false);
	assert.deepEqual(reply.tools, [{ id: "1", name: "run_python", args: {}, running: false, result: { error: "Stopped before the tool finished." } }]);
});

test("parseBackup counts chats it had to leave out, including repeats of an id", () => {
	const json = JSON.stringify({ app: "thread", version: 1, chats: [chat(), chat(), { id: "x" }] });
	const back = parseBackup(json, opts);
	assert.equal(back.chats.length, 1);
	assert.equal(back.skipped, 2);
});

test("mergePlan stores new chats and ones that are older on the device", () => {
	const a = { id: "a", updated: 5 };
	const b = { id: "b", updated: 5 };
	const c = { id: "c", updated: 5 };
	const plan = mergePlan([a, b, c], new Map([["a", 5], ["b", 4]]));
	assert.deepEqual(plan.save, [b, c]);
	assert.equal(plan.kept, 1);
});
