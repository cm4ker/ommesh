import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConversationSummary } from "./conversations.js";
import { nextUnread } from "./nextChat.js";

function row(id: string, unread: number): ConversationSummary {
  return { id, kind: "channel", title: id, preview: null, lastAt: 0, unread, contact: null, channel: null };
}

const loud = () => false;

test("the first unread down the list, whichever side of this one it is", () => {
  const rows = [row("ch:0", 3), row("ch:1", 0), row("ch:2", 5)];
  assert.equal(nextUnread(rows, "ch:1", loud)?.id, "ch:0");
  assert.equal(nextUnread(rows, "ch:0", loud)?.id, "ch:2");
});

test("never this chat, even with messages still unread in it", () => {
  assert.equal(nextUnread([row("ch:0", 2)], "ch:0", loud), null);
});

test("the chats kept quiet are passed over", () => {
  const rows = [row("ch:0", 40), row("c:lena", 1)];
  assert.equal(nextUnread(rows, "ch:3", (id) => id === "ch:0")?.id, "c:lena");
});

test("none when everything is read", () => {
  assert.equal(nextUnread([row("ch:0", 0), row("ch:1", 0)], "ch:0", loud), null);
});
