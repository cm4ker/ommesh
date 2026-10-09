import { test } from "node:test";
import assert from "node:assert/strict";
import { ByteWriter, Resp } from "@meshnet/meshcore";
import { ESP_SYNC, hex, isLoaderAnswer, judge, PieceSplitter, planProbes, type Piece } from "./portLog.js";
import { DEFAULT_PORT } from "../transports/portSettings.js";

const deviceInfo = new ByteWriter()
  .u8(Resp.DeviceInfo)
  .u8(9)
  .u8(175)
  .u8(40)
  .u32(123456)
  .fixedString("09 Oct 2026", 12)
  .fixedString("Heltec V3", 40)
  .fixedString("v1.17.1", 20)
  .toBytes();

function framed(payload: Uint8Array): Uint8Array {
  return Uint8Array.from([0x3e, payload.length & 0xff, payload.length >> 8, ...payload]);
}

const text = (s: string) => new TextEncoder().encode(s);

test("a frame torn across chunks comes out whole, with the line before it", () => {
  const splitter = new PieceSplitter();
  const stream = Uint8Array.from([...text("booting\r\n"), ...framed(deviceInfo)]);
  const first = splitter.push(stream.slice(0, 14));
  assert.deepEqual(
    first.map((p) => p.kind),
    ["text"],
  );
  assert.equal((first[0] as Extract<Piece, { kind: "text" }>).text, "booting");
  const rest = splitter.push(stream.slice(14));
  assert.equal(rest.length, 1);
  assert.equal(rest[0]!.kind, "frame");
  assert.deepEqual((rest[0] as Extract<Piece, { kind: "frame" }>).payload, deviceInfo);
});

test("words without a line's end wait for the port to go quiet", () => {
  const splitter = new PieceSplitter();
  assert.deepEqual(splitter.push(text("Unknown command. Type 'help'.")), []);
  const out = splitter.flush();
  assert.deepEqual(out.map((p) => p.kind), ["text"]);
  assert.equal((out[0] as Extract<Piece, { kind: "text" }>).text, "Unknown command. Type 'help'.");
});

test("a '>' in words is not taken for a frame once the port is quiet", () => {
  const splitter = new PieceSplitter();
  // '>' then two bytes that read as a length a radio could send: held, as a frame may be coming.
  assert.deepEqual(splitter.push(Uint8Array.from([0x3e, 0x05, 0x00, 0x41])), []);
  const out = splitter.flush();
  assert.deepEqual(out.map((p) => p.kind), ["bytes"]);
});

test("bytes at the wrong speed come out as bytes, not text", () => {
  const splitter = new PieceSplitter();
  splitter.push(Uint8Array.from([0xe0, 0xf8, 0x1c, 0x80, 0xfe, 0x00, 0x9c]));
  const out = splitter.flush();
  assert.deepEqual(out.map((p) => p.kind), ["bytes"]);
});

test("a probe's answer: a frame says the radio heard, and who it is", () => {
  const verdict = judge([{ kind: "frame", payload: deviceInfo, bytes: framed(deviceInfo) }]);
  assert.equal(verdict.kind, "answered");
  if (verdict.kind !== "answered") return;
  assert.equal(verdict.info?.manufacturer, "Heltec V3");
  assert.equal(verdict.info?.firmwareVersion, "v1.17.1");
});

test("a probe's answer: words, the loader, noise and silence", () => {
  const line = (s: string): Piece => ({ kind: "text", text: s, bytes: text(s) });
  assert.deepEqual(judge([line("Unknown command. Type 'help'.")]), { kind: "text", text: "Unknown command. Type 'help'." });
  // An ESP32's boot lines are not the radio talking.
  assert.deepEqual(judge([line("ESP-ROM:esp32c6-20220919"), line("rst:0x15 (USB_UART_HPSYS),boot:0xc (SPI_FAST_FLASH_BOOT)")]), { kind: "silent" });
  assert.deepEqual(judge([line("waiting for download")]), { kind: "loader" });
  assert.deepEqual(judge([{ kind: "bytes", bytes: Uint8Array.from([0xc0, 0x01, 0x08, 0x04, 0x00, 0xc0]) }]), { kind: "loader" });
  assert.deepEqual(judge([{ kind: "bytes", bytes: Uint8Array.from([0xe0, 0xf8]) }]), { kind: "garbage" });
  assert.deepEqual(judge([]), { kind: "silent" });
});

test("the loader's SYNC is esptool's, and its answer is found among other bytes", () => {
  assert.equal(ESP_SYNC.length, 46);
  assert.deepEqual([ESP_SYNC[0], ESP_SYNC[1], ESP_SYNC[2], ESP_SYNC[3], ESP_SYNC.at(-1)], [0xc0, 0x00, 0x08, 0x24, 0xc0]);
  assert.equal(isLoaderAnswer(Uint8Array.from([0x00, 0xc0, 0x01, 0x08, 0x04])), true);
  assert.equal(isLoaderAnswer(Uint8Array.from([0xc0, 0x01])), false);
});

test("a board with its own USB is tried on its lines, what Connect would use first, never RTS alone", () => {
  const probes = planProbes("native", DEFAULT_PORT, { dtr: true, rts: false });
  assert.deepEqual(
    probes.map((p) => [p.baud, p.lines.dtr, p.lines.rts, p.current]),
    [
      [115200, true, false, true],
      [115200, false, false, false],
      [115200, true, true, false],
    ],
  );
});

test("a board behind a bridge is tried on its speeds, the one set first", () => {
  const probes = planProbes("bridge", { baud: 57600, lines: "auto" }, { dtr: false, rts: false });
  assert.deepEqual(probes.slice(0, 3).map((p) => p.baud), [57600, 115200, 230400]);
  assert.equal(probes.length, 8);
  assert.ok(probes.every((p) => !p.lines.dtr && !p.lines.rts));
  assert.equal(probes[0]!.current, true);
});

test("lines picked by hand come first; a browser's 'auto' is not tried as such", () => {
  const byHand = planProbes("native", { baud: 115200, lines: "on-on" }, { dtr: true, rts: false });
  assert.deepEqual([byHand[0]!.lines, byHand[0]!.current], [{ dtr: true, rts: true }, true]);
  assert.equal(byHand.length, 3);
  const browser = planProbes("unknown", DEFAULT_PORT, null);
  assert.ok(browser.every((p) => !p.current));
  assert.equal(browser.length, 16);
  assert.ok(browser.every((p) => !(p.lines.rts && !p.lines.dtr)));
});

test("bytes are shown as hex pairs, cut past the limit", () => {
  assert.equal(hex(Uint8Array.from([0x3c, 0x02, 0x00, 0x16, 0x03])), "3c 02 00 16 03");
  assert.equal(hex(Uint8Array.from([1, 2, 3]), 2), "01 02 …");
});
