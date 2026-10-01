import { test } from "node:test";
import assert from "node:assert/strict";
import { AdvType, type MessageRecord, type SessionState } from "@meshnet/meshcore";
import { anyMessageWanted, DEFAULT_PREFS, fromStored, kindSounds, messageWanted, nodeWanted, noticeSignal, oneSignal, summaryOf, type NoticePrefs } from "./noticePrefs.js";

const BOB = "b0".repeat(32);
const ROOM = "c0".repeat(32);

const state = {
  self: { name: "Me" },
  contacts: {
    [BOB]: { key: BOB, type: AdvType.Chat, name: "Bob" },
    [ROOM]: { key: ROOM, type: AdvType.Room, name: "Hall" },
  },
} as unknown as SessionState;

function said(conversation: string, text: string): MessageRecord {
  return { conversation, text } as MessageRecord;
}

function prefs(patch: Partial<NoticePrefs>): NoticePrefs {
  return { ...DEFAULT_PREFS, ...patch };
}

test("a person's message follows the direct switch, a room's the one for channels and rooms", () => {
  const p = prefs({ direct: true, chats: "off" });
  assert.equal(messageWanted(p, state, said(`c:${BOB}`, "hi")), true);
  assert.equal(messageWanted(p, state, said(`c:${ROOM}`, "hi")), false);
  assert.equal(messageWanted(p, state, said("ch:0", "hi")), false);
  // A sender not in the contacts yet writes to you, as a person.
  assert.equal(messageWanted(p, state, said("p:b0b0b0b0b0b0", "hi")), true);
});

test("at mentions only a message that names this radio rings", () => {
  const p = prefs({ chats: "mentions" });
  assert.equal(messageWanted(p, state, said("ch:0", "hello all")), false);
  assert.equal(messageWanted(p, state, said("ch:0", "@[Me] hello")), true);
  assert.equal(messageWanted(p, state, said(`c:${ROOM}`, "@[Me] up?")), true);
});

test("a chat's own level wins over the one for its kind, either way", () => {
  const p = prefs({ direct: false, chats: "all", chat: { "ch:0": "off", "ch:1": "mentions", [`c:${BOB}`]: "all" } });
  assert.equal(messageWanted(p, state, said("ch:0", "@[Me] hi")), false);
  assert.equal(messageWanted(p, state, said("ch:1", "hi")), false);
  assert.equal(messageWanted(p, state, said("ch:1", "@[Me] hi")), true);
  assert.equal(messageWanted(p, state, said("ch:2", "hi")), true);
  assert.equal(messageWanted(p, state, said(`c:${BOB}`, "hi")), true);
});

test("new nodes: people means a companion only", () => {
  assert.equal(nodeWanted(prefs({ nodes: "people" }), AdvType.Chat), true);
  assert.equal(nodeWanted(prefs({ nodes: "people" }), AdvType.Repeater), false);
  assert.equal(nodeWanted(prefs({ nodes: "all" }), AdvType.Sensor), true);
  assert.equal(nodeWanted(prefs({ nodes: "off" }), AdvType.Chat), false);
});

test("a chat of its own keeps messages possible with the rest off, and the summary says so", () => {
  const off = prefs({ direct: false, chats: "off", nodes: "off" });
  assert.equal(anyMessageWanted(off), false);
  assert.equal(summaryOf(off), "Off");
  const one = { ...off, chat: { "ch:1": "all" as const } };
  assert.equal(anyMessageWanted(one), true);
  assert.equal(summaryOf(one), "Custom");
  assert.equal(summaryOf(DEFAULT_PREFS), "On");
  assert.equal(summaryOf(prefs({ chats: "mentions" })), "Mentions");
});

test("one sound from an earlier build becomes each kind's, and what else was stored stays", () => {
  const p = fromStored({ signal: "sonar", chats: "mentions" } as Parameters<typeof fromStored>[0]);
  assert.deepEqual(p.sounds, { direct: "sonar", chats: "sonar", nodes: "sonar" });
  assert.equal(p.chats, "mentions");
  assert.equal("signal" in p, false);
  assert.deepEqual(fromStored({ sounds: { direct: "hop", chats: "chirp", nodes: "none" } }).sounds, { direct: "hop", chats: "chirp", nodes: "none" });
  assert.deepEqual(fromStored({}), DEFAULT_PREFS);
});

test("a chat's own sound wins over its kind's; a node's and the notice about several chats ring with their kind's", () => {
  const p = prefs({ sounds: { direct: "chirp", chats: "hop", nodes: "sonar" }, chatSound: { "ch:0": "roger", [`c:${BOB}`]: "none" } });
  assert.equal(noticeSignal(p, { tag: "c:ch:0", kind: "chats" }), "roger");
  assert.equal(noticeSignal(p, { tag: "c:ch:1", kind: "chats" }), "hop");
  assert.equal(noticeSignal(p, { tag: `c:c:${BOB}`, kind: "direct" }), "none", "a chat of its own may be quiet");
  assert.equal(noticeSignal(p, { tag: `c:c:${ROOM}`, kind: "chats" }), "hop");
  assert.equal(noticeSignal(p, { tag: "c:", kind: "chats" }), "hop");
  assert.equal(noticeSignal(p, { tag: `n:${BOB}`, kind: "nodes" }), "sonar");
});

test("the Sound row names one sound only while every notice rings with it", () => {
  assert.equal(oneSignal(DEFAULT_PREFS), "chirp");
  assert.equal(oneSignal(prefs({ chatSound: { "ch:0": "chirp" } })), "chirp");
  assert.equal(oneSignal(prefs({ chatSound: { "ch:0": "roger" } })), null);
  assert.equal(oneSignal(prefs({ sounds: { direct: "hop", chats: "chirp", nodes: "chirp" } })), null);
});

test("each kind rings with its own sound, and with each other one its chats have, once", () => {
  const p = prefs({
    sounds: { direct: "chirp", chats: "hop", nodes: "sonar" },
    chatSound: { "ch:0": "roger", "ch:1": "roger", "ch:2": "hop", [`c:${ROOM}`]: "none", [`c:${BOB}`]: "roger" },
  });
  assert.deepEqual(kindSounds(p, state), [
    { kind: "direct", signal: "chirp", own: true },
    { kind: "chats", signal: "hop", own: true },
    { kind: "nodes", signal: "sonar", own: true },
    { kind: "chats", signal: "roger", own: false },
    { kind: "chats", signal: "none", own: false },
    { kind: "direct", signal: "roger", own: false },
  ]);
});
