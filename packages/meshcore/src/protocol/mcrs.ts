/**
 * The `meshcore-rs` extension protocol (`MCRS`), spoken alongside the upstream
 * MeshCore protocol.
 *
 * A single vendor opcode (`0x70`, below the `0x80` push boundary and clear of
 * Ommesh's `0xF0`/`0xF1` phone-relay frames) multiplexes all `meshcore-rs`
 * subcommands by their second byte:
 * - Companion app link (USB / BLE / TCP): `[0x70, subcmd, ...args]` →
 *   `[0x70, subcmd, ...body]` (or standard `Resp.Err` when unsupported).
 * - Remote repeater/room over LoRa (`CMD_SEND_BINARY_REQ`): `[0x70, subcmd,
 *   ...args]` → `[tag 4][subcmd, ...body]` (silent when unsupported).
 *
 * Both transports share the `[subcmd, ...body]` payload, so one decoder handles
 * connected companions and remote nodes alike.
 */

import { ByteReader, ByteWriter, pathHashCount, unixNow } from "./bytes.js";
import { PUB_KEY_PREFIX_SIZE } from "./codes.js";

/** Highest `MCRS` extension protocol version this client understands. */
export const MCRS_VERSION = 2;

/** Vendor opcode shared by companion frames (`Cmd.Mcrs` / `Resp.Mcrs`) and LoRa binary requests (`ReqType.Mcrs`). */
export const MCRS_OPCODE = 0x70;

/** Unprompted push opcode (`0xE0`) from a `meshcore-rs` companion. */
export const MCRS_PUSH_OPCODE = 0xe0;

/** Maximum binary payload size of an MCRS v2 peer datagram (`TXT_TYPE_PEER_DATA`). */
export const MAX_PEER_DATA_LEN = 150;

/** Subcommands multiplexed under `MCRS_OPCODE` (`0x70`) and push subcodes under `MCRS_PUSH_OPCODE` (`0xE0`). */
export const McrsSub = {
  /** Protocol version, build identity and hardware/firmware capability bitmask. */
  Info: 0x00,
  /** Send an ACKed, encrypted binary P2P datagram to a contact. */
  SendPeerData: 0x01,
  /** Pop the next incoming binary P2P datagram from the companion's queue. */
  SyncPeerData: 0x02,
  /** Push subcode (under `0xE0`): at least one incoming binary P2P datagram is queued. */
  PeerDataWaiting: 0x03,
} as const;

/** Capability bits reported in `McrsInfo.caps` (matches `crates/meshcore/src/mcrs.rs`). */
export const McrsCap = {
  Screen: 1 << 0,
  Led: 1 << 1,
  Buzzer: 1 << 2,
  Gps: 1 << 3,
  Wifi: 1 << 4,
  FemLna: 1 << 5,
  AdcMult: 1 << 6,
  Ota: 1 << 7,
  Rollback: 1 << 8,
  TimeSync: 1 << 9,
  Sensors: 1 << 10,
  Room: 1 << 11,
  BleOta: 1 << 12,
  WifiOta: 1 << 13,
  Powersaving: 1 << 14,
  Mqtt: 1 << 15,
  /** Companion supports ACKed binary P2P datagrams (`SendPeerData` / `SyncPeerData`). */
  PeerData: 1 << 16,
} as const;

/** Board identifiers from `meshcore-rs`'s `release::board`. */
export const McrsBoard = {
  HeltecV4: 1,
  HeltecV3: 2,
  XiaoC6: 3,
  TEcho: 4,
  ProMicro: 5,
  HeltecPaper: 6,
  HeltecT114: 7,
  T3S3: 8,
  HeltecT096: 9,
  HeltecMeshPocket: 10,
} as const;

const BOARD_NAMES: Record<number, string> = {
  [McrsBoard.HeltecV4]: "heltec-v4",
  [McrsBoard.HeltecV3]: "heltec-v3",
  [McrsBoard.XiaoC6]: "xiao-c6",
  [McrsBoard.TEcho]: "t-echo",
  [McrsBoard.ProMicro]: "promicro",
  [McrsBoard.HeltecPaper]: "heltec-paper",
  [McrsBoard.HeltecT114]: "heltec-t114",
  [McrsBoard.T3S3]: "t3s3",
  [McrsBoard.HeltecT096]: "heltec-t096",
  [McrsBoard.HeltecMeshPocket]: "heltec-mesh-pocket",
};

/** Firmware roles from `meshcore-rs`'s `release::role`. */
export const McrsRole = {
  Repeater: 1,
  Companion: 2,
} as const;

const ROLE_NAMES: Record<number, string> = {
  [McrsRole.Repeater]: "repeater",
  [McrsRole.Companion]: "companion",
};

/** Build identity and capability snapshot returned by `McrsSub.Info`. */
export interface McrsInfo {
  /** Extension protocol version (`MCRS_VERSION` reported by the firmware). */
  version: number;
  /** Target board id (`McrsBoard.*`, 0 when unknown). */
  board: number;
  /** Target role id (`McrsRole.*`, 0 when unknown). */
  role: number;
  /** Release build counter (`MCFW_COUNTER`, 0 for local builds). */
  counter: number;
  /** Bitmask of `McrsCap` flags supported by this build and board. */
  caps: number;
  /** `meshcore-rs` product version string (e.g. `"0.9.0"`). */
  productVersion: string;
}

const INFO_FIXED_LEN = 13;
const MAX_PRODUCT_VERSION = 31;

/** Whether a `firmwareVersion` string (`DeviceInfo.firmwareVersion` or `OwnerInfo.firmware`) marks `meshcore-rs`. */
export function isMeshCoreRsVersion(firmwareVersion: string | null | undefined): boolean {
  return typeof firmwareVersion === "string" && firmwareVersion.trim().endsWith("-rs");
}

/** Whether `info` speaks at least `minVersion` of the MCRS extension protocol. */
export function hasMcrsVersion(info: McrsInfo | null | undefined, minVersion = 1): boolean {
  return (info?.version ?? 0) >= minVersion;
}

/** Whether `info` advertises all capability bits in `mask` (`McrsCap.*`). */
export function hasMcrsCap(info: McrsInfo | null | undefined, mask: number): boolean {
  return info != null && ((info.caps & mask) >>> 0) === (mask >>> 0);
}

/** Short release slug for a board id (`heltec-v4`, `t-echo`, …), or null if unknown. */
export function mcrsBoardName(board: number): string | null {
  return BOARD_NAMES[board] ?? null;
}

/** Short release slug for a role id (`repeater` or `companion`), or null if unknown. */
export function mcrsRoleName(role: number): string | null {
  return ROLE_NAMES[role] ?? null;
}

/**
 * Decodes a `[McrsSub.Info, ...]` payload from either a companion `Resp.Mcrs`
 * frame (bytes after `0x70`) or a LoRa `binaryResponse` (bytes after the tag).
 * Trailing bytes added by newer `MCRS_VERSION`s are ignored.
 */
export function readMcrsInfo(data: Uint8Array): McrsInfo | null {
  if (data.length < INFO_FIXED_LEN || data[0] !== McrsSub.Info) return null;
  const r = new ByteReader(data);
  r.skip(1);
  const version = r.u8();
  const board = r.u8();
  const role = r.u8();
  const counter = r.u32();
  const caps = r.u32();
  const vlen = r.u8();
  if (vlen > MAX_PRODUCT_VERSION || r.remaining < vlen) return null;
  const productVersion = new TextDecoder().decode(r.take(vlen));
  return { version, board, role, counter, caps, productVersion };
}

/** Answer to `McrsSub.SendPeerData`. */
export interface PeerDataSent {
  flood: boolean;
  ackTag: number;
  estTimeoutMs: number;
}

/** One incoming binary P2P datagram popped by `McrsSub.SyncPeerData`. */
export interface PeerDataFrame {
  /** dB (quarter-dB resolution). */
  snr: number;
  senderPrefix: Uint8Array;
  /** Hops taken over flood, or null when delivered direct. */
  hops: number | null;
  timestamp: number;
  appId: number;
  payload: Uint8Array;
}

/** Encodes the body after `[0x70, McrsSub.SendPeerData]`. */
export function encodeSendPeerDataBody(
  recipientPrefix: Uint8Array,
  appId: number,
  payload: Uint8Array,
  options: { attempt?: number; timestamp?: number } = {},
): Uint8Array {
  if (recipientPrefix.length < PUB_KEY_PREFIX_SIZE) {
    throw new Error(`recipient prefix must be at least ${PUB_KEY_PREFIX_SIZE} bytes`);
  }
  if (!Number.isInteger(appId) || appId <= 0 || appId > 0xffff) {
    throw new Error(`appId must be 1..65535, got ${appId}`);
  }
  if (payload.length > MAX_PEER_DATA_LEN) {
    throw new Error(`peer data payload is ${payload.length} bytes; max is ${MAX_PEER_DATA_LEN}`);
  }
  return new ByteWriter()
    .u8((options.attempt ?? 0) & 0xff)
    .u32(options.timestamp ?? unixNow())
    .bytes(recipientPrefix.subarray(0, PUB_KEY_PREFIX_SIZE))
    .u16(appId)
    .bytes(payload)
    .toBytes();
}

/** Decodes a `[McrsSub.SendPeerData, flood, ackTag(4), estTimeoutMs(4)]` reply payload. */
export function readPeerDataSent(data: Uint8Array): PeerDataSent | null {
  if (data.length < 10 || data[0] !== McrsSub.SendPeerData) return null;
  const r = new ByteReader(data);
  r.skip(1);
  return {
    flood: r.u8() === 1,
    ackTag: r.u32(),
    estTimeoutMs: r.u32(),
  };
}

/**
 * Decodes a `[McrsSub.SyncPeerData, ...]` reply payload; returns `null` when the
 * queue is empty (`data.length === 1`) or malformed.
 */
export function readPeerDataFrame(data: Uint8Array): PeerDataFrame | null {
  if (data.length < 16 || data[0] !== McrsSub.SyncPeerData) return null;
  const r = new ByteReader(data);
  r.skip(1);
  const snr = r.i8() / 4;
  const senderPrefix = r.take(PUB_KEY_PREFIX_SIZE);
  const rawPathLen = r.u8();
  const hops = rawPathLen === 0xff ? null : pathHashCount(rawPathLen);
  const timestamp = r.u32();
  const appId = r.u16();
  const length = r.u8();
  if (appId === 0 || length > MAX_PEER_DATA_LEN || r.remaining < length) return null;
  return { snr, senderPrefix, hops, timestamp, appId, payload: r.take(length) };
}
