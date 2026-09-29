import { test } from "node:test";
import assert from "node:assert/strict";
import { LINK, linkOf } from "./webLinks.js";

function links(text: string): (string | null)[] {
  return [...text.matchAll(LINK)].map((m) => linkOf(m[0])?.href ?? null);
}

test("an address with its scheme or starting www. is a link, a bare domain or a version is not", () => {
  assert.deepEqual(links("карта https://analyzer.letsmesh.net/map и www.meshcore.io"), ["https://analyzer.letsmesh.net/map", "https://www.meshcore.io"]);
  assert.deepEqual(links("прошивка v1.17.1 с meshcore.io"), []);
  assert.deepEqual(links("http://10.0.0.1:5000/?a=1&b=2#x"), ["http://10.0.0.1:5000/?a=1&b=2#x"]);
});

test("a capital first letter, as a phone writes it, still makes a link", () => {
  assert.deepEqual(links("Www.site.ru"), ["https://Www.site.ru"]);
  assert.deepEqual(links("Https://site.ru"), ["Https://site.ru"]);
});

test("the punctuation of the sentence is left out, a bracket the address opened is kept", () => {
  assert.deepEqual(links("Смотри https://site.ru/page."), ["https://site.ru/page"]);
  assert.deepEqual(links("(см. https://site.ru/a)"), ["https://site.ru/a"]);
  assert.deepEqual(links("https://en.wikipedia.org/wiki/LoRa_(radio)!"), ["https://en.wikipedia.org/wiki/LoRa_(radio)"]);
  assert.deepEqual(links("«https://site.ru»"), ["https://site.ru"]);
});

test("the text of a link is what it matched, less the punctuation", () => {
  assert.deepEqual(linkOf("https://site.ru/a,"), { text: "https://site.ru/a", href: "https://site.ru/a" });
});

test("nothing past www. or the scheme is no link", () => {
  assert.deepEqual(links("www..."), [null]);
  assert.deepEqual(links("https://..."), [null]);
});
