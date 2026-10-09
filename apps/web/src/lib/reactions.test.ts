import assert from "node:assert/strict";
import { test } from "node:test";
import { groupReactions, ownReaction } from "./reactions.js";

test("reactions gather by emoji in the order they came, ours marked", () => {
  const reactions = [
    { emoji: "👍", by: "Bob", at: 1 },
    { emoji: "😂", by: "Carol", at: 2 },
    { emoji: "👍", by: null, at: 3 },
    { emoji: "👍", by: "Dan", at: 4 },
  ];
  assert.deepEqual(groupReactions(reactions), [
    { emoji: "👍", count: 3, mine: true, names: ["Bob", "Dan"] },
    { emoji: "😂", count: 1, mine: false, names: ["Carol"] },
  ]);
  assert.equal(ownReaction(reactions), "👍");
  assert.equal(ownReaction(reactions.filter((r) => r.by !== null)), null);
  assert.deepEqual(groupReactions(undefined), []);
});
