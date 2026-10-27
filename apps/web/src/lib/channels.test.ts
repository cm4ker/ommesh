import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { MessageRecord } from "@meshnet/meshcore";
import { channelAccess, freeChannelIndex, hashtagName, hashtagSecret } from "./channels.js";

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

test("a new channel goes to its own old slot, else to one with no history left, else to the first free", () => {
  const yug = "07".repeat(16);
  const left = (conversation: string) => ({ conversation }) as MessageRecord;
  const state = {
    channels: [{ index: 0, name: "Public", secret: "8b3387e9c5cdea6ac9e5edbaa115cd72" }],
    device: { maxChannels: 4 } as never,
    chatKeys: { "ch:1": yug, "ch:2": "09".repeat(16) },
    messages: [left("ch:1"), left("ch:2")],
  };
  assert.equal(freeChannelIndex(state, yug.toUpperCase()), 1);
  assert.equal(freeChannelIndex(state, "0a".repeat(16)), 3);
  assert.equal(freeChannelIndex({ ...state, device: { maxChannels: 3 } as never }), 1);
  assert.equal(freeChannelIndex({ ...state, device: { maxChannels: 1 } as never }), -1);
});
