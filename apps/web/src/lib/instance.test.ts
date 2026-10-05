import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { copyNumber, ownKey } from "./instance.js";

const shellSaid = globalThis as { __OMMESH_COPY__?: unknown };

afterEach(() => {
  delete shellSaid.__OMMESH_COPY__;
});

test("the first copy keeps every setting's own name", () => {
  assert.equal(copyNumber(), 1);
  assert.equal(ownKey("meshnet.link.last"), "meshnet.link.last");
});

test("another copy keeps its settings under its number", () => {
  shellSaid.__OMMESH_COPY__ = 2;
  assert.equal(copyNumber(), 2);
  assert.equal(ownKey("meshnet.link.last"), "meshnet.link.last@2");
});

test("a number the shell could not have said is the first copy", () => {
  for (const said of [0, -1, 1.5, "2", null]) {
    shellSaid.__OMMESH_COPY__ = said;
    assert.equal(copyNumber(), 1);
  }
});
