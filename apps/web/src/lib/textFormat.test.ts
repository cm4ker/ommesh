import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAround, formatKey, formatRuns, parseFormat, plainText, toggleFormat, type FormatNode } from "./textFormat.js";

/** A parse written short: text as is, formatting as `kind(…)`. */
function shape(nodes: FormatNode[]): string {
  return nodes.map((n) => (n.kind === "text" ? n.text : `${n.kind}(${shape(n.children)})`)).join("");
}

const parsed = (text: string) => shape(parseFormat(text));

test("doubled markers format the text between them", () => {
  assert.equal(parsed("**жирный**"), "bold(жирный)");
  assert.equal(parsed("с утра __тишина__."), "с утра italic(тишина).");
  assert.equal(parsed("~~Еду~~ Отменяется"), "strike(Еду) Отменяется");
  assert.equal(parsed("SNR `-7.5`, два хопа"), "SNR code(-7.5), два хопа");
  assert.equal(parsed("Пароль: ||сосна42||"), "Пароль: spoiler(сосна42)");
});

test("markers nest, and nothing is formatted inside mono text", () => {
  assert.equal(parsed("**жирный __и курсив__**"), "bold(жирный italic(и курсив))");
  assert.equal(parsed("`**как есть**`"), "code(**как есть**)");
});

test("a block holds its lines as typed", () => {
  assert.equal(parsed("Сделал так:\n```\nset tx 22\nset af 2\n```"), "Сделал так:\nblock(\nset tx 22\nset af 2\n)");
  assert.equal(parsed("```\n\n```"), "```\n\n```");
});

test("a formula holds its TeX as typed, spaces and all, but prices stay text", () => {
  assert.equal(parsed("Энергия $$E=mc^2$$, ясно"), "Энергия math(E=mc^2), ясно");
  assert.equal(parsed("$$ \\frac{a}{**b**} $$"), "math( \\frac{a}{**b**} )");
  assert.equal(parsed("Итог:\n$$\n\\sum_{i=1}^n i\n$$"), "Итог:\nmath(\n\\sum_{i=1}^n i\n)");
  assert.equal(parsed("**$$x$$**"), "bold(math(x))");
  for (const text of ["$5 и $10", "Кафе $$$, бар $$", "$$ $$", "$$$x$$$"]) assert.equal(parsed(text), text, text);
  assert.equal(plainText("Энергия $$ E=mc^2 $$"), "Энергия E=mc^2");
});

test("single markers, spaces inside and markers without a partner stay as typed", () => {
  for (const text of ["*привет* всем _так_", "2*3*4 = 24, node_v2_final.txt ^_^", "** жирный **", "**без пары", "****", "`a\nb`"]) {
    assert.equal(parsed(text), text, text);
  }
});

test("addresses, places and mentions keep their markers", () => {
  assert.equal(parsed("https://site.ru/a__b__c"), "https://site.ru/a__b__c");
  assert.equal(parsed("@[Node__1__] привет"), "@[Node__1__] привет");
  assert.equal(parsed("**https://meshcore.io**"), "bold(https://meshcore.io)");
  assert.equal(parsed("и **https://meshcore.io**, пароль"), "и bold(https://meshcore.io), пароль");
  assert.equal(parsed("(**https://meshcore.io**)."), "(bold(https://meshcore.io)).");
  assert.equal(parsed("`https://meshcore.io`"), "code(https://meshcore.io)");
});

test("plain text leaves the markers out and hides what is hidden", () => {
  assert.equal(plainText("Кто слышит репитер на **Лысой горе**?"), "Кто слышит репитер на Лысой горе?");
  assert.equal(plainText("Пароль: ||сосна42||"), "Пароль: ▒▒▒");
  assert.equal(plainText("Так:\n```\nset tx 22\n```"), "Так:\nset tx 22");
  assert.equal(plainText("2*3*4"), "2*3*4");
});

test("runs cover the typed text end to end, markers apart", () => {
  const text = "x **b `c`**";
  const runs = formatRuns(text);
  assert.equal(runs.map((r) => text.slice(r.start, r.end)).join(""), text);
  assert.deepEqual(
    runs.map((r) => [text.slice(r.start, r.end), r.marker, r.kinds.join("+")]),
    [
      ["x ", false, ""],
      ["**", true, ""],
      ["b ", false, "bold"],
      ["`", true, "bold"],
      ["c", false, "bold+code"],
      ["`", true, "bold"],
      ["**", true, ""],
    ],
  );
  assert.deepEqual(formatRuns("просто текст"), [{ start: 0, end: 12, marker: false, kinds: [] }]);
});

test("a selection goes into markers, and comes out of them again", () => {
  const text = "Встречаемся у вышки в 18:00";
  const start = text.indexOf("в 18");
  const on = toggleFormat(text, start, text.length, "bold")!;
  assert.deepEqual(on, { text: "Встречаемся у вышки **в 18:00**", start: start + 2, end: text.length + 2 });
  assert.equal(formatAround(on.text, on.start, on.end, "bold"), true);
  assert.deepEqual(toggleFormat(on.text, on.start, on.end, "bold"), { text, start, end: text.length });
  // Selected with the markers, they come off too.
  assert.deepEqual(toggleFormat(on.text, on.start - 2, on.end + 2, "bold"), { text, start: start, end: text.length });
});

test("spaces at a selection's edges stay outside, and mono over lines is a block", () => {
  assert.deepEqual(toggleFormat("a слово b", 1, 8, "italic"), { text: "a __слово__ b", start: 4, end: 9 });
  assert.equal(toggleFormat("a   b", 1, 4, "bold"), null);
  assert.equal(toggleFormat("abc", 1, 1, "bold"), null);
  assert.deepEqual(toggleFormat("set tx 22\nset af 2", 0, 18, "code"), { text: "```\nset tx 22\nset af 2\n```", start: 4, end: 22 });
  assert.deepEqual(toggleFormat("SNR -7.5", 4, 8, "code"), { text: "SNR `-7.5`", start: 5, end: 9 });
});

test("keys follow Telegram Desktop, by the key's place on any layout", () => {
  const key = (code: string, shiftKey = false, ctrlKey = true) => formatKey({ key: "", code, ctrlKey, metaKey: false, shiftKey, altKey: false });
  assert.equal(key("KeyB"), "bold");
  assert.equal(key("KeyI"), "italic");
  assert.equal(key("KeyX", true), "strike");
  assert.equal(key("KeyM", true), "code");
  assert.equal(key("KeyP", true), "spoiler");
  assert.equal(key("KeyX"), null);
  assert.equal(key("KeyB", false, false), null);
});
