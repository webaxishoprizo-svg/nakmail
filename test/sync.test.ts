import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { extractAddresses, isLocalSentDuplicate, matchesAlias, matchingAliases } from "../workers/zoho/matching";
import { addAssignment } from "../workers/access/store";
import { backfillAlias, syncZoho } from "../workers/zoho/sync";
import { deleteMessage, getMessageAttachmentContent, getMessageAttachmentInfo, moveMessage } from "../workers/zoho/client";
import { makeEnv, mockZoho, seedTokens } from "./helpers";

let zoho: ReturnType<typeof mockZoho> | undefined;
afterEach(() => zoho?.restore());

const inboxMsg = (id: string, to: string, extra: any = {}) => ({
	messageId: id, folderId: "1", threadId: "t" + id, subject: "Hello " + id, fromAddress: "&lt;cust@ext.com&gt;",
	toAddress: to, ccAddress: "Not Provided", receivedTime: String(Date.UTC(2026, 9, 1, 12, 0, Number(id))), status: "0", ...extra,
});
const sentMsg = (id: string, from: string, to: string, extra: any = {}) => ({
	messageId: id, folderId: "2", subject: "Re " + id, fromAddress: from, toAddress: to,
	receivedTime: String(Date.UTC(2026, 9, 1, 13, 0, Number(id))), status: "1", ...extra,
});
const folders = [{ folderId: "1", folderName: "Inbox", folderType: "Inbox" }, { folderId: "2", folderName: "Sent", folderType: "Sent" }];

test("address matching is exact, not substring", () => {
	assert.deepEqual([...extractAddresses("Sales &lt;Sales@NakMedia.co&gt;, other@x.com")].sort(), ["other@x.com", "sales@nakmedia.co"]);
	assert.equal(matchesAlias("inbox", { to: "&lt;presales@nakmedia.co&gt;" }, "sales@nakmedia.co"), false);
	assert.equal(matchesAlias("inbox", { to: "a@x.com", cc: "&lt;sales@nakmedia.co&gt;" }, "sales@nakmedia.co"), true);
	assert.equal(matchesAlias("sent", { from: "sales@nakmedia.co" }, "sales@nakmedia.co"), true);
	assert.equal(matchesAlias("sent", { to: "sales@nakmedia.co", from: "x@y.com" }, "sales@nakmedia.co"), true);
	assert.equal(matchesAlias("inbox", { from: "sales@nakmedia.co", to: "x@y.com" }, "sales@nakmedia.co"), true);
	assert.deepEqual(matchingAliases("inbox", { to: "a@nakmedia.co,b@nakmedia.co" }, ["a@nakmedia.co", "c@nakmedia.co"]), ["a@nakmedia.co"]);
	assert.equal(isLocalSentDuplicate([{ id: "uuid", subject: "S", date: "2026-10-01T10:00:00Z" }], "S", "2026-10-01T10:03:00Z"), true);
	assert.equal(isLocalSentDuplicate([{ id: "z-1", subject: "S", date: "2026-10-01T10:00:00Z" }], "S", "2026-10-01T10:00:00Z"), false);
});

test("each alias mailbox receives ONLY its own mail; main gets everything", async () => {
	const { env, boxes } = makeEnv();
	await seedTokens(env);
	await addAssignment(env, { email: "sam@gmail.com", alias: "sales@nakmedia.co" });
	await addAssignment(env, { email: "li@gmail.com", alias: "support@nakmedia.co" });
	zoho = mockZoho({
		folders,
		messages: {
			"1": [
				inboxMsg("1", "&lt;sales@nakmedia.co&gt;"),
				inboxMsg("2", "&lt;support@nakmedia.co&gt;"),
				inboxMsg("3", "&lt;connect@nakmedia.co&gt;"),
				inboxMsg("4", "&lt;presales@nakmedia.co&gt;"),
				inboxMsg("5", "&lt;connect@nakmedia.co&gt;", { ccAddress: "&lt;sales@nakmedia.co&gt;" }),
			],
			"2": [sentMsg("6", "sales@nakmedia.co", "cust@ext.com"), sentMsg("7", "connect@nakmedia.co", "cust@ext.com")],
		},
	});
	const r = await syncZoho(env);
	assert.equal(r.errors, 0);
	const ids = (a: string, f: string) => boxes.get(a)!.emails.filter((e) => e.folder === f).map((e) => e.id).sort();
	assert.deepEqual(ids("connect@nakmedia.co", "inbox"), ["z-1", "z-2", "z-3", "z-4", "z-5"]);
	assert.deepEqual(ids("connect@nakmedia.co", "sent"), ["z-6", "z-7"]);
	assert.deepEqual(ids("sales@nakmedia.co", "inbox"), ["z-1", "z-5"]);   // To + Cc, not "presales"
	assert.deepEqual(ids("sales@nakmedia.co", "sent"), ["z-6"]);
	assert.deepEqual(ids("support@nakmedia.co", "inbox"), ["z-2"]);
	assert.deepEqual(ids("support@nakmedia.co", "sent"), []);
	// bodies are present and unread flag preserved
	assert.equal(boxes.get("sales@nakmedia.co")!.emails[0].body.startsWith("<p>body"), true);
	assert.equal(boxes.get("sales@nakmedia.co")!.emails.find((e) => e.id === "z-6").read, true);
});

test("re-sync is idempotent and does not refetch content", async () => {
	const { env, boxes } = makeEnv();
	await seedTokens(env);
	await addAssignment(env, { email: "sam@gmail.com", alias: "sales@nakmedia.co" });
	zoho = mockZoho({ folders, messages: { "1": [inboxMsg("1", "sales@nakmedia.co")], "2": [] } });
	await syncZoho(env);
	const before = zoho.calls.filter((c) => c.includes("/content")).length;
	const r = await syncZoho(env);
	assert.equal(r.synced, 0);
	assert.equal(zoho.calls.filter((c) => c.includes("/content")).length, before);
	assert.equal(boxes.get("sales@nakmedia.co")!.emails.length, 1);
});

test("self-heals: alias missing a message that main already has gets it on next sync", async () => {
	const { env, boxes } = makeEnv();
	await seedTokens(env);
	zoho = mockZoho({ folders, messages: { "1": [inboxMsg("1", "sales@nakmedia.co")], "2": [] } });
	await syncZoho(env);                       // no alias assigned yet: only main has it
	await addAssignment(env, { email: "sam@gmail.com", alias: "sales@nakmedia.co" });
	await syncZoho(env);
	assert.equal(boxes.get("sales@nakmedia.co")!.emails.length, 1);
	assert.equal(boxes.get("connect@nakmedia.co")!.emails.length, 1);
});

test("a failing content fetch does not block other messages", async () => {
	const { env, boxes } = makeEnv();
	await seedTokens(env);
	zoho = mockZoho({ folders, messages: { "1": [inboxMsg("1", "a@x.co"), inboxMsg("2", "a@x.co")], "2": [] }, failContent: new Set(["1"]) });
	const r = await syncZoho(env);
	assert.equal(r.errors, 1);
	assert.deepEqual(boxes.get("connect@nakmedia.co")!.emails.map((e) => e.id), ["z-2"]);
});

test("per-run budget caps content fetches at 8 per account; later runs catch up", async () => {
	const { env, boxes } = makeEnv();
	await seedTokens(env);
	const many = Array.from({ length: 40 }, (_, i) => inboxMsg(String(i + 1), "a@x.co"));
	zoho = mockZoho({ folders, messages: { "1": many, "2": [] } });
	await syncZoho(env);
	assert.equal(boxes.get("connect@nakmedia.co")!.emails.length, 8);
	await syncZoho(env); await syncZoho(env); await syncZoho(env); await syncZoho(env);
	assert.equal(boxes.get("connect@nakmedia.co")!.emails.length, 40);
});

test("Zoho folders map to their dedicated local folders and continue across sync runs", async () => {
	const { env, boxes } = makeEnv();
	await seedTokens(env);
	const names = ["Inbox", "Sent", "Drafts", "Templates", "Snoozed", "Spam", "Trash", "Outbox", "Notification", "Newsletter", "Archive"];
	const zohoFolders = names.map((folderName, index) => ({ folderId: String(index + 1), folderName, folderType: folderName }));
	const messages = Object.fromEntries(zohoFolders.map((folder) => [folder.folderId, [inboxMsg(folder.folderId, "connect@nakmedia.co", { folderId: folder.folderId })]]));
	zoho = mockZoho({ folders: zohoFolders, messages });
	await syncZoho(env);
	await syncZoho(env);
	const actual = boxes.get("connect@nakmedia.co")!.emails.map((email) => email.folder).sort();
	assert.deepEqual(actual, ["archive", "draft", "inbox", "newsletter", "notification", "outbox", "sent", "snoozed", "spam", "templates", "trash"].sort());
});

test("Zoho user folders with folderType Inbox stay separate from the Inbox", async () => {
	const { env, boxes } = makeEnv();
	await seedTokens(env);
	const zohoFolders = [
		{ folderId: "1", folderName: "Inbox", folderType: "Inbox" },
		{ folderId: "9", folderName: "Sales Archive", folderType: "Inbox" },
	];
	zoho = mockZoho({
		folders: zohoFolders,
		messages: { "1": [inboxMsg("1", "connect@nakmedia.co")], "9": [inboxMsg("9", "connect@nakmedia.co", { folderId: "9" })] },
	});
	await syncZoho(env);
	const rows = boxes.get("connect@nakmedia.co")!.emails;
	assert.deepEqual(rows.map((email) => [email.id, email.folder]).sort(), [["z-1", "inbox"], ["z-9", "zoho-9"]].sort());
});

test("Zoho attachment metadata, content, move, and delete use the provider APIs", async () => {
	const { env } = makeEnv();
	await seedTokens(env);
	zoho = mockZoho({
		attachmentInfo: { attachments: [{ attachmentId: "12345", attachmentName: "quote.pdf", attachmentSize: 120 }], inline: [{ attachmentId: "67890", attachmentName: "logo.png", attachmentSize: 50, cid: "logo@example" }] },
		attachmentBytes: "pdf-bytes",
	});
	const info = await getMessageAttachmentInfo(env, "connect@nakmedia.co", "1", "44");
	assert.deepEqual(info.map((item) => [item.attachmentId, item.inline]), [["12345", false], ["67890", true]]);
	const response = await getMessageAttachmentContent(env, "connect@nakmedia.co", "1", "44", "12345");
	assert.equal(await response.text(), "pdf-bytes");
	await moveMessage(env, "connect@nakmedia.co", "44", "1", "2");
	await deleteMessage(env, "connect@nakmedia.co", "44", "2");
	assert.ok(zoho.calls.some((call) => call.includes("/attachmentinfo?includeInline=true")));
	assert.ok(zoho.calls.some((call) => call.startsWith("PUT ") && call.includes("/updatemessage")));
	assert.ok(zoho.calls.some((call) => call.startsWith("DELETE ") && call.includes("/folders/2/messages/44?expunge=true")));
});

test("mail sent from the alias through the app is not duplicated by the Zoho Sent copy", async () => {
	const { env, boxes } = makeEnv();
	await seedTokens(env);
	await addAssignment(env, { email: "sam@gmail.com", alias: "sales@nakmedia.co" });
	const aliasBox = env.MAILBOX.get("sales@nakmedia.co");
	const t = Date.UTC(2026, 9, 1, 13, 0, 1);
	await aliasBox.createEmail("sent", { id: "local-uuid", subject: "Re 6", sender: "sales@nakmedia.co", recipient: "cust@ext.com", date: new Date(t - 20_000).toISOString(), body: "x" });
	zoho = mockZoho({ folders, messages: { "1": [], "2": [sentMsg("6", "sales@nakmedia.co", "cust@ext.com")] } });
	await syncZoho(env);
	assert.deepEqual(boxes.get("sales@nakmedia.co")!.emails.map((e) => e.id), ["local-uuid"]);
	assert.deepEqual(boxes.get("connect@nakmedia.co")!.emails.map((e) => e.id), ["z-6"]); // admin still sees it
});

test("backfill copies only matching history into a new alias mailbox, once", async () => {
	const { env, boxes } = makeEnv();
	await seedTokens(env);
	zoho = mockZoho({
		folders,
		messages: { "1": [inboxMsg("1", "sales@nakmedia.co"), inboxMsg("2", "support@nakmedia.co")], "2": [sentMsg("3", "sales@nakmedia.co", "c@ext.com")] },
	});
	await syncZoho(env);                                    // only main exists
	assert.equal(await backfillAlias(env, "sales@nakmedia.co"), 2);
	assert.equal(await backfillAlias(env, "sales@nakmedia.co"), 0);
	const sales = boxes.get("sales@nakmedia.co")!.emails;
	assert.deepEqual(sales.map((e) => e.id).sort(), ["z-1", "z-3"]);
	assert.ok(sales.every((e) => e.starred === false && e.bcc === null));
});
