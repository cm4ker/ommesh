import assert from "node:assert/strict";
import { test } from "node:test";
import { speechOnly } from "./speechOnly.js";

test("what Whisper makes up for noise is taken out, and noise alone leaves nothing", () => {
  assert.equal(speechOnly("Редактор субтитров А.Семкин Корректор А.Егорова"), "");
  assert.equal(speechOnly("[музыка]"), "");
  assert.equal(speechOnly("(звук пива)"), "");
  assert.equal(speechOnly("Продолжение следует..."), "");
  assert.equal(speechOnly(" . "), "");
  assert.equal(speechOnly("Thank you for watching!"), "");
});

test("speech stays as it was said, with only the made-up part gone", () => {
  assert.equal(speechOnly("Можешь включить сериал «Теория большого взрыва»."), "Можешь включить сериал «Теория большого взрыва».");
  assert.equal(speechOnly("Буду у вышки через десять минут. Субтитры сделал DimaTorzok"), "Буду у вышки через десять минут.");
  assert.equal(speechOnly("[шум] Слышу тебя хорошо, приём."), "Слышу тебя хорошо, приём.");
  assert.equal(speechOnly("I'll be at the tower in ten minutes. Subtitles by the Amara.org community"), "I'll be at the tower in ten minutes.");
});
