import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OtherRadioError, planImport, readHistorySource, type ImportTarget } from "./plan.js";
import { readMeshCoreApp } from "./meshcoreApp.js";
import { schemaErrors } from "./schemaCheck.js";
import { parseColumns, SqliteFile } from "./sqlite.js";

const SELF = "a2".repeat(32);
const BOB = "b0".repeat(32);
const ROOM = "c0".repeat(32);
const CAROL = "ca".repeat(32);
const DAVE = "da".repeat(32);
const PUBLIC = "8b".repeat(16);
const OLD = "07".repeat(16);
const NOW = 1_790_000_000_000;
const S = NOW / 1000;

/** The official app's tables as its export has them, written by SQLite itself; small pages, so there are many. */
function officialDb(fill: (db: DatabaseSync) => void): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "official-"));
  const file = join(dir, "export.db");
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA page_size = 512;
    CREATE TABLE "channels" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "channel_idx" INTEGER NOT NULL UNIQUE, "name" TEXT NOT NULL, "secret" BLOB NOT NULL, "last_message_sent_or_received_at" INTEGER NULL);
    CREATE TABLE "channel_messages" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "channel_secret" BLOB NULL, "from" TEXT NULL, "path_len" INTEGER NULL, "txt_type" INTEGER NOT NULL, "sender_timestamp" INTEGER NOT NULL, "text" TEXT NOT NULL, "timestamp" INTEGER NOT NULL, "snr" REAL NULL);
    ALTER TABLE "channel_messages" ADD COLUMN "repeats_heard_count" INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE "channel_message_heard_repeats" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "channel_message_id" INTEGER NOT NULL, "path" BLOB NOT NULL, "path_len" INTEGER NULL, "snr" REAL NOT NULL, "heard_at" INTEGER NOT NULL, UNIQUE ("channel_message_id", "path"));
    CREATE TABLE "contact_messages" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "attempt" INTEGER NULL, "status" TEXT NOT NULL, "to" TEXT NOT NULL, "from" TEXT NOT NULL, "path_len" INTEGER NULL, "txt_type" INTEGER NOT NULL, "sender_timestamp" INTEGER NOT NULL, "text" TEXT NOT NULL, "expected_ack_crc" INTEGER NULL, "send_result" INTEGER NULL, "rtt" INTEGER NULL, "error" TEXT NULL, "timestamp" INTEGER NOT NULL, "room_post_author_pub_key_prefix" TEXT NULL, "snr" REAL NULL, "max_attempts" INTEGER NULL);
    CREATE TABLE "contacts" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "public_key" BLOB NOT NULL UNIQUE, "type" INTEGER NOT NULL, "flags" INTEGER NOT NULL, "out_path_len" INTEGER NOT NULL, "out_path" BLOB NOT NULL, "adv_name" TEXT NOT NULL, "last_advert" INTEGER NOT NULL, "adv_lat" INTEGER NOT NULL, "adv_lon" INTEGER NOT NULL, "last_mod" INTEGER NOT NULL, "custom_name" TEXT NULL);
    CREATE TABLE "discovered_contacts" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "public_key" BLOB NOT NULL UNIQUE, "type" INTEGER NOT NULL, "flags" INTEGER NOT NULL, "out_path_len" INTEGER NOT NULL, "out_path" BLOB NOT NULL, "adv_name" TEXT NOT NULL, "last_advert" INTEGER NOT NULL, "adv_lat" INTEGER NOT NULL, "adv_lon" INTEGER NOT NULL, "last_mod" INTEGER NOT NULL);
  `);
  fill(db);
  db.close();
  const bytes = new Uint8Array(readFileSync(file));
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}

const blob = (hex: string) => Buffer.from(hex, "hex");

function sample(): Uint8Array {
  return officialDb((db) => {
    db.prepare(`INSERT INTO channels (channel_idx, name, secret) VALUES (?, ?, ?)`).run(0, "Public", blob(PUBLIC));
    db.prepare(`INSERT INTO channels (channel_idx, name, secret) VALUES (?, ?, ?)`).run(1, "Old", blob(OLD));
    const channel = db.prepare(`INSERT INTO channel_messages (channel_secret, "from", path_len, txt_type, sender_timestamp, text, timestamp, snr, repeats_heard_count) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`);
    // Enough rows for the table to span interior pages.
    for (let i = 0; i < 300; i++) channel.run(blob(PUBLIC), null, 65, S - 1000 + i, `Alice: hi ${i}`, (S - 1000 + i) * 1000 + 300, 7.5, 0);
    // Longer than a page: it runs on into overflow pages.
    channel.run(blob(PUBLIC), null, 2, S, `Alice: ${"я".repeat(1500)}`, NOW, 6, 0);
    const ours = channel.run(blob(PUBLIC), SELF, null, S + 1, "hello all", NOW + 1000, null, 2).lastInsertRowid;
    channel.run(blob(OLD), null, 0, S, "Bob: lost channel", NOW, 5, 0);
    // Past the 30 days brought in: left out, whatever its channel.
    channel.run(blob(PUBLIC), null, 1, S - 31 * 86400, "Alice: too old", (S - 31 * 86400) * 1000, 5, 0);
    channel.run(blob(OLD), null, 1, S - 40 * 86400, "Bob: too old", (S - 40 * 86400) * 1000, 5, 0);
    const repeat = db.prepare(`INSERT INTO channel_message_heard_repeats (channel_message_id, path, path_len, snr, heard_at) VALUES (?, ?, ?, ?, ?)`);
    repeat.run(ours, blob("0101"), 65, 11.75, S + 2);
    repeat.run(ours, blob("b93a468e"), 66, 8.5, S + 3);

    const dm = db.prepare(`INSERT INTO contact_messages (attempt, status, "to", "from", path_len, txt_type, sender_timestamp, text, expected_ack_crc, rtt, "timestamp", room_post_author_pub_key_prefix, snr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    dm.run(null, "received", SELF, BOB, -1, 0, S, "hi there", null, null, NOW, null, 12.5);
    dm.run(0, "delivered", BOB, SELF, null, 0, S + 5, "hi back", 3162209875, 1200, NOW + 5000, null, null);
    dm.run(1, "sending", BOB, SELF, null, 0, S + 6, "are you there?", 42, null, NOW + 6000, null, null);
    dm.run(null, "received", SELF, BOB, -1, 1, S + 7, "01|> 869.0,62.5,7,7", null, null, NOW + 7000, null, 12);
    dm.run(null, "received", SELF, ROOM, 1, 2, S + 8, "room post", null, null, NOW + 8000, BOB.slice(0, 8), 9);
    dm.run(0, "delivered", BOB, SELF, null, 0, S - 31 * 86400, "too old", 7, 900, (S - 31 * 86400) * 1000, null, null);

    const contact = db.prepare(`INSERT INTO contacts (public_key, type, flags, out_path_len, out_path, adv_name, last_advert, adv_lat, adv_lon, last_mod, custom_name) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`);
    contact.run(blob(BOB), 1, -1, blob("00".repeat(64)), "Bob", S - 60, 54951456, 73396419, S - 60, null);
    contact.run(blob(ROOM), 3, 1, blob("b9".padEnd(128, "0")), "Room", S - 60, 0, 0, S - 60, "Our room");
    const node = db.prepare(`INSERT INTO discovered_contacts (public_key, type, flags, out_path_len, out_path, adv_name, last_advert, adv_lat, adv_lon, last_mod) VALUES (?, 2, 0, -1, ?, ?, ?, 0, 0, ?)`);
    node.run(blob(CAROL), blob("00".repeat(64)), "Carol", S - 3600, S - 3600);
    node.run(blob(DAVE), blob("00".repeat(64)), "Dave", S - 30 * 86400, S - 30 * 86400);
    node.run(blob(BOB), blob("00".repeat(64)), "Bob", S - 60, S - 60);
  });
}

const target: ImportTarget = {
  self: { key: SELF, name: "Me", prefix: SELF.slice(0, 12) },
  // The radio holds Public in another slot than the official app saw it in, and no longer holds Old.
  channels: [{ index: 3, name: "Public", secret: PUBLIC }],
  contacts: {},
  now: NOW,
};

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

test("the tables of an SQLite file read back as written, across pages and overflow", () => {
  const db = new SqliteFile(sample());
  assert.ok(db.tables.has("channel_messages"));
  const rows = [...db.rows("channel_messages")];
  assert.equal(rows.length, 305);
  assert.deepEqual(rows.map((r) => r.id), rows.map((_, i) => i + 1));
  assert.equal(rows[0]!.text, "Alice: hi 0");
  assert.equal(rows[300]!.text, `Alice: ${"я".repeat(1500)}`);
  assert.equal(rows[301]!.repeats_heard_count, 2);
  assert.deepEqual(rows[0]!.channel_secret, new Uint8Array(blob(PUBLIC)));
  const dms = [...db.rows("contact_messages")];
  assert.equal(dms[1]!.expected_ack_crc, 3162209875);
  assert.equal(dms[0]!.path_len, -1);
  assert.equal(dms[0]!.snr, 12.5);
  assert.throws(() => new SqliteFile(new Uint8Array(200)), /not an SQLite database/);
});

test("a table's columns come from its CREATE statement, quoted or not", () => {
  assert.deepEqual(parseColumns(`CREATE TABLE t ("id" INTEGER NOT NULL PRIMARY KEY, [a b] TEXT, \`c\`, d REAL CHECK (d IN (0, 1)), UNIQUE ("id", d))`), {
    columns: ["id", "a b", "c", "d"],
    rowidColumn: 0,
  });
  assert.equal(parseColumns(`CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)`).rowidColumn, null);
});

test("the official app's export reads as a history file holds one", () => {
  const { radioKey, body, console } = readMeshCoreApp(sample());
  assert.equal(radioKey, SELF);
  assert.equal(console, 1);
  assert.deepEqual(body.channels, [
    { secret: PUBLIC, name: "Public" },
    { secret: OLD, name: "Old" },
  ]);

  // Every message comes across, however old; which of them the radio can take is decided later.
  const channel = body.messages.filter((m) => "channel" in m.chat);
  assert.equal(channel.length, 305);
  assert.deepEqual(channel[0], {
    id: "official:ch:1",
    chat: { channel: PUBLIC },
    direction: "in",
    text: "hi 0",
    from: { name: "Alice" },
    sentAt: iso(S - 1000),
    receivedAt: new Date((S - 1000) * 1000 + 300).toISOString(),
    snr: 7.5,
    hops: 1,
  });
  const ours = channel.find((m) => m.direction === "out")!;
  assert.equal(ours.text, "hello all");
  assert.equal(ours.status, "sent");
  assert.equal(ours.from, undefined);
  assert.deepEqual(ours.echoes, [
    { path: ["0101"], snr: 11.75 },
    { path: ["b93a", "468e"], snr: 8.5 },
  ]);

  const bob = body.messages.filter((m) => "contact" in m.chat && m.chat.contact === BOB);
  assert.deepEqual(bob.map((m) => [m.direction, m.text, m.status]), [
    ["in", "hi there", undefined],
    ["out", "hi back", "delivered"],
    ["out", "are you there?", "sending"],
    ["out", "too old", "delivered"],
  ]);
  assert.deepEqual(bob[0]!.from, { key: BOB.slice(0, 12), name: "Bob" });
  // Heard direct: no hop count.
  assert.equal(bob[0]!.hops, undefined);
  assert.equal(bob[1]!.roundTripMs, 1200);

  const post = body.messages.find((m) => "contact" in m.chat && m.chat.contact === ROOM)!;
  assert.deepEqual(post.from, { key: BOB.slice(0, 8), name: "Bob" });
  assert.equal(post.roomPost, true);

  assert.deepEqual(
    body.contacts.map((c) => [c.name, c.kind, c.on]),
    [
      ["Bob", "chat", "radio"],
      ["Our room", "room", "radio"],
      ["Carol", "repeater", "heard"],
      ["Dave", "repeater", "heard"],
    ],
  );
  const [bobContact, room, carol] = body.contacts;
  assert.equal(bobContact!.key, BOB);
  assert.equal(bobContact!.route, null);
  assert.equal(bobContact!.lat, 54.951456);
  assert.deepEqual(room!.route, ["b9"]);
  assert.equal(carol!.lastHeard, iso(S - 3600));

  // What it reads is a history as the documentation describes one.
  const schema = JSON.parse(readFileSync(new URL("../../../../../docs/schema/history-v1.json", import.meta.url), "utf8"));
  const file = { format: "ommesh-history", version: 1, radio: { key: SELF }, ...body };
  assert.deepEqual(schemaErrors(schema, JSON.parse(JSON.stringify(file)), true), []);
});

test("brought to the radio, a channel goes to the slot with its secret, and what cannot come is named", () => {
  const source = readHistorySource(sample());
  assert.equal(source.kind, "meshcoreApp");
  const plan = planImport(source, target);
  const { messages, contacts, removed, heard } = plan.history;

  const channel = messages.filter((m) => m.conversation === "ch:3");
  assert.equal(channel.length, 303);
  assert.equal(channel[0]!.sender, "Alice");
  assert.equal(channel[0]!.timestamp, S - 1000);
  assert.equal(channel[0]!.receivedAt, (S - 1000) * 1000 + 300);
  const ours = channel.find((m) => m.direction === "out")!;
  assert.equal(ours.sender, "Me");
  assert.equal(ours.senderPrefix, SELF.slice(0, 12));
  assert.deepEqual(plan.left.channels, [{ name: "Old", messages: 2 }]);
  assert.equal(plan.left.console, 1);

  const bob = messages.filter((m) => m.conversation === `c:${BOB}`);
  assert.equal(bob[0]!.sender, "Bob");
  assert.equal(bob[0]!.senderPrefix, BOB.slice(0, 12));
  // One the official app was still waiting on is not waited for here.
  assert.equal(bob[2]!.status, "unconfirmed");
  assert.ok(messages.every((m) => m.retryPlan === null && m.ackTag === null));

  const post = messages.find((m) => m.conversation === `c:${ROOM}`)!;
  assert.equal(post.sender, "Bob");
  assert.equal(post.senderPrefix, BOB.slice(0, 8));
  assert.equal(post.txtType, 2);

  assert.deepEqual(contacts.map((c) => c.name), ["Bob", "Our room"]);
  assert.equal(contacts[0]!.outPathLen, 0xff);
  assert.equal(contacts[0]!.pathSince, null);
  assert.equal(contacts[1]!.outPathLen, 1);
  assert.equal(contacts[1]!.pathSince, (S - 60) * 1000);
  assert.deepEqual(removed, []);
  // Carol was heard an hour ago; Dave a month ago, longer than a node heard here stays.
  assert.deepEqual(heard.map((c) => [c.name, c.unsaved, c.lastHeardAt]), [["Carol", true, NOW - 3_600_000]]);
  assert.equal(plan.left.quietNodes, 1);
  assert.equal(plan.chats, 3);
  // The oldest that comes: the one of 40 days ago is on the channel left out.
  assert.equal(plan.from, (S - 31 * 86400) * 1000);
});

test("another radio's history is refused", () => {
  const other = { ...target, self: { ...target.self, key: "ee".repeat(32) } };
  assert.throws(() => planImport(readHistorySource(sample()), other), (error) => error instanceof OtherRadioError && error.radioKey === SELF);
});

test("a file that is not the official app's export says so", () => {
  const bytes = officialDb((db) => db.exec(`DROP TABLE contacts`));
  assert.throws(() => readMeshCoreApp(bytes), /no contacts table/);
});
