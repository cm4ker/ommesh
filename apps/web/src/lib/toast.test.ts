import { test } from "node:test";
import assert from "node:assert/strict";
import { toastSpot } from "./toast.js";

test("a toast over an open sheet sits above it, never on its rows", () => {
  // The clock sheet of #85: its top at 520 px on an 800 px screen.
  assert.deepEqual(toastSpot({ height: 800, toast: 60, sheetTop: 520, fieldTop: null }), { bottom: 288 });
  // A chat's field under the sheet does not pull it down.
  assert.deepEqual(toastSpot({ height: 800, toast: 60, sheetTop: 520, fieldTop: 740 }), { bottom: 288 });
});

test("a sheet with no room above it sends the toast to the top of the screen", () => {
  assert.equal(toastSpot({ height: 800, toast: 60, sheetTop: 110, fieldTop: null }), "top");
  assert.deepEqual(toastSpot({ height: 800, toast: 60, sheetTop: 124, fieldTop: null }), { bottom: 684 });
});

test("with no sheet, a toast sits above the field being typed in, or where the stylesheet puts it", () => {
  assert.deepEqual(toastSpot({ height: 800, toast: 44, sheetTop: null, fieldTop: 740 }), { bottom: 68 });
  assert.equal(toastSpot({ height: 800, toast: 44, sheetTop: null, fieldTop: null }), null);
});
