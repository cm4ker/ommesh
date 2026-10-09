import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fromHex, toHex, utf8 } from "./bytes.js";
import { crockford, decodeReaction, encodeReaction, looksLikeEmoji, messageHash, parseTextReaction } from "./reaction.js";

test("a message's hash is MeshCore One's: SHA-256 over the text and the stamp, five bytes", async () => {
  assert.equal(toHex(await messageHash("Who hears the hill?", 1760000000)), "6c3f21d8d7");
  assert.equal(crockford(fromHex("6c3f21d8d7")), "dgzj3p6q");
  // Cyrillic is hashed as its UTF-8 bytes, checked against Node's own SHA-256.
  const stamp = Buffer.alloc(4);
  stamp.writeUInt32LE(1760000123);
  const expected = createHash("sha256").update(Buffer.concat([Buffer.from(utf8("Кто слышит гору?")), stamp])).digest().subarray(0, 5);
  assert.equal(toHex(await messageHash("Кто слышит гору?", 1760000123)), expected.toString("hex"));
});

test("a reaction goes out as kind, hash, emoji and name, and reads back", () => {
  const target = fromHex("6c3f21d8d7");
  const data = encodeReaction({ target, emoji: "👍", by: "Боб" });
  assert.equal(toHex(data), `01${"6c3f21d8d7"}04${toHex(utf8("👍"))}${toHex(utf8("Боб"))}`);
  assert.deepEqual(decodeReaction(data), { target, emoji: "👍", by: "Боб" });
  // Taken back: no emoji.
  assert.deepEqual(decodeReaction(encodeReaction({ target, emoji: "", by: "Bob" })), { target, emoji: "", by: "Bob" });
  // A family emoji is one emoji, however many code points it takes.
  assert.equal(decodeReaction(encodeReaction({ target, emoji: "👨‍👩‍👧", by: "Bob" }))?.emoji, "👨‍👩‍👧");
});

test("someone else's datagram under the testing type is not taken for a reaction", () => {
  const target = fromHex("6c3f21d8d7");
  const good = encodeReaction({ target, emoji: "👍", by: "Bob" });
  assert.equal(decodeReaction(new Uint8Array([2, ...good.subarray(1)])), null, "another kind");
  assert.equal(decodeReaction(good.subarray(0, 8)), null, "cut short");
  assert.equal(decodeReaction(new Uint8Array([1, 1, 2, 3, 4, 5, 2, 0x41, 0x42, 0x43])), null, "letters, not an emoji");
  assert.equal(decodeReaction(new Uint8Array([1, 1, 2, 3, 4, 5, 4, 0xf0, 0x9f, 0x91, 0x8d, 0xff])), null, "a name that is not UTF-8");
  assert.equal(decodeReaction(new Uint8Array([1, 1, 2, 3, 4, 5, 0])), null, "nobody's");
  assert.throws(() => encodeReaction({ target, emoji: "👍", by: "" }));
});

test("MeshCore One's text reactions are read, both orders, and plain messages are not", () => {
  const target = fromHex("6c3f21d8d7");
  assert.deepEqual(parseTextReaction("@[Alice]👍\ndgzj3p6q"), { emoji: "👍", to: "Alice", target });
  assert.deepEqual(parseTextReaction("👍@[Alice]\nDGZJ3P6Q"), { emoji: "👍", to: "Alice", target });
  assert.deepEqual(parseTextReaction("@[Bob (bike)]❤️\ndgzj3p6q"), { emoji: "❤️", to: "Bob (bike)", target });
  // Lookalike letters stand for the digits.
  assert.equal(crockford(fromHex("0000000001")), "00000001");
  assert.deepEqual(parseTextReaction("@[Alice]👍\nOoOOOOOl"), { emoji: "👍", to: "Alice", target: fromHex("0000000001") });
  assert.equal(parseTextReaction("@[Alice] ok\ndgzj3p6q"), null, "words, not an emoji");
  assert.equal(parseTextReaction("@[Alice]👍👍\ndgzj3p6q"), null, "two emoji");
  assert.equal(parseTextReaction("@[Alice]👍\nhello"), null, "no hash");
  assert.equal(parseTextReaction("@[Alice] >Кто слышит…\nСлышу"), null, "a reply");
  assert.equal(parseTextReaction("👍"), null);
});

test("one emoji passes, text and pairs do not", () => {
  for (const e of ["👍", "❤️", "😂", "🙏🏽", "1️⃣", "👨‍👩‍👧"]) assert.ok(looksLikeEmoji(e), e);
  for (const e of ["ok", "+", "👍👍", "", "a👍"]) assert.ok(!looksLikeEmoji(e), e);
});
