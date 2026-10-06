import { test } from "node:test";
import assert from "node:assert/strict";
import { switchable } from "./recentChats.js";

const listed = ["ch:0", "c:alice", "c:bob", "ch:2", "c:room"];

test("the chat on screen, then the ones seen before it, then the list", () => {
  assert.deepEqual(switchable("c:bob", listed, 5, ["c:bob", "ch:2", "c:alice"]), ["c:bob", "ch:2", "c:alice", "ch:0", "c:room"]);
});

test("with no chat open, the latest seen comes first", () => {
  assert.deepEqual(switchable(null, listed, 3, ["c:room"]), ["c:room", "ch:0", "c:alice"]);
});

test("a chat no longer in the list drops out", () => {
  assert.deepEqual(switchable("ch:0", listed, 3, ["ch:0", "c:gone", "c:bob"]), ["ch:0", "c:bob", "c:alice"]);
});

test("never more than asked for, nor one twice", () => {
  assert.deepEqual(switchable("ch:0", listed, 2, ["ch:0", "ch:0", "ch:0"]), ["ch:0", "c:alice"]);
});
