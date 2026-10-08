import { test } from "node:test";
import assert from "node:assert/strict";
import { copiedText, dragged, extended, idsBetween, toggled } from "./messagePick.js";

const order = ["a", "b", "c", "d", "e"];

test("a stretch runs between two messages whichever way it was drawn", () => {
  assert.deepEqual(idsBetween(order, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(idsBetween(order, "d", "b"), ["b", "c", "d"]);
  assert.deepEqual(idsBetween(order, "c", "c"), ["c"]);
  assert.deepEqual(idsBetween(order, "c", "gone"), []);
});

test("a click picks a message or lets it go, and the picked stay in the chat's order", () => {
  assert.deepEqual(toggled(order, [], "c"), ["c"]);
  assert.deepEqual(toggled(order, ["d"], "a"), ["a", "d"]);
  assert.deepEqual(toggled(order, ["a", "d"], "a"), ["d"]);
});

test("shift and a click add everything since the message picked last", () => {
  assert.deepEqual(extended(order, ["a"], "a", "c"), ["a", "b", "c"]);
  assert.deepEqual(extended(order, ["e"], "e", "c"), ["c", "d", "e"]);
});

test("a drag adds what it crosses, or lets it go when it began on a picked message", () => {
  assert.deepEqual(dragged(order, [], "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(dragged(order, ["e"], "c", "a"), ["a", "b", "c", "e"]);
  assert.deepEqual(dragged(order, ["a", "b", "c", "d"], "c", "d"), ["a", "b"]);
  assert.deepEqual(dragged(order, ["a", "b"], "b", "b"), ["a"]);
});

test("one message copies as its words, several each under who wrote it and when", () => {
  const head = (m: { name: string; text: string }) => `${m.name}, [19:5x]`;
  assert.equal(copiedText([{ name: "Anna", text: "hello" }], head), "hello");
  assert.equal(copiedText([{ name: "Anna", text: "hello" }, { name: "Node-21", text: "hi\nthere" }], head), "Anna, [19:5x]\nhello\n\nNode-21, [19:5x]\nhi\nthere");
});
