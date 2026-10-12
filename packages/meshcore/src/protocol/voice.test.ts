import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex, utf8 } from "./bytes.js";
import { decodeVoice, encodeVoiceAnnounce, encodeVoicePart, splitVoiceText, VOICE_DATAGRAM_MAX, VOICE_PART_TEXT_MAX, VoiceCodec, VoiceGender } from "./voice.js";

test("an announce goes out as kind, speaker, voice, packings, card and name, and reads back", () => {
  const data = encodeVoiceAnnounce({ speaker: "a1b2c3d4", gender: VoiceGender.Male, codecs: 1 << VoiceCodec.ZstdRuV1, card: null, name: "Борис" });
  assert.equal(toHex(data.subarray(0, 11)), "01a1b2c3d4020200000000");
  assert.deepEqual(decodeVoice(data), { kind: "announce", speaker: "a1b2c3d4", gender: VoiceGender.Male, codecs: 2, card: null, name: "Борис" });
  const carded = encodeVoiceAnnounce({ speaker: "a1b2c3d4", gender: VoiceGender.Any, codecs: 2, card: "0badf00d", name: "B" });
  const read = decodeVoice(carded);
  assert.equal(read?.kind === "announce" ? read.card : null, "0badf00d");
});

test("a part carries its place, packing, try and length before the text", () => {
  const text = utf8("packed");
  const data = encodeVoicePart({ speaker: "a1b2c3d4", message: 0x1234, index: 1, count: 3, codec: VoiceCodec.ZstdRuV1, attempt: 2, seconds: 7.3, data: text });
  assert.equal(toHex(data.subarray(0, 10)), "02a1b2c3d434121212" + "1d");
  assert.deepEqual(decodeVoice(data), { kind: "part", speaker: "a1b2c3d4", message: 0x1234, index: 1, count: 3, codec: 1, attempt: 2, seconds: 7.25, data: text });
});

test("a part's text fits a datagram whose copy a repeater can be heard sending", () => {
  const full = encodeVoicePart({ speaker: "00000000", message: 1, index: 0, count: 1, codec: 1, attempt: 0, seconds: 10, data: new Uint8Array(VOICE_PART_TEXT_MAX) });
  assert.equal(full.length, VOICE_DATAGRAM_MAX);
  assert.throws(() => encodeVoicePart({ speaker: "00000000", message: 1, index: 0, count: 1, codec: 1, attempt: 0, seconds: 10, data: new Uint8Array(VOICE_PART_TEXT_MAX + 1) }));
  assert.throws(() => encodeVoicePart({ speaker: "00000000", message: 1, index: 2, count: 2, codec: 1, attempt: 0, seconds: 1, data: new Uint8Array(1) }));
});

test("anything else under the shared testing type is not taken for voice", () => {
  assert.equal(decodeVoice(new Uint8Array([3, 1, 2, 3, 4])), null, "another kind");
  assert.equal(decodeVoice(new Uint8Array([2, 1, 2, 3, 4, 0, 0, 0x00, 0x10, 4])), null, "a part without text");
  assert.equal(decodeVoice(new Uint8Array([2, 1, 2, 3, 4, 0, 0, 0x21, 0x10, 4, 9])), null, "a place past the count");
  assert.equal(decodeVoice(new Uint8Array([1, 1, 2, 3, 4, 9, 2, 0, 0, 0, 0, 0x41])), null, "a voice not known");
  assert.equal(decodeVoice(new Uint8Array([1, 1, 2, 3, 4, 1, 2, 0, 0, 0, 0, 0xff])), null, "a name that is not UTF-8");
  assert.equal(decodeVoice(new Uint8Array([1, 1, 2, 3, 4, 1, 2, 0, 0, 0, 0])), null, "nobody's");
});

/** A stand-in for the dictionary: one byte a letter, so a part holds 147 letters. */
const packByLetters = async (text: string) => new Uint8Array([...text].length);

test("text is cut at spaces into parts that each fit", async () => {
  const words = Array.from({ length: 60 }, (_, i) => `слово${i}`);
  const parts = await splitVoiceText(words.join(" "), packByLetters);
  assert.ok(parts && parts.length > 1);
  for (const part of parts!) assert.ok(part.data.length <= VOICE_PART_TEXT_MAX);
  assert.equal(parts!.map((p) => p.text).join(" "), words.join(" "), "nothing lost, nothing added, cut only between words");
  assert.deepEqual(await splitVoiceText("  Буду у вышки  ", packByLetters).then((p) => p?.map((x) => x.text)), ["Буду у вышки"]);
});

test("a word too long for a part is cut by letters; too much text gives up", async () => {
  const long = "а".repeat(400);
  const parts = await splitVoiceText(long, packByLetters);
  assert.ok(parts && parts.length >= 3);
  assert.equal(parts!.map((p) => p.text).join(""), long);
  assert.equal(await splitVoiceText("я ".repeat(1500), packByLetters), null);
});
