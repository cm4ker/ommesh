import { test } from "node:test";
import assert from "node:assert/strict";
import { backgroundOf, sanitize } from "./chatBackground.js";

test("a chat shows its own picture, or everyone's", () => {
  const prefs = sanitize({ background: "network", strength: 50, chat: { "c:ab": "space" } });
  assert.equal(backgroundOf(prefs, "c:ab"), "space");
  assert.equal(backgroundOf(prefs, "ch:1"), "network");
  assert.equal(backgroundOf(prefs), "network");
});

test("whatever another version stored is set right", () => {
  assert.deepEqual(sanitize(null), { background: "none", strength: 50, chat: {} });
  assert.deepEqual(sanitize({ background: "damask", strength: 140, chat: { a: "topo", b: "lace", c: 3 } }), { background: "none", strength: 100, chat: { a: "topo" } });
  assert.equal(sanitize({ strength: -5 }).strength, 0);
  assert.equal(sanitize({ strength: 33.6 }).strength, 34);
  assert.equal(sanitize({ strength: Number.NaN }).strength, 50);
});
