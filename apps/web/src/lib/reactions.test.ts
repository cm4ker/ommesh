import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import type { MessageRecord, SessionState } from "@meshnet/meshcore";
import { parseEmojiData, type RawEmoji } from "./emojiData.js";
import {
  groupReactions,
  MOODS,
  noteReaction,
  ownReaction,
  RADIO_REACTIONS,
  reactors,
  stripReactions,
  TOP_REACTIONS,
  totalUnreadReactions,
  unreadEmojis,
  unreadReactedMessages,
  unreadReactionCount,
} from "./reactions.js";

test("who put what on a message lists ours first, then the others as they came", () => {
  const reactions = [
    { emoji: "👍", by: "Alice", at: 1 },
    { emoji: "❤️", by: null, at: 2, relays: 3 },
    { emoji: "👍", by: "Kolya", at: 3 },
  ];
  assert.deepEqual(reactors(reactions), [
    { emoji: "❤️", name: null, carried: 3 },
    { emoji: "👍", name: "Alice", carried: null },
    { emoji: "👍", name: "Kolya", carried: null },
  ]);
  assert.deepEqual(reactors(undefined), []);
});

test("the strip leads with the emoji chosen lately and fills up with the first few", () => {
  assert.deepEqual(stripReactions([]), ["👍", "❤️", "😂", "😮", "😢", "🙏"]);
  assert.deepEqual(stripReactions(["📡", "❤️"]), ["📡", "❤️", "👍", "😂", "😮", "😢"]);
  noteReaction("🔥");
  noteReaction("📡");
  noteReaction("🔥");
  assert.deepEqual(stripReactions(), ["🔥", "📡", "👍", "❤️", "😂", "😮"]);
});

test("the emoji picked by hand are spelled as Unicode spells them, so other apps match them", () => {
  const data = parseEmojiData(JSON.parse(readFileSync(new URL("../emoji/en.json", import.meta.url), "utf8")) as RawEmoji);
  for (const [id, items] of [["top", TOP_REACTIONS], ["radio", RADIO_REACTIONS], ...MOODS.map((m) => [m.id, m.items] as const)] as const) {
    assert.equal(new Set(items).size, items.length, id);
    for (const emoji of items) assert.ok(data.byEmoji.has(emoji), `${id}: ${emoji}`);
  }
});

test("reactions gather by emoji in the order they came, ours marked", () => {
  const reactions = [
    { emoji: "👍", by: "Bob", at: 1 },
    { emoji: "😂", by: "Carol", at: 2 },
    { emoji: "👍", by: null, at: 3 },
    { emoji: "👍", by: "Dan", at: 4 },
  ];
  assert.deepEqual(groupReactions(reactions), [
    { emoji: "👍", count: 3, mine: true, carried: null, names: ["Bob", "Dan"] },
    { emoji: "😂", count: 1, mine: false, carried: null, names: ["Carol"] },
  ]);
  // Ours on a channel: waiting for a repeater, sent on, or sent on by none.
  const ours = (r: { relays?: number; unheard?: boolean }) => groupReactions([{ emoji: "🔥", by: null, at: 1, ...r }])[0]?.carried;
  assert.equal(ours({ relays: 0 }), "waiting");
  assert.equal(ours({ relays: 2 }), 2);
  assert.equal(ours({ relays: 0, unheard: true }), "unheard");
  assert.equal(ours({ unheard: true }), "unheard");
  assert.equal(ownReaction(reactions), "👍");
  assert.equal(ownReaction(reactions.filter((r) => r.by !== null)), null);
  assert.deepEqual(groupReactions(undefined), []);
});

test("unread reactions are counted, ordered by latest reaction, and exclude blocked channel senders", () => {
  const msg = (id: string, conversation: string, reactions: MessageRecord["reactions"]): MessageRecord =>
    ({ id, conversation, direction: "out", reactions }) as MessageRecord;
  const hidden = (by: string | null) => by === "Spam";
  const a = msg("a", "ch:0", [
    { emoji: "👍", by: "Alice", at: 10, unread: true },
    { emoji: "🔥", by: "Spam", at: 50, unread: true },
  ]);
  const b = msg("b", "ch:0", [
    { emoji: "❤️", by: "Bob", at: 30, unread: true },
    { emoji: "❤️", by: "Carol", at: 40, unread: true },
    { emoji: "😂", by: "Dan", at: 5 },
  ]);
  const dm = msg("c", "c:bob", [{ emoji: "👍", by: "Spam", at: 60, unread: true }]);

  assert.equal(unreadReactionCount(a, hidden), 1);
  assert.equal(unreadReactionCount(b, hidden), 2);
  // Blocking by channel name never hides reactions in a direct chat.
  assert.equal(unreadReactionCount(dm, hidden), 1);
  assert.deepEqual(unreadEmojis(b, hidden), ["❤️"]);
  assert.deepEqual(unreadReactedMessages([a, b], hidden), { ids: ["b", "a"], count: 3 });
  assert.equal(totalUnreadReactions({ messages: [a, b, dm] } as SessionState, hidden), 4);
});
