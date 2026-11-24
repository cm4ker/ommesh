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

import { ByteReader } from "./bytes.js";

/** Highest `MCRS` extension protocol version this client understands. */
export const MCRS_VERSION = 1;

/** Vendor opcode shared by companion frames (`Cmd.Mcrs` / `Resp.Mcrs`) and LoRa binary requests (`ReqType.Mcrs`). */
export const MCRS_OPCODE = 0x70;

/** Subcommands multiplexed under `MCRS_OPCODE` (`0x70`). */
export const McrsSub = {
  /** Protocol version, build identity and hardware/firmware capability bitmask. */
  Info: 0x00,
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
