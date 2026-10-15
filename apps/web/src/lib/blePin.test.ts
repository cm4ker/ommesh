import { test } from "node:test";
import assert from "node:assert/strict";
import { pinDigits, pinFault } from "./blePin.js";

test("a typed PIN keeps its digits and no more than six", () => {
  assert.equal(pinDigits("482 913"), "482913");
  assert.equal(pinDigits("48-29-13-77"), "482913");
  assert.equal(pinDigits("pin"), "");
});

test("a PIN is six digits that do not start with 0", () => {
  assert.equal(pinFault("482913"), null);
  assert.equal(pinFault("48291"), "short");
  assert.equal(pinFault(""), "short");
  assert.equal(pinFault("012345"), "zero");
  assert.equal(pinFault("0"), "zero");
});
