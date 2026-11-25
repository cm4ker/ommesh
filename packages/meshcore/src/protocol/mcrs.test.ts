import assert from "node:assert/strict";
import test from "node:test";
import { ByteWriter } from "./bytes.js";
import { Push } from "./codes.js";
import { decodeFrame } from "./frames.js";
import {
  MAX_PEER_DATA_LEN,
  MCRS_VERSION,
  McrsBoard,
  McrsCap,
  McrsRole,
  McrsSub,
  encodeSendPeerDataBody,
  hasMcrsCap,
  hasMcrsVersion,
  isMeshCoreRsVersion,
  mcrsBoardName,
  mcrsRoleName,
  readMcrsInfo,
  readPeerDataFrame,
  readPeerDataSent,
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
    version: MCRS_VERSION,
    board: McrsBoard.HeltecV4,
    role: McrsRole.Companion,
    counter: 168,
    caps,
    productVersion: "0.9.0",
  });
  assert.equal(mcrsBoardName(info.board), "heltec-v4");
  assert.equal(mcrsRoleName(info.role), "companion");
  assert.equal(hasMcrsVersion(info, 1), true);
  assert.equal(hasMcrsVersion(info, 2), true);
  assert.equal(hasMcrsVersion(info, 3), false);
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

test("encodes and decodes MCRS v2 peer data frames and pushes", () => {
  const prefix = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
  const move = new Uint8Array([0x04, 0xf2, 0xa4, 0x01, 0x00, 0x00, 0x0c, 0x5a]);
  const body = encodeSendPeerDataBody(prefix, 0x0100, move, { attempt: 2, timestamp: 1_700_000_001 });
  assert.equal(body.length, 13 + move.length);
  assert.equal(body[0], 2);
  assert.deepEqual(body.subarray(5, 11), prefix);
  assert.deepEqual(body.subarray(13), move);

  assert.throws(() => encodeSendPeerDataBody(prefix, 0, move));
  assert.throws(() => encodeSendPeerDataBody(prefix, 0x0100, new Uint8Array(MAX_PEER_DATA_LEN + 1)));

  const sentBytes = new ByteWriter().u8(McrsSub.SendPeerData).u8(1).u32(0x12345678).u32(4200).toBytes();
  assert.deepEqual(readPeerDataSent(sentBytes), { flood: true, ackTag: 0x12345678, estTimeoutMs: 4200 });

  const recvBytes = new ByteWriter()
    .u8(McrsSub.SyncPeerData)
    .i8(24) // +6.0 dB
    .bytes(prefix)
    .u8(0xff) // direct
    .u32(1_700_000_001)
    .u16(0x0100)
    .u8(move.length)
    .bytes(move)
    .toBytes();
  assert.deepEqual(readPeerDataFrame(recvBytes), {
    snr: 6,
    senderPrefix: prefix,
    hops: null,
    timestamp: 1_700_000_001,
    appId: 0x0100,
    payload: move,
  });
  assert.equal(readPeerDataFrame(new Uint8Array([McrsSub.SyncPeerData])), null);

  const push = decodeFrame(new Uint8Array([Push.Mcrs, McrsSub.PeerDataWaiting]));
  assert.equal(push.kind, "mcrsPush");
  if (push.kind === "mcrsPush") assert.equal(push.sub, McrsSub.PeerDataWaiting);
});
