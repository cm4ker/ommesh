import { test } from "node:test";
import assert from "node:assert/strict";
import { hashHops, repeatAllowed, repeatFreqsText } from "./radioNetwork.js";

const DEFAULT = [
  { lowerKhz: 433_000, upperKhz: 433_000 },
  { lowerKhz: 869_495, upperKhz: 869_495 },
  { lowerKhz: 918_000, upperKhz: 918_000 },
];

test("repeat is allowed only on the radio's own frequencies", () => {
  assert.equal(repeatAllowed(869_495, DEFAULT), true);
  assert.equal(repeatAllowed(868_731, DEFAULT), false, "OMS");
  assert.equal(repeatAllowed(869_525, DEFAULT), false, "EU/UK is 30 kHz off");
  assert.equal(repeatAllowed(869_500, [{ lowerKhz: 869_400, upperKhz: 869_600 }]), true, "a range takes what is inside it");
});

test("a radio that gives no list is left to say", () => {
  assert.equal(repeatAllowed(869_161, null), true);
  assert.equal(repeatAllowed(869_161, []), false);
});

test("the frequencies read as the field takes them", () => {
  assert.equal(repeatFreqsText(DEFAULT), "433.000, 869.495, 918.000");
  assert.equal(repeatFreqsText([{ lowerKhz: 869_400, upperKhz: 869_600 }]), "869.400–869.600");
});

test("a longer hash holds fewer hops", () => {
  assert.deepEqual([0, 1, 2].map(hashHops), [64, 32, 21]);
});
