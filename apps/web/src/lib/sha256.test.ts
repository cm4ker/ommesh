import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256 } from "./sha256.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

test("SHA-256 matches Node's across block edges and multi-byte letters", () => {
  // 55 bytes fill one block with the length, 56 spill into a second, 64 and 119 cross further.
  const texts = ["", "abc", "#test", "#москва", "a".repeat(55), "a".repeat(56), "a".repeat(64), "b".repeat(119), "🙂".repeat(40)];
  for (const text of texts) {
    const bytes = new TextEncoder().encode(text);
    assert.equal(hex(sha256(bytes)), createHash("sha256").update(bytes).digest("hex"), JSON.stringify(text));
  }
});
