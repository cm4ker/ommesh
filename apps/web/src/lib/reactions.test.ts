import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseEmojiData, type RawEmoji } from "./emojiData.js";
import { groupReactions, MOODS, noteReaction, ownReaction, RADIO_REACTIONS, reactors, stripReactions, TOP_REACTIONS } from "./reactions.js";

test("who put what on a message lists ours first, then the others as they came", () => {
  const reactions = [
    { emoji: "👍", by: "Alice", at: 1 },
    { emoji: "❤️", by: null, at: 2 },
    { emoji: "👍", by: "Kolya", at: 3 },
  ];
  assert.deepEqual(reactors(reactions), [
    { emoji: "❤️", name: null },
    { emoji: "👍", name: "Alice" },
    { emoji: "👍", name: "Kolya" },
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
    { emoji: "👍", count: 3, mine: true, unheard: false, names: ["Bob", "Dan"] },
    { emoji: "😂", count: 1, mine: false, unheard: false, names: ["Carol"] },
  ]);
  assert.equal(groupReactions([{ emoji: "🔥", by: null, at: 1, unheard: true }])[0]?.unheard, true);
  assert.equal(ownReaction(reactions), "👍");
  assert.equal(ownReaction(reactions.filter((r) => r.by !== null)), null);
  assert.deepEqual(groupReactions(undefined), []);
});
