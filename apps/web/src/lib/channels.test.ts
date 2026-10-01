import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { channelAccess, hashtagName, hashtagSecret } from "./channels.js";

const halfSha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);

test("a public channel's name keeps one leading # and folds case and spaces", () => {
  assert.equal(hashtagName("Berlin"), "#berlin");
  assert.equal(hashtagName("  ##Test "), "#test");
  assert.equal(hashtagName("#Москва"), "#москва");
  assert.equal(hashtagName("#"), null);
});

test("a public channel's key is the first half of SHA-256 of its name, # included", () => {
  assert.equal(hashtagSecret("#test"), halfSha("#test"));
  assert.equal(hashtagSecret("#москва"), halfSha("#москва"));
});

test("Public and a channel keyed by its name are public; a made-up key is private", () => {
  assert.equal(channelAccess({ name: "Public", secret: "8b3387e9c5cdea6ac9e5edbaa115cd72" }), "public");
  assert.equal(channelAccess({ name: "#test", secret: halfSha("#test") }), "public");
  assert.equal(channelAccess({ name: "Friends", secret: "0123456789abcdef0123456789abcdef" }), "private");
  // A "#" in the name alone does not make a channel public: its key decides.
  assert.equal(channelAccess({ name: "#test", secret: "0123456789abcdef0123456789abcdef" }), "private");
});

test("a channel keyed by its name stays public after a rename that drops the # or keeps another app's case", () => {
  assert.equal(channelAccess({ name: "Test", secret: halfSha("#test") }), "public");
  assert.equal(channelAccess({ name: "#Berlin", secret: halfSha("#Berlin") }), "public");
  assert.equal(channelAccess({ name: "#Berlin", secret: halfSha("#berlin").toUpperCase() }), "public");
});

test("a channel the radio no longer lists is shown as public", () => {
  assert.equal(channelAccess(undefined), "public");
});
