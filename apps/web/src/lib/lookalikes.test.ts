import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_SETS, asCyrillic, packLookalikes } from "./lookalikes.js";
import { utf8Length } from "./format.js";

const exact = { on: true, near: false, cursive: false };

test("Cyrillic letters with an exact Latin twin go out as the twin, and nothing else changes", () => {
  const text = "Кто слышит из Озерков? Антенна 5 дБи, Tesla и к/т/п";
  const packed = packLookalikes(text, exact);
  assert.equal(packed, "Kтo cлышит из Oзepкoв? Aнтeннa 5 дБи, Tesla и к/т/п");
  assert.equal(utf8Length(text) - utf8Length(packed), 10);
});

test("the nearly alike letters and the handwritten ones go only when asked, and nothing when switched off", () => {
  assert.equal(packLookalikes("Утро у реки", exact), "Утpo у peки");
  assert.equal(packLookalikes("Утро у реки, ёж и ДРУЗЬЯ Зины", { on: true, near: true, cursive: false }), "Yтpo y peки, eж и ДPY3bЯ 3ины");
  assert.equal(packLookalikes("три пути", { on: true, near: false, cursive: true }), "mpu nуmu");
  assert.equal(packLookalikes("Утро у реки", { on: false, near: true, cursive: true }), "Утро у реки");
});

test("a mention keeps its letters", () => {
  assert.equal(packLookalikes("@[Петя] привет, @[Сергей Т]", ALL_SETS), "@[Петя] npuвem, @[Сергей Т]");
});

test("Latin twins among Cyrillic letters are read back as Cyrillic, letter for letter", () => {
  const sent = "3uмa блuзкo, нa nepeвaлe мuнyc дecяmь";
  const read = asCyrillic(sent);
  assert.equal(read, "Зима близко, на перевале минус десять");
  assert.equal(read.length, sent.length);
});

test("what went out with every set reads as it was written, but for the dots over ё", () => {
  const text = "Пробовал антенну на крыше, слышу три ретранслятора, четвёртый пропал после дождя. Завтра поставлю повыше";
  assert.equal(asCyrillic(packLookalikes(text, ALL_SETS)), text.replace("ё", "е"));
  assert.equal(asCyrillic(packLookalikes("ВСЕМ ПРИВЕТ, ДРУЗЬЯ! ЗВЕЗДА и мы", ALL_SETS)), "ВСЕМ ПРИВЕТ, ДРУЗЬЯ! ЗВЕЗДА и мы");
});

test("a word in Latin twins alone is read back only beside a Cyrillic one", () => {
  assert.equal(asCyrillic("чepeз mpu дня"), "через три дня");
  assert.equal(asCyrillic("мы u no cemu"), "мы и по сети");
  assert.equal(asCyrillic("mpu cemu"), "mpu cemu");
  assert.equal(asCyrillic("Tesla, nRF и OK"), "Tesla, nRF и ОК");
  // Russian has no і: beside m, n or u it is an English word.
  assert.equal(asCyrillic("прошивка companion"), "прошивка companion");
});

test("a 3 is read as З only where a word could start with it", () => {
  assert.equal(asCyrillic("3дecь xoлoднo"), "Здесь холодно");
  assert.equal(asCyrillic("Ждите, 3aвmpa"), "Ждите, Завтра");
  assert.equal(asCyrillic("дo нeгo 3км, чepeз 3чaca"), "до него 3км, через 3часа");
  assert.equal(asCyrillic("3км дo нeгo"), "3км до него");
  assert.equal(asCyrillic("ток 3A, a 3ГБ"), "ток 3A, а 3ГБ");
  assert.equal(asCyrillic("3BE3ДA"), "ЗВЕЗДА");
});

test("mentions and addresses stay as they came", () => {
  assert.equal(asCyrillic("@[Kocтя] cмompu https://example.com/nomom"), "@[Kocтя] смотри https://example.com/nomom");
});
