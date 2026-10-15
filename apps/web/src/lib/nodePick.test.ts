import assert from "node:assert/strict";
import { test } from "node:test";
import { endNodePick, extendNodePick, nodePick, pickedShown, startNodePick, toggleAllNodes, toggledAll, toggleNodePick } from "./nodePick.js";

test("a node picked starts the picking, and the last one let go ends it", () => {
  startNodePick("a");
  toggleNodePick("b");
  assert.deepEqual(nodePick()?.keys, ["a", "b"]);
  toggleNodePick("a");
  toggleNodePick("b");
  assert.equal(nodePick(), null);
});

test("Shift and a click adds the stretch from the node picked last", () => {
  startNodePick("b");
  extendNodePick(["a", "b", "c", "d", "e"], "d");
  assert.deepEqual(nodePick()?.keys, ["b", "c", "d"]);
  extendNodePick(["a", "b", "c", "d", "e"], "a");
  assert.deepEqual(nodePick()?.keys, ["b", "c", "d", "a"]);
  endNodePick();
});

test("only the picked nodes the list shows count, in its order", () => {
  assert.deepEqual(pickedShown(["c", "x", "a"], ["a", "b", "c"]), ["a", "c"]);
});

test("All picks every node shown, and with all picked lets go of just those", () => {
  assert.deepEqual(toggledAll(["a", "b"], ["x", "a"]), ["x", "a", "b"]);
  assert.deepEqual(toggledAll(["a", "b"], ["x", "a", "b"]), ["x"]);
  assert.deepEqual(toggledAll([], ["x"]), ["x"]);
  startNodePick("a");
  toggleAllNodes(["a"]);
  assert.equal(nodePick(), null);
});
