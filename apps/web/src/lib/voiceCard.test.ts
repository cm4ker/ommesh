import assert from "node:assert/strict";
import { test } from "node:test";
import { cardFileName, cardPrint, decodeCard, encodeCard } from "./voiceCard.js";

const info = { name: "Борис", speaker: "a1b2c3d4", text: "Мы стоим на высоком берегу." };

test("a card is a WAV that carries whose voice it is, and reads back", () => {
  const pcm = Float32Array.from({ length: 2400 }, (_, i) => Math.sin(i / 10) * 0.5);
  const bytes = encodeCard(pcm, 24_000, info);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...bytes.subarray(8, 12)), "WAVE");
  const card = decodeCard(bytes)!;
  assert.equal(card.name, "Борис");
  assert.equal(card.speaker, "a1b2c3d4");
  assert.equal(card.text, info.text);
  assert.equal(card.sampleRate, 24_000);
  assert.equal(card.pcm.length, pcm.length);
  assert.ok(Math.abs(card.pcm[100]! - pcm[100]!) < 1e-4);
  assert.match(card.print, /^[0-9a-f]{8}$/);
  // The print is the same however the card got here, and another voice has another one.
  assert.equal(decodeCard(encodeCard(pcm, 24_000, { ...info, name: "Other" }))!.print, card.print);
  assert.notEqual(decodeCard(encodeCard(pcm.map((s) => s * 0.9), 24_000, info))!.print, card.print);
});

test("a plain WAV, or a file that is no WAV at all, is not a card", () => {
  const bytes = encodeCard(new Float32Array(10), 24_000, info);
  // The same file with its own chunk renamed: a WAV, but nobody's card.
  const plain = bytes.slice();
  plain.set([0x6a, 0x75, 0x6e, 0x6b], 36);
  assert.equal(decodeCard(plain), null);
  assert.equal(decodeCard(new TextEncoder().encode("{}")), null);
});

test("the print is four bytes of SHA-256 over the samples", () => {
  assert.equal(cardPrint(new Uint8Array(0)), "e3b0c442");
});

test("a card's file says whose voice it is, without characters a file name cannot hold", () => {
  assert.equal(cardFileName({ ...info, name: 'Бо/рис:"' }), "ommesh-voice-Борис-a1b2c3d4.wav");
});
