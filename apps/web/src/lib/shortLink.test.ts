import { test } from "node:test";
import assert from "node:assert/strict";
import { longestLink, withShortLink } from "./shortLink.js";

test("the longest address in a message is the one worth shortening", () => {
  const text = "Смотри https://example.com/short и ещё https://example.com/a-very-long-page?with=query&and=more и всё";
  const found = longestLink(text);
  assert.ok(found);
  assert.equal(found!.text, "https://example.com/a-very-long-page?with=query&and=more");
  assert.equal(found!.at, text.indexOf("https://example.com/a-very-long-page"));
});

test("the punctuation of the sentence stays outside the address", () => {
  const found = longestLink("Вот: https://example.com/page, потом что-то.");
  assert.ok(found);
  assert.equal(found!.text, "https://example.com/page");
  assert.equal(found!.href, "https://example.com/page");
});

test("a message with no address has nothing to shorten, and www. still counts", () => {
  assert.equal(longestLink("просто слова и 1.17.1"), null);
  assert.equal(longestLink(""), null);
  const www = longestLink("сайт www.example.com/a/long/path");
  assert.ok(www);
  assert.equal(www!.href, "https://www.example.com/a/long/path");
});

test("a short link takes the place of the long one, and the words around it stay", () => {
  const text = "Держи https://example.com/a-very-long-page?with=query и до встречи";
  const found = longestLink(text)!;
  assert.equal(withShortLink(text, found, "https://preview.cm4ker.ru/x1jpy2"), "Держи https://preview.cm4ker.ru/x1jpy2 и до встречи");
});
