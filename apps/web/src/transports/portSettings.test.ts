import { test } from "node:test";
import assert from "node:assert/strict";
import { autoLines, boardKind, choiceOf, linesOf, mayBeEsp32, validBaud } from "./portSettings.js";

test("a choice of lines reads both ways", () => {
  assert.deepEqual(linesOf("off-on"), { dtr: false, rts: true });
  assert.deepEqual(linesOf("on-off"), { dtr: true, rts: false });
  for (const choice of ["off-off", "off-on", "on-off", "on-on"] as const) assert.equal(choiceOf(linesOf(choice)), choice);
});

test("1200 is never a speed: it sends nRF52 and RP2040 boards to their bootloader", () => {
  assert.equal(validBaud(1200), false);
  assert.deepEqual([9600, 115200, 921600, 250000].map(validBaud), [true, true, true, true]);
  assert.deepEqual([0, 115200.5, NaN, 5_000_000].map(validBaud), [false, false, false, false]);
});

test("the board's kind and the lines 'auto' raises, by the port's maker", () => {
  const usb = (vid: number) => ({ vid, pid: 1 });
  // A CP210x and a CH340 are bridges: DTR there holds the ESP32's BOOT pin.
  assert.deepEqual([boardKind(usb(0x10c4)), boardKind(usb(0x1a86)), boardKind(usb(0x303a)), boardKind(usb(0x239a)), boardKind(undefined)], ["bridge", "bridge", "native", "native", "unknown"]);
  assert.deepEqual(autoLines(usb(0x10c4)), { dtr: false, rts: false });
  assert.deepEqual(autoLines(usb(0x239a)), { dtr: true, rts: false });
  assert.deepEqual(autoLines(undefined), { dtr: true, rts: false });
  // An nRF52 has no ROM loader to look for.
  assert.deepEqual([mayBeEsp32(usb(0x303a)), mayBeEsp32(usb(0x10c4)), mayBeEsp32(usb(0x239a)), mayBeEsp32(undefined)], [true, true, false, true]);
});
