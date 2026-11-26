import { test } from "node:test";
import assert from "node:assert/strict";
import { BLE } from "@meshnet/meshcore";
import { advertisedName, isMeshCoreDevice, mergeRemembered, scanDeviceName } from "./capacitorBle.js";
import { roleOf } from "./role.js";
import type { FoundDevice } from "./types.js";

function ad(...structures: [number, Uint8Array | number[]][]): DataView {
  const bytes: number[] = [];
  for (const [type, payload] of structures) {
    bytes.push(payload.length + 1, type, ...payload);
  }
  bytes.push(0, 0, 0);
  return new DataView(Uint8Array.from(bytes).buffer);
}

const utf8 = (text: string) => new TextEncoder().encode(text);

// Nordic UART Service UUID in little-endian wire order, as meshcore-ble puts it in ADV_IND.
const UART_LE = [0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0, 0x93, 0xf3, 0xa3, 0xb5, 0x01, 0x00, 0x40, 0x6e];

test("advertisedName extracts Complete Local Name from ADV_IND + SCAN_RSP bytes", () => {
  const raw = ad([0x01, [0x06]], [0x07, UART_LE], [0x09, utf8("MeshCore-AlmsHouse 🎃")]);
  assert.equal(advertisedName(raw), "MeshCore-AlmsHouse 🎃");
});

test("advertisedName falls back to Shortened Local Name (0x08) and prefers Complete (0x09)", () => {
  const shortOnly = ad([0x01, [0x06]], [0x08, utf8("MeshCore-SNK")]);
  assert.equal(advertisedName(shortOnly), "MeshCore-SNK");

  const both = ad([0x08, utf8("MeshCore-S")], [0x09, utf8("MeshCore-SNK-V4")]);
  assert.equal(advertisedName(both), "MeshCore-SNK-V4");
});

test("advertisedName ignores missing, empty, NUL-only, or truncated packets", () => {
  assert.equal(advertisedName(undefined), null);
  assert.equal(advertisedName(new DataView(new ArrayBuffer(0))), null);
  assert.equal(advertisedName(ad([0x01, [0x06]], [0x07, UART_LE])), null);
  assert.equal(advertisedName(ad([0x09, [0, 0]])), null);
  // Truncated length past end of buffer stops safely without throwing.
  const truncated = new DataView(Uint8Array.from([20, 0x09, 0x4d, 0x65]).buffer);
  assert.equal(advertisedName(truncated), null);
});

test("scanDeviceName recovers live Android scan-response name and never lets empty cached strings hide a radio", () => {
  const withName = ad([0x01, [0x06]], [0x07, UART_LE], [0x09, utf8("MeshCore-V4")]);
  assert.equal(scanDeviceName({ localName: "", device: { name: "" }, rawAdvertisement: withName }), "MeshCore-V4");

  // Empty cached name without a scan response still resolves as a MeshCore radio, not a phone.
  const advOnly = ad([0x01, [0x06]], [0x07, UART_LE]);
  const fallback = scanDeviceName({ localName: "", device: { name: "" }, rawAdvertisement: advOnly });
  assert.equal(fallback, "MeshCore");
  assert.equal(roleOf({ id: "AA:BB:CC:DD:EE:FF", name: fallback, detail: null, rssi: -60 }, "ble"), "radio");

  // Once a scan response has named the radio on Android, a later advert without one keeps that name.
  assert.equal(
    scanDeviceName({ localName: "StaleAlias", device: { name: "StaleAlias" }, rawAdvertisement: advOnly }, "MeshCore-V4"),
    "MeshCore-V4",
  );

  // On iOS (no rawAdvertisement) a later advert updates the name normally.
  assert.equal(scanDeviceName({ localName: "MeshCore-New", device: { name: "MeshCore-Old" } }, "MeshCore-Old"), "MeshCore-New");
  assert.equal(scanDeviceName({ device: {} }), "MeshCore");
});

test("isMeshCoreDevice matches MeshCore radios and excludes unrelated Bluetooth accessories", () => {
  assert.equal(isMeshCoreDevice({ name: "MeshCore-AlmsHouse" }), true);
  assert.equal(isMeshCoreDevice({ name: "MeshCore" }), true);
  assert.equal(isMeshCoreDevice({ name: "CustomRadio", uuids: [BLE.service.toUpperCase()] }), true);
  assert.equal(isMeshCoreDevice({ name: "Galaxy Watch 6" }), false);
  assert.equal(isMeshCoreDevice({ name: "Ommesh PKIO" }), false);
  assert.equal(isMeshCoreDevice({ name: "" }), false);
  assert.equal(isMeshCoreDevice({}), false);
});

test("mergeRemembered keeps app-remembered radios first and adds system-bonded MeshCore radios without duplicates", () => {
  const saved: FoundDevice[] = [{ id: "AA:BB:CC:DD:EE:01", name: "MeshCore-One", detail: null, rssi: null, radioKey: "deadbeef" }];
  const merged = mergeRemembered(saved, [
    { deviceId: "aa:bb:cc:dd:ee:01", name: "MeshCore-One" },
    { deviceId: "AA:BB:CC:DD:EE:02", name: "MeshCore-Two" },
    { deviceId: "AA:BB:CC:DD:EE:03", name: "Headphones" },
  ]);
  assert.deepEqual(merged, [
    { id: "AA:BB:CC:DD:EE:01", name: "MeshCore-One", detail: null, rssi: null, radioKey: "deadbeef" },
    { id: "AA:BB:CC:DD:EE:02", name: "MeshCore-Two", detail: null, rssi: null, bonded: true },
  ]);
});
