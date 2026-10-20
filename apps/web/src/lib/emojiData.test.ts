import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { emojiName, parseEmojiData, searchEmoji, UNICODE_GROUPS, type RawEmoji } from "./emojiData.js";

const read = (lang: string) => parseEmojiData(JSON.parse(readFileSync(new URL(`../emoji/${lang}.json`, import.meta.url), "utf8")) as RawEmoji);
const ru = read("ru");
const en = read("en");

test("every language has the same emoji, each one emoji and in one group only", () => {
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  assert.deepEqual(
    ru.groups.map((g) => g.items.map((e) => e.emoji)),
    en.groups.map((g) => g.items.map((e) => e.emoji)),
  );
  assert.deepEqual(
    ru.groups.map((g) => g.id),
    [...UNICODE_GROUPS],
  );
  const all = ru.groups.flatMap((g) => g.items.map((e) => e.emoji));
  assert.equal(new Set(all).size, all.length);
  assert.ok(all.length > 1500);
  for (const emoji of all) assert.equal([...graphemes.segment(emoji)].length, 1, emoji);
});

test("flags, skin tones and emoji newer than Emoji 14 stay out", () => {
  const all = ru.groups.flatMap((g) => g.items.map((e) => e.emoji)).join("");
  // Regional letters make the flags; the five tones colour a hand or a face.
  assert.doesNotMatch(all, /[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]/u);
  // 🫨 (shaking face) and 🩷 (pink heart) came with Emoji 15.
  assert.ok(!ru.byEmoji.has("🫨") && !ru.byEmoji.has("🩷"));
  assert.ok(ru.byEmoji.has("🫠"));
});

test("an emoji is spelled as Unicode spells it, so another app's reaction matches it", () => {
  // No variation selector after an emoji drawn as one by default, one after a character drawn as text by default.
  assert.ok(ru.byEmoji.has("👍") && !ru.byEmoji.has("👍️"));
  assert.ok(ru.byEmoji.has("❤️") && !ru.byEmoji.has("❤"));
  assert.ok(ru.byEmoji.has("☺️") && ru.byEmoji.has("🛰️"));
});

test("a search finds emoji by the start of their name or their words, ё as е, names first", () => {
  const cats = searchEmoji(ru, "кот").map((e) => e.emoji);
  assert.ok(cats.includes("🐈") && cats.includes("😺") && cats.includes("🐈‍⬛"));
  assert.ok(searchEmoji(ru, "антен").some((e) => e.emoji === "📡"));
  assert.equal(searchEmoji(ru, "ОГОНЬ")[0]?.emoji, "🔥");
  assert.deepEqual(
    searchEmoji(ru, "черная кошка").map((e) => e.emoji),
    ["🐈‍⬛"],
  );
  assert.ok(searchEmoji(en, "fire").some((e) => e.emoji === "🔥"));
  assert.deepEqual(searchEmoji(ru, "  "), []);
  assert.deepEqual(searchEmoji(ru, "щщщщ"), []);
});

test("an emoji's name heads a line with a capital", () => {
  assert.equal(emojiName(ru, "🔥"), "Огонь");
  assert.equal(emojiName(en, "🔥"), "Fire");
  assert.equal(emojiName(ru, "x"), null);
  assert.equal(emojiName(null, "🔥"), null);
});
