import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedText } from "./shareIn.js";

test("a browser's link: the address alone, without the page's title", () => {
  assert.equal(sharedText({ title: "MeshCore", url: "https://meshcore.co.uk/" }), "https://meshcore.co.uk/");
});

test("written words with the address after them", () => {
  assert.equal(sharedText({ text: "Look at this", url: "https://example.com" }), "Look at this https://example.com");
});

test("an address already in the text is not put twice", () => {
  assert.equal(sharedText({ text: "Look https://example.com", url: "https://example.com" }), "Look https://example.com");
});

test("the title only when nothing else came", () => {
  assert.equal(sharedText({ title: " Notes ", text: "  " }), "Notes");
  assert.equal(sharedText({}), "");
});
