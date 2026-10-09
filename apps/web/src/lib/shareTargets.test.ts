import { test } from "node:test";
import assert from "node:assert/strict";
import { AdvType, type ChannelRecord, type ContactRecord, type MessageRecord } from "@meshnet/meshcore";
import type { ConversationSummary } from "./conversations.js";
import { shareTargets } from "./shareTargets.js";

const channel = (index: number, name: string): ConversationSummary => ({
  id: `ch:${index}`,
  kind: "channel",
  title: name,
  preview: null,
  lastAt: 0,
  unread: 0,
  contact: null,
  channel: { index, name, secret: "" } as ChannelRecord,
});

const person = (key: string, type: number = AdvType.Chat): ConversationSummary => ({
  id: `c:${key}`,
  kind: "contact",
  title: key,
  preview: null,
  lastAt: 0,
  unread: 0,
  contact: { key, type, name: key } as ContactRecord,
  channel: null,
});

const sent = (conversation: string, at: number): MessageRecord => ({ conversation, direction: "out", receivedAt: at, timestamp: at / 1000 }) as MessageRecord;
const heard = (conversation: string, at: number): MessageRecord => ({ conversation, direction: "in", receivedAt: at, timestamp: at / 1000 }) as MessageRecord;

test("pinned chats first, the latest pinned first, then the ones last written in", () => {
  const rows = [channel(0, "Public"), channel(1, "Friends"), person("alice"), person("bob")];
  const pins = { "ch:0": { at: 1, name: "Public" }, "ch:1": { at: 2, name: "Friends" } };
  const messages = [sent("c:alice", 1000), sent("c:bob", 2000)];
  assert.deepEqual(
    shareTargets(rows, pins, messages).map((r) => r.id),
    ["ch:1", "ch:0", "c:bob", "c:alice"],
  );
});

test("a chat only read in is not offered", () => {
  const rows = [person("alice"), person("bob")];
  assert.deepEqual(
    shareTargets(rows, {}, [heard("c:alice", 5000), sent("c:bob", 1000)]).map((r) => r.id),
    ["c:bob"],
  );
});

test("no more than four, and none that cannot take a message", () => {
  const rows = [person("a"), person("b"), person("c"), person("d"), person("e"), person("tower", AdvType.Repeater), { ...channel(9, "Gone"), channel: null }];
  const messages = ["a", "b", "c", "d", "e", "tower"].map((k, i) => sent(`c:${k}`, i * 1000)).concat(sent("ch:9", 9000));
  assert.deepEqual(
    shareTargets(rows, {}, messages).map((r) => r.id),
    ["c:e", "c:d", "c:c", "c:b"],
  );
});
