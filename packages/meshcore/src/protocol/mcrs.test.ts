import assert from "node:assert/strict";
import test from "node:test";
import { ByteWriter } from "./bytes.js";
import {
  MCRS_VERSION,
  McrsBoard,
  McrsCap,
  McrsRole,
  McrsSub,
  hasMcrsCap,
  hasMcrsVersion,
  isMeshCoreRsVersion,
  mcrsBoardName,
  mcrsRoleName,
  readMcrsInfo,
} from "./mcrs.js";

function encodeInfo(info: { version: number; board: number; role: number; counter: number; caps: number; productVersion: string }, extra: number[] = []): Uint8Array {
  const ver = new TextEncoder().encode(info.productVersion);
  return new ByteWriter()
    .u8(McrsSub.Info)
    .u8(info.version)
    .u8(info.board)
    .u8(info.role)
    .u32(info.counter)
    .u32(info.caps)
    .u8(ver.length)
    .bytes(ver)
    .bytes(new Uint8Array(extra))
    .toBytes();
}

test("decodes MCRS info payloads and ignores trailing bytes from newer versions", () => {
  const caps = McrsCap.Screen | McrsCap.Led | McrsCap.Wifi | McrsCap.Ota | McrsCap.TimeSync;
  const payload = encodeInfo(
    { version: MCRS_VERSION, board: McrsBoard.HeltecV4, role: McrsRole.Companion, counter: 168, caps, productVersion: "0.9.0" },
    [0xde, 0xad, 0xbe, 0xef],
  );
  const info = readMcrsInfo(payload);
  assert.deepEqual(info, {
    version: 1,
    board: McrsBoard.HeltecV4,
    role: McrsRole.Companion,
    counter: 168,
    caps,
    productVersion: "0.9.0",
  });
  assert.equal(mcrsBoardName(info.board), "heltec-v4");
  assert.equal(mcrsRoleName(info.role), "companion");
  assert.equal(hasMcrsVersion(info, 1), true);
  assert.equal(hasMcrsVersion(info, 2), false);
  assert.equal(hasMcrsCap(info, McrsCap.Screen | McrsCap.Ota), true);
  assert.equal(hasMcrsCap(info, McrsCap.Gps), false);
});

test("rejects truncated, empty or wrong-subcommand MCRS info payloads", () => {
  assert.equal(readMcrsInfo(new Uint8Array()), null);
  assert.equal(readMcrsInfo(new Uint8Array(12)), null);
  const valid = encodeInfo({ version: 1, board: 0, role: 0, counter: 0, caps: 0, productVersion: "0.9.0" });
  const wrongSub = valid.slice();
  wrongSub[0] = 0x01;
  assert.equal(readMcrsInfo(wrongSub), null);
  assert.equal(readMcrsInfo(valid.subarray(0, valid.length - 1)), null);
});

test("detects meshcore-rs firmware version strings", () => {
  assert.equal(isMeshCoreRsVersion("v1.18.0-rs"), true);
  assert.equal(isMeshCoreRsVersion("v1.18.0-rs "), true);
  assert.equal(isMeshCoreRsVersion("v1.18.0"), false);
  assert.equal(isMeshCoreRsVersion("v1.17.1"), false);
  assert.equal(isMeshCoreRsVersion(null), false);
  assert.equal(isMeshCoreRsVersion(undefined), false);
});
