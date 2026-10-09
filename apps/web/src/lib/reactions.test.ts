import assert from "node:assert/strict";
import { test } from "node:test";
import { EMOJI_GROUPS, groupReactions, noteReaction, ownReaction, stripReactions } from "./reactions.js";

test("the strip leads with the emoji chosen lately and fills up with the first few", () => {
  assert.deepEqual(stripReactions([]), ["👍", "❤️", "😂", "😮", "😢", "🙏"]);
  assert.deepEqual(stripReactions(["📡", "❤️"]), ["📡", "❤️", "👍", "😂", "😮", "😢"]);
  noteReaction("🔥");
  noteReaction("📡");
  noteReaction("🔥");
  assert.deepEqual(stripReactions(), ["🔥", "📡", "👍", "❤️", "😂", "😮"]);
});

test("every emoji to choose from is one emoji, and none is offered twice in a group", () => {
  for (const group of EMOJI_GROUPS) {
    assert.equal(new Set(group.items).size, group.items.length, group.id);
    for (const emoji of group.items) assert.equal([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(emoji)].length, 1, emoji);
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
