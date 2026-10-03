import { test } from "node:test";
import assert from "node:assert/strict";
import { chatComparator, chatGroups, chatsInOrder, type ChatOrder } from "./chatOrder.js";
import type { RadioPins } from "./chatPins.js";
import type { ConversationSummary } from "./conversations.js";

function channel(index: number, title: string, lastAt: number, unread = 0): ConversationSummary {
  return { id: `ch:${index}`, kind: "channel", title, preview: null, lastAt, unread, contact: null, channel: { index, name: title, secret: "00" } };
}

function direct(title: string, lastAt: number, unread = 0): ConversationSummary {
  return { id: `c:${title}`, kind: "contact", title, preview: null, lastAt, unread, contact: null, channel: null };
}

const pub = channel(0, "Public", 900, 14);
const omsk = channel(2, "#omsk", 800);
const work = channel(3, "Work", 0);
const hunters = channel(1, "Hunters", 0);
const lena = direct("Lena", 950, 1);
const bob = direct("bob", 700);
const all = [work, bob, pub, hunters, lena, omsk];

const titles = (rows: ConversationSummary[]) => rows.map((r) => r.title);
const sorted = (order: ChatOrder) => titles([...all].sort(chatComparator(order)));

test("latest puts the newest first and silent channels last, by slot", () => {
  assert.deepEqual(sorted("latest"), ["Lena", "Public", "#omsk", "bob", "Hunters", "Work"]);
});

test("name goes by the alphabet, a channel's # aside and case aside", () => {
  assert.deepEqual(sorted("name"), ["bob", "Hunters", "Lena", "#omsk", "Public", "Work"]);
});

test("unread first, then the newest", () => {
  assert.deepEqual(titles([direct("a", 100, 2), direct("b", 900), direct("c", 50, 1)].sort(chatComparator("unread"))), ["a", "c", "b"]);
});

test("one list unless channels go first", () => {
  const groups = chatGroups(all, { order: "latest", channelsFirst: false });
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.title, "");
});

test("channels first: channels, then direct chats, each in the order", () => {
  const groups = chatGroups(all, { order: "name", channelsFirst: true });
  assert.deepEqual(
    groups.map((g) => [g.title, titles(g.rows)]),
    [
      ["Channels", ["Hunters", "#omsk", "Public", "Work"]],
      ["Direct", ["bob", "Lena"]],
    ],
  );
  assert.deepEqual(titles(chatsInOrder(all, { order: "name", channelsFirst: true })), ["Hunters", "#omsk", "Public", "Work", "bob", "Lena"]);
});

test("a lone group goes without a title", () => {
  const groups = chatGroups([pub, omsk], { order: "latest", channelsFirst: true });
  assert.deepEqual(groups.map((g) => g.title), [""]);
});

test("the rows passed in are left as they were", () => {
  const rows = [...all];
  chatGroups(rows, { order: "name", channelsFirst: true });
  assert.deepEqual(rows, all);
});

// Lena pinned last, so she stands above Work, pinned first; neither moves for newer messages.
const pins: RadioPins = { "ch:3": { at: 10, name: "Work" }, "c:Lena": { at: 20 } };

test("pinned chats come first, the latest pinned on top, in one untitled block", () => {
  const groups = chatGroups(all, { order: "latest", channelsFirst: false }, pins);
  assert.deepEqual(
    groups.map((g) => [g.id, g.title, titles(g.rows)]),
    [
      ["pinned", "", ["Lena", "Work"]],
      ["all", "", ["Public", "#omsk", "bob", "Hunters"]],
    ],
  );
});

test("pinned chats keep their place whatever the order", () => {
  assert.deepEqual(titles(chatsInOrder(all, { order: "name", channelsFirst: false }, pins)), ["Lena", "Work", "bob", "Hunters", "#omsk", "Public"]);
  assert.deepEqual(titles(chatsInOrder(all, { order: "unread", channelsFirst: false }, pins)).slice(0, 2), ["Lena", "Work"]);
});

test("with channels first, the pinned stand above both groups under a title of their own", () => {
  const groups = chatGroups(all, { order: "latest", channelsFirst: true }, pins);
  assert.deepEqual(
    groups.map((g) => [g.title, titles(g.rows)]),
    [
      ["Pinned", ["Lena", "Work"]],
      ["Channels", ["Public", "#omsk", "Hunters"]],
      ["Direct", ["bob"]],
    ],
  );
});

test("a channel's pin does not pass to another channel written into its slot", () => {
  const other = channel(3, "Hunting club", 0);
  assert.deepEqual(chatGroups([other, bob], { order: "latest", channelsFirst: false }, pins).map((g) => g.id), ["all"]);
});

test("everything pinned is one untitled group", () => {
  const groups = chatGroups([lena, work], { order: "latest", channelsFirst: true }, pins);
  assert.deepEqual(groups.map((g) => [g.title, titles(g.rows)]), [["", ["Lena", "Work"]]]);
});
