import { test } from "node:test";
import assert from "node:assert/strict";
import { backgroundOf, sanitize } from "./chatBackground.js";

test("a chat shows its own picture, or everyone's", () => {
  const prefs = sanitize({
    background: "doodles",
    strength: 50,
    chat: { "c:ab": "planets", muted: "none" },
  });
  assert.equal(backgroundOf(prefs, "c:ab"), "planets");
  assert.equal(backgroundOf(prefs, "ch:1"), "doodles");
  assert.equal(backgroundOf(prefs, "muted"), "none");
  assert.equal(backgroundOf(prefs), "doodles");
});

test("whatever another version stored is set right", () => {
  assert.deepEqual(sanitize(null), {
    background: "none",
    strength: 100,
    scale: 100,
    chat: {},
  });
  assert.deepEqual(
    sanitize({
      background: "unknown",
      strength: 140,
      scale: 500,
      chat: { a: "botanical", b: "lace", c: 3, d: "constructor" },
    }),
    { background: "none", strength: 100, scale: 160, chat: { a: "botanical" } },
  );
  assert.equal(sanitize({ strength: -5 }).strength, 0);
  assert.equal(sanitize({ strength: 33.6 }).strength, 34);
  assert.equal(sanitize({ strength: Number.NaN }).strength, 100);
  assert.equal(sanitize({ scale: -5 }).scale, 80);
  assert.equal(sanitize({ scale: 121.6 }).scale, 122);
  assert.equal(sanitize({ scale: Infinity }).scale, 100);
  assert.equal(sanitize({ background: "constructor" }).background, "none");
});

test("old global and chat choices keep their overrides in the new collection", () => {
  const old = {
    callsigns: "expedition",
    network: "doodles",
    topo: "botanical",
    space: "planets",
    stitch: "damask",
    geometry: "blocks",
    ether: "science",
    aurora: "doodles",
  };
  for (const [before, after] of Object.entries(old)) {
    const prefs = sanitize({
      background: before,
      strength: 35,
      chat: { custom: before, plain: "none", other: "confetti" },
    });
    assert.equal(prefs.background, after);
    assert.deepEqual(prefs.chat, {
      custom: after,
      plain: "none",
      other: "confetti",
    });
    assert.equal(prefs.strength, 35);
    assert.equal(prefs.scale, 100);
    assert.deepEqual(sanitize(prefs), prefs);
  }
});
