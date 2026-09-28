import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ContactRecord, MessageRecord, SessionState } from "@meshnet/meshcore";
import { HistoryFileError, historyFileName, parseHistory, writeHistory } from "./format.js";
import { planImport, readHistorySource, type ImportTarget } from "./plan.js";
import { schemaErrors } from "./schemaCheck.js";

const docs = (name: string) => readFileSync(new URL(`../../../../../docs/schema/${name}`, import.meta.url), "utf8");
const SCHEMA = JSON.parse(docs("history-v1.json")) as Record<string, unknown>;

const SELF = "a2".repeat(32);
const BOB = "b0".repeat(32);
const ROOM = "c0".repeat(32);
const GONE = "e0".repeat(32);
const HILL = "d0".repeat(32);
const PUBLIC = "8b3387e9c5cdea6ac9e5edbaa115cd72";
const TEST = "9cd8fcf22a47333b591d96a2b848b73f";
const NOW = 1_790_000_000_000;
const S = NOW / 1000;

function contact(key: string, name: string, extra: Partial<ContactRecord> = {}): ContactRecord {
  return {
    key,
    prefix: key.slice(0, 12),
    type: 1,
    flags: 0,
    outPathLen: 0xff,
    outPath: "".padEnd(128, "0"),
    name,
    lastAdvert: S - 600,
    lat: 0,
    lon: 0,
    lastMod: S - 600,
    lastHeardAt: null,
    pathSince: null,
    ...extra,
  };
}

let n = 0;
function message(conversation: string, extra: Partial<MessageRecord>): MessageRecord {
  n++;
  return {
    id: `m${n}`,
    conversation,
    direction: "in",
    text: `text ${n}`,
    sender: null,
    senderPrefix: null,
    timestamp: S - 1000 + n,
    receivedAt: (S - 1000 + n) * 1000 + 250,
    snr: null,
    hops: null,
    txtType: 0,
    status: null,
    ackTag: null,
    roundTripMs: null,
    flood: null,
    attempt: 0,
    error: null,
    echoes: [],
    route: null,
    retryPlan: null,
    ...extra,
  };
}

const bob = contact(BOB, "Bob", { flags: 1, lat: 54.951456, lon: 73.396419, outPathLen: 2, outPath: "b93a".padEnd(128, "0"), pathSince: (S - 600) * 1000, lastHeardAt: NOW - 5000 });
const room = contact(ROOM, "Our room", { type: 3, outPathLen: 0, pathSince: (S - 600) * 1000 });
const hill = contact(HILL, "Hill", { type: 2, lastHeardAt: NOW - 3_600_000, unsaved: true });
const gone = contact(GONE, "Gone");

const state: Pick<SessionState, "self" | "channels" | "contacts" | "removed" | "messages"> = {
  self: { key: SELF, name: "Node-21" } as SessionState["self"],
  channels: [
    { index: 0, name: "Public", secret: PUBLIC },
    { index: 2, name: "#test", secret: TEST },
  ],
  contacts: { [BOB]: bob, [ROOM]: room, [HILL]: hill },
  removed: { [GONE]: { contact: gone, at: NOW - 86_400_000, by: "you" } },
  messages: [
    message("ch:0", { sender: "Alice", text: "hi all", snr: 7.5, hops: 1, echoes: [{ path: ["b9"], snr: 3 }] }),
    message("ch:2", { direction: "out", sender: "Node-21", senderPrefix: SELF.slice(0, 12), status: "sent", echoes: [{ path: ["01"], snr: 11.75 }, { path: ["b9", "3a"], snr: 8.5 }] }),
    message(`c:${BOB}`, { sender: "Bob", senderPrefix: BOB.slice(0, 12), snr: 12.5, hops: 2 }),
    message(`c:${BOB}`, { direction: "out", sender: "Node-21", senderPrefix: SELF.slice(0, 12), status: "delivered", roundTripMs: 1200, route: ["b9", "3a"], attempt: 1 }),
    message(`c:${BOB}`, { direction: "out", sender: "Node-21", senderPrefix: SELF.slice(0, 12), status: "failed", error: "no route" }),
    message(`c:${ROOM}`, { sender: "Carol", senderPrefix: "ca01ca01", txtType: 2 }),
    message("p:f00df00df00d", { sender: null, senderPrefix: "f00df00df00d", text: "who am I" }),
  ],
};

const target: ImportTarget = {
  self: { key: SELF, name: "Node-21", prefix: SELF.slice(0, 12) },
  // The radio holds the same channels, in other slots.
  channels: [
    { index: 1, name: "Public", secret: PUBLIC },
    { index: 5, name: "#test", secret: TEST },
  ],
  contacts: {},
  now: NOW,
};

test("a saved history follows the published schema, every field of it", () => {
  const file = writeHistory(state, "Ommesh 0.4.0", NOW);
  const json = JSON.parse(JSON.stringify(file));
  assert.deepEqual(schemaErrors(SCHEMA, json, true), []);
  // The check is not a blind one: a field the schema does not describe, or one of the wrong shape, is caught.
  const first = json.messages[0];
  assert.deepEqual(schemaErrors(SCHEMA, { ...json, messages: [{ ...first, typed: "x" }] }, true), ["$.messages[0].typed: not in the schema"]);
  assert.deepEqual(schemaErrors(SCHEMA, { ...json, messages: [{ ...first, chat: { channel: "8b" } }] }), ["$.messages[0].chat: matches 0 of oneOf"]);
  assert.equal(file.exportedAt, new Date(NOW).toISOString());
  assert.deepEqual(file.radio, { key: SELF, name: "Node-21" });
  assert.deepEqual(file.contacts.map((c) => [c.name, c.on]), [
    ["Bob", "radio"],
    ["Our room", "radio"],
    ["Hill", "heard"],
    ["Gone", "removed"],
  ]);
  assert.deepEqual(file.contacts[0]!.route, ["b9", "3a"]);
  assert.deepEqual(file.contacts[1]!.route, []);
  assert.equal(file.contacts[2]!.route, null);
  assert.equal(file.contacts[3]!.removedBy, "you");
});

test("what is written comes back as it was, in other slots of the same channels", () => {
  const text = JSON.stringify(writeHistory(state, "Ommesh 0.4.0", NOW));
  const plan = planImport(readHistorySource(new TextEncoder().encode(text)), target);
  const slot = (conversation: string) => ({ "ch:0": "ch:1", "ch:2": "ch:5" })[conversation] ?? conversation;
  const kept = (m: MessageRecord) => ({ ...m, conversation: slot(m.conversation), attempt: 0 });
  assert.deepEqual(plan.history.messages, state.messages.map(kept));
  assert.deepEqual(plan.history.contacts, [bob, room].map((c) => ({ ...c, lastMod: c.lastAdvert })));
  assert.deepEqual(plan.history.heard, [{ ...hill, lastMod: hill.lastAdvert }]);
  assert.deepEqual(plan.history.removed, [{ contact: gone, at: NOW, by: "you" }]);
  assert.deepEqual(plan.left.channels, []);
});

test("a message whose slot holds no channel now is not written, nor a line of a node's console", () => {
  const file = writeHistory({ ...state, messages: [message("ch:7", {}), message(`c:${HILL}`, { txtType: 1 })] }, "Ommesh", NOW);
  assert.deepEqual(file.messages, []);
});

test("the example in the documentation follows the schema and can be brought in", () => {
  const text = docs("history-v1.example.json");
  assert.deepEqual(schemaErrors(SCHEMA, JSON.parse(text), true), []);
  const file = parseHistory(text);
  const plan = planImport(
    { kind: "ommesh", radioKey: file.radio.key, body: file, console: 0 },
    { self: { key: file.radio.key, name: "Node-21", prefix: file.radio.key.slice(0, 12) }, channels: [{ index: 0, name: "Public", secret: PUBLIC }], contacts: {}, now: Date.parse("2026-09-28T15:00:00Z") },
  );
  assert.equal(plan.history.messages.length, 5);
  // A channel neither the radio nor the file names is called by the start of its secret.
  assert.deepEqual(plan.left.channels, [{ name: "5d41402a", messages: 1 }]);
  // One from another program, without id or receivedAt, is taken as received when it was sent.
  const kolya = plan.history.messages.find((m) => m.text === "ты где?")!;
  assert.equal(kolya.receivedAt, Date.parse("2026-09-28T14:01:10.000Z"));
  assert.equal(kolya.senderPrefix, "b0c4e1f27a9d");
  assert.deepEqual(plan.history.contacts.map((c) => c.name), ["Kolya", "Club room"]);
  assert.deepEqual(plan.history.heard.map((c) => c.name), ["AMUR-21"]);
  assert.deepEqual(plan.history.removed.map((r) => [r.contact.name, r.by]), [["Old friend", "you"]]);
});

test("a message left waiting elsewhere is not sent from here", () => {
  const file = writeHistory(
    { ...state, messages: [message(`c:${BOB}`, { direction: "out", status: "queued" }), message(`c:${BOB}`, { direction: "out", status: "sending" })] },
    "Ommesh",
    NOW,
  );
  const plan = planImport(readHistorySource(new TextEncoder().encode(JSON.stringify(file))), target);
  assert.deepEqual(plan.history.messages.map((m) => m.status), ["failed", "unconfirmed"]);
});

test("a file that is not a history, or not this version's, says which", () => {
  const kind = (text: string) => {
    try {
      parseHistory(text);
      return "read";
    } catch (error) {
      assert.ok(error instanceof HistoryFileError);
      return error.kind === "field" ? `field ${error.path}` : error.kind;
    }
  };
  const base = { format: "ommesh-history", version: 1, radio: { key: SELF } };
  assert.equal(kind("{"), "notHistory");
  assert.equal(kind(JSON.stringify({ ...base, format: "other" })), "notHistory");
  assert.equal(kind(JSON.stringify({ ...base, version: 2 })), "newer");
  assert.equal(kind(JSON.stringify(base)), "read");
  assert.equal(kind(JSON.stringify({ ...base, radio: { key: "a2" } })), "field radio.key");
  const one = { chat: { contact: BOB }, direction: "in", text: "hi", sentAt: "2026-09-28T14:00:00Z" };
  assert.equal(kind(JSON.stringify({ ...base, messages: [one] })), "read");
  assert.equal(kind(JSON.stringify({ ...base, messages: [one, { ...one, chat: { contact: "b0" } }] })), "field messages[1].chat.contact");
  assert.equal(kind(JSON.stringify({ ...base, messages: [{ ...one, chat: { contact: BOB, channel: PUBLIC } }] })), "field messages[0].chat");
  assert.equal(kind(JSON.stringify({ ...base, messages: [{ ...one, sentAt: "yesterday" }] })), "field messages[0].sentAt");
  assert.equal(kind(JSON.stringify({ ...base, messages: [{ ...one, route: ["b9", "3a3a"] }] })), "field messages[0].route");
  // Fields it does not know are passed over, and hex is taken in either case.
  assert.equal(parseHistory(JSON.stringify({ ...base, radio: { key: SELF.toUpperCase() }, later: true })).radio.key, SELF);
});

test("the file is named after the radio and the day", () => {
  const day = new Date(2026, 8, 28, 23, 50).getTime();
  assert.equal(historyFileName("Node-21", day), "ommesh-Node-21-2026-09-28.json");
  assert.equal(historyFileName("Дача / крыша: 2", day), "ommesh-Дача-крыша-2-2026-09-28.json");
  assert.equal(historyFileName("...", day), "ommesh-radio-2026-09-28.json");
});
