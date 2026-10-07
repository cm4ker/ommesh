/**
 * Decoding every frame the companion firmware writes, responses and pushes
 * alike, into one tagged union. A frame this module does not know is returned
 * as `unknown` with its bytes, never thrown on: a newer firmware is not an
 * error.
 *
 * Layouts are the firmware's own writers, byte for byte, with the version
 * notes kept where a field was added.
 */

import { ByteReader, fromUtf8, pathByteLength, pathHashCount } from "./bytes.js";
import { MAX_PATH_SIZE, PUB_KEY_PREFIX_SIZE, PUB_KEY_SIZE, Push, Resp, StatsType, TxtType } from "./codes.js";
import { decodeLpp, type LppReading } from "./lpp.js";

/** A contact as the radio holds it. Positions are degrees; zeros mean none. */
export interface Contact {
  publicKey: Uint8Array;
  /** An `AdvType`. */
  type: number;
  /** `ContactFlag` bits. */
  flags: number;
  /** The `path_len` byte of the route out; `0xff` when the radio has none. */
  outPathLen: number;
  outPath: Uint8Array;
  name: string;
  /** Unix seconds of the last advert heard. */
  lastAdvert: number;
  lat: number;
  lon: number;
  /** Unix seconds; the cursor `getContacts(since)` compares against. */
  lastMod: number;
}

export interface SelfInfo {
  advType: number;
  txPower: number;
  maxTxPower: number;
  publicKey: Uint8Array;
  lat: number;
  lon: number;
  /** v7+ */
  multiAcks: number;
  advertLocPolicy: number;
  /** v5+: `(env << 4) | (loc << 2) | base`. */
  telemetryModeBase: number;
  telemetryModeLocation: number;
  telemetryModeEnvironment: number;
  manualAddContacts: number;
  frequencyKhz: number;
  bandwidthHz: number;
  spreadingFactor: number;
  codingRate: number;
  name: string;
}

export interface DeviceInfo {
  firmwareVerCode: number;
  /** v3+ */
  maxContacts: number;
  maxChannels: number;
  blePin: number;
  buildDate: string;
  manufacturer: string;
  firmwareVersion: string;
  /** v9+ */
  repeatEnabled: boolean | null;
  /** v10+ */
  pathHashMode: number | null;
}

/**
 * A status answer: `struct RepeaterStats` from a repeater, `struct
 * ServerStats` from a room. The two share their first 48 bytes and differ in
 * the tail, so which one arrived depends on who was asked, not on the bytes.
 */
export interface NodeStats {
  batteryMv: number;
  txQueueLen: number;
  noiseFloor: number;
  lastRssi: number;
  packetsRecv: number;
  packetsSent: number;
  airTimeSecs: number;
  upTimeSecs: number;
  sentFlood: number;
  sentDirect: number;
  recvFlood: number;
  recvDirect: number;
  errEvents: number;
  /** dB. */
  lastSnr: number;
  directDups: number;
  floodDups: number;
  /** Repeaters: time spent receiving. Null from a room, or from a repeater too old to send it. */
  rxAirTimeSecs: number | null;
  recvErrors: number | null;
  /** Rooms: posts stored. */
  posted: number | null;
  /** Rooms: posts pushed out to members. */
  postPushes: number | null;
}

/** One repeater another repeater hears direct, as `GetNeighbours` lists it. */
export interface Neighbour {
  prefix: Uint8Array;
  heardSecsAgo: number;
  /** dB. */
  snr: number;
}

export interface AccessEntry {
  prefix: Uint8Array;
  /** The low two bits are an `AclRole`; the rest are node-specific (a sensor's alert levels). */
  permissions: number;
}

/** A sensor's summary of one series over a window. */
export interface SeriesSummary {
  channel: number;
  /** The Cayenne LPP type code of the series. */
  lppType: number;
  min: number;
  max: number;
  avg: number;
}

export type ResponseFrame =
  | { kind: "ok" }
  | { kind: "err"; code: number }
  | { kind: "contactsStart"; count: number }
  | { kind: "contact"; contact: Contact }
  | { kind: "endOfContacts"; mostRecentLastMod: number }
  | { kind: "selfInfo"; info: SelfInfo }
  | { kind: "sent"; flood: boolean; ackTag: number; estTimeoutMs: number }
  | {
      kind: "contactMessage";
      /** dB, or null on the legacy frame. */
      snr: number | null;
      senderPrefix: Uint8Array;
      /** Hops the packet took, or null when it came direct. */
      pathLen: number | null;
      txtType: number;
      timestamp: number;
      /** The signer's key prefix, on `SignedPlain` text from a room. */
      signerPrefix: Uint8Array | null;
      text: string;
    }
  | {
      kind: "channelMessage";
      snr: number | null;
      channelIndex: number;
      pathLen: number | null;
      txtType: number;
      timestamp: number;
      /** `<sender>: <text>`, as the firmware puts it on the air. */
      text: string;
    }
  | {
      kind: "channelData";
      snr: number;
      channelIndex: number;
      pathLen: number | null;
      dataType: number;
      data: Uint8Array;
    }
  | { kind: "currTime"; time: number }
  | { kind: "noMoreMessages" }
  | { kind: "exportContact"; advert: Uint8Array }
  | { kind: "battAndStorage"; batteryMv: number; storageUsedKb: number; storageTotalKb: number }
  | { kind: "deviceInfo"; info: DeviceInfo }
  | { kind: "privateKey"; key: Uint8Array }
  | { kind: "disabled" }
  | { kind: "channelInfo"; index: number; name: string; secret: Uint8Array }
  | { kind: "signStart"; maxLength: number }
  | { kind: "signature"; signature: Uint8Array }
  | { kind: "customVars"; vars: Record<string, string> }
  | { kind: "advertPath"; receivedAt: number; pathLen: number; path: Uint8Array }
  | { kind: "tuningParams"; rxDelayBase: number; airtimeFactor: number }
  | { kind: "statsCore"; batteryMv: number; uptimeSecs: number; errFlags: number; queueLen: number }
  | {
      kind: "statsRadio";
      noiseFloor: number;
      lastRssi: number;
      lastSnr: number;
      txAirSecs: number;
      rxAirSecs: number;
    }
  | {
      kind: "statsPackets";
      recv: number;
      sent: number;
      sentFlood: number;
      sentDirect: number;
      recvFlood: number;
      recvDirect: number;
      recvErrors: number;
    }
  | { kind: "autoAddConfig"; config: number; maxHops: number }
  | { kind: "allowedRepeatFreq"; ranges: { lowerKhz: number; upperKhz: number }[] }
  | { kind: "defaultFloodScope"; name: string | null; key: Uint8Array | null }
  | { kind: "cliReply"; text: string };

export type PushFrame =
  | { kind: "advert"; publicKey: Uint8Array }
  | { kind: "pathUpdated"; publicKey: Uint8Array }
  | { kind: "sendConfirmed"; ackTag: number; roundTripMs: number }
  | { kind: "msgWaiting" }
  | { kind: "rawData"; snr: number; rssi: number; payload: Uint8Array }
  | {
      kind: "loginSuccess";
      /** The node's "is admin" flag. Rooms also answer 2 here for a client with no permissions at all. */
      adminFlag: number;
      prefix: Uint8Array;
      /** The node's clock, unix seconds. Null from a legacy "OK" answer. */
      serverTime: number | null;
      /** The client's permissions byte on the node; its low two bits are the `AclRole`. */
      permissions: number | null;
      firmwareLevel: number | null;
    }
  | { kind: "loginFail"; prefix: Uint8Array }
  /** Read the body with `readNodeStats`, knowing whether a repeater or a room was asked. */
  | { kind: "statusResponse"; prefix: Uint8Array; raw: Uint8Array }
  | { kind: "logRxData"; snr: number; rssi: number; raw: Uint8Array }
  | {
      kind: "traceData";
      flags: number;
      tag: number;
      auth: number;
      hashes: Uint8Array;
      /** dB per hop, then the final hop to this radio. */
      snrs: number[];
    }
  | { kind: "newAdvert"; contact: Contact }
  | { kind: "telemetryResponse"; prefix: Uint8Array; readings: LppReading[]; raw: Uint8Array }
  | { kind: "binaryResponse"; tag: number; data: Uint8Array }
  | {
      kind: "pathDiscoveryResponse";
      prefix: Uint8Array;
      outPathLen: number;
      outPath: Uint8Array;
      inPathLen: number;
      inPath: Uint8Array;
    }
  | { kind: "controlData"; snr: number; rssi: number; pathLen: number; payload: Uint8Array }
  | { kind: "contactDeleted"; publicKey: Uint8Array }
  | { kind: "contactsFull" }
  /** A text the other app sharing the radio sent: its command and the radio's answer (see `Push.Mirror`). */
  | { kind: "mirror"; command: Uint8Array; answer: Uint8Array };

export type Frame = ResponseFrame | PushFrame | { kind: "unknown"; code: number; raw: Uint8Array };

export type FrameKind = Frame["kind"];

export const PUSH_KINDS: ReadonlySet<FrameKind> = new Set<FrameKind>([
  "advert",
  "pathUpdated",
  "sendConfirmed",
  "msgWaiting",
  "rawData",
  "loginSuccess",
  "loginFail",
  "statusResponse",
  "logRxData",
  "traceData",
  "newAdvert",
  "telemetryResponse",
  "binaryResponse",
  "pathDiscoveryResponse",
  "controlData",
  "contactDeleted",
  "contactsFull",
  "mirror",
]);

export function isPushFrame(frame: Frame): frame is PushFrame {
  return PUSH_KINDS.has(frame.kind);
}

/**
 * The firmware writes `0xff` when the packet was routed direct, and the raw
 * `path_len` byte otherwise. Its top two bits carry the hash size, so the hop
 * count is the low six: `0x41` is one hop over two-byte hashes, not 65.
 */
function hops(pathLen: number): number | null {
  return pathLen === 0xff ? null : pathHashCount(pathLen);
}

/** SNR travels as a signed byte in quarter-decibels. */
function snr(raw: number): number {
  return raw / 4;
}

function readContact(r: ByteReader): Contact {
  return {
    publicKey: r.take(PUB_KEY_SIZE),
    type: r.u8(),
    flags: r.u8(),
    outPathLen: r.u8(),
    outPath: r.take(MAX_PATH_SIZE),
    name: r.fixedString(32),
    lastAdvert: r.u32(),
    lat: r.i32() / 1e6,
    lon: r.i32() / 1e6,
    lastMod: r.u32(),
  };
}

function readSelfInfo(r: ByteReader): SelfInfo {
  const advType = r.u8();
  const txPower = r.i8();
  const maxTxPower = r.i8();
  const publicKey = r.take(PUB_KEY_SIZE);
  const lat = r.i32() / 1e6;
  const lon = r.i32() / 1e6;
  const multiAcks = r.u8();
  const advertLocPolicy = r.u8();
  const modes = r.u8();
  const manualAddContacts = r.u8();
  const frequencyKhz = r.u32();
  const bandwidthHz = r.u32();
  const spreadingFactor = r.u8();
  const codingRate = r.u8();
  const name = r.restString();
  return {
    advType,
    txPower,
    maxTxPower,
    publicKey,
    lat,
    lon,
    multiAcks,
    advertLocPolicy,
    telemetryModeBase: modes & 0x03,
    telemetryModeLocation: (modes >> 2) & 0x03,
    telemetryModeEnvironment: (modes >> 4) & 0x03,
    manualAddContacts,
    frequencyKhz,
    bandwidthHz,
    spreadingFactor,
    codingRate,
    name,
  };
}

function readDeviceInfo(r: ByteReader): DeviceInfo {
  const firmwareVerCode = r.u8();
  const maxContacts = r.u8() * 2;
  const maxChannels = r.u8();
  const blePin = r.u32();
  const buildDate = r.fixedString(12);
  const manufacturer = r.fixedString(40);
  const firmwareVersion = r.fixedString(20);
  const repeatEnabled = r.remaining >= 1 ? r.u8() !== 0 : null;
  const pathHashMode = r.remaining >= 1 ? r.u8() : null;
  return {
    firmwareVerCode,
    maxContacts,
    maxChannels,
    blePin,
    buildDate,
    manufacturer,
    firmwareVersion,
    repeatEnabled,
    pathHashMode,
  };
}

/**
 * The body of a `statusResponse`. The first 48 bytes have been there since
 * v1.0 and are the least a node sends; a repeater then adds receive air time
 * and receive errors, a room the counts of posts stored and pushed.
 */
export function readNodeStats(bytes: Uint8Array, kind: "repeater" | "room"): NodeStats | null {
  if (bytes.length < 48) return null;
  const r = new ByteReader(bytes);
  const stats: NodeStats = {
    batteryMv: r.u16(),
    txQueueLen: r.u16(),
    noiseFloor: r.i16(),
    lastRssi: r.i16(),
    packetsRecv: r.u32(),
    packetsSent: r.u32(),
    airTimeSecs: r.u32(),
    upTimeSecs: r.u32(),
    sentFlood: r.u32(),
    sentDirect: r.u32(),
    recvFlood: r.u32(),
    recvDirect: r.u32(),
    errEvents: r.u16(),
    lastSnr: r.i16() / 4,
    directDups: r.u16(),
    floodDups: r.u16(),
    rxAirTimeSecs: null,
    recvErrors: null,
    posted: null,
    postPushes: null,
  };
  if (kind === "room") {
    if (r.remaining >= 4) {
      stats.posted = r.u16();
      stats.postPushes = r.u16();
    }
  } else {
    if (r.remaining >= 4) stats.rxAirTimeSecs = r.u32();
    if (r.remaining >= 4) stats.recvErrors = r.u32();
  }
  return stats;
}

/** The body of a `GetNeighbours` answer: how many there are in all, then this page. */
export function readNeighbours(bytes: Uint8Array, prefixLength = PUB_KEY_PREFIX_SIZE): { total: number; neighbours: Neighbour[] } {
  const r = new ByteReader(bytes);
  const total = r.u16();
  const count = r.u16();
  const neighbours: Neighbour[] = [];
  for (let i = 0; i < count && r.remaining >= prefixLength + 5; i++) {
    neighbours.push({ prefix: r.take(prefixLength), heardSecsAgo: r.u32(), snr: snr(r.i8()) });
  }
  return { total, neighbours };
}

/**
 * The body of a `GetAccessList` answer: seven bytes a client. The answer
 * comes decrypted in whole 16-byte blocks, so zeros may trail the list; the
 * node never sends a client with no permissions, so one marks the end.
 */
export function readAccessList(bytes: Uint8Array): AccessEntry[] {
  const r = new ByteReader(bytes);
  const entries: AccessEntry[] = [];
  while (r.remaining >= PUB_KEY_PREFIX_SIZE + 1) {
    const prefix = r.take(PUB_KEY_PREFIX_SIZE);
    const permissions = r.u8();
    if (permissions === 0) break;
    entries.push({ prefix, permissions });
  }
  return entries;
}

/** The body of a `GetOwnerInfo` answer: `version\nname\nowner`, where the owner text may hold newlines of its own. */
export function readOwnerInfo(bytes: Uint8Array): { firmware: string; name: string; owner: string } {
  const text = fromUtf8(bytes);
  const first = text.indexOf("\n");
  const second = first < 0 ? -1 : text.indexOf("\n", first + 1);
  if (first < 0) return { firmware: text, name: "", owner: "" };
  if (second < 0) return { firmware: text.slice(0, first), name: text.slice(first + 1), owner: "" };
  return { firmware: text.slice(0, first), name: text.slice(first + 1, second), owner: text.slice(second + 1) };
}

/**
 * The body of a `GetAvgMinMax` answer: the sensor's clock, then for each
 * series its channel, LPP type, and min, max and mean. The numbers use the
 * sensor's own widths and scales (`SensorMesh.cpp`), which are not quite
 * Cayenne's: humidity is two bytes in tenths here, one byte in halves there.
 */
export function readAvgMinMax(bytes: Uint8Array): { time: number; series: SeriesSummary[] } {
  const r = new ByteReader(bytes);
  const time = r.u32();
  const series: SeriesSummary[] = [];
  while (r.remaining >= 2) {
    const channel = r.u8();
    const lppType = r.u8();
    if (channel === 0 && lppType === 0) break; // the zeros padding the answer to a whole cipher block
    const size = seriesSize(lppType);
    if (r.remaining < size * 3) break;
    const scale = seriesScale(lppType);
    const signed = SIGNED_SERIES.has(lppType);
    const value = () => seriesValue(r.take(size), scale, signed);
    series.push({ channel, lppType, min: value(), max: value(), avg: value() });
  }
  return { time, series };
}

const SIGNED_SERIES = new Set([0x79, 0x67, 0x86, 0x02, 0x03, 0x88, 0x71]);

function seriesSize(type: number): number {
  switch (type) {
    case 0x88:
      return 9;
    case 0x86:
    case 0x71:
      return 6;
    case 0x64:
    case 0x76:
    case 0x82:
    case 0x83:
    case 0x85:
      return 4;
    case 0x87:
      return 3;
    case 0x02:
    case 0x03:
    case 0x65:
    case 0x67:
    case 0x7d:
    case 0x73:
    case 0x68:
    case 0x79:
    case 0x74:
    case 0x75:
    case 0x84:
    case 0x80:
      return 2;
    default:
      return 1;
  }
}

function seriesScale(type: number): number {
  switch (type) {
    case 0x75:
    case 0x82:
    case 0x83:
      return 1000;
    case 0x74:
    case 0x02:
    case 0x03:
      return 100;
    case 0x67:
    case 0x73:
    case 0x68:
      return 10;
    default:
      return 1;
  }
}

/** Big-endian, as the sensor writes it; wider than four bytes has no single value. */
function seriesValue(bytes: Uint8Array, scale: number, signed: boolean): number {
  if (bytes.length > 4) return Number.NaN;
  let v = 0;
  for (const b of bytes) v = v * 256 + b;
  const top = 2 ** (bytes.length * 8 - 1);
  if (signed && v >= top) v -= top * 2;
  return v / scale;
}

function readContactMessage(r: ByteReader, v3: boolean): ResponseFrame {
  const snrValue = v3 ? snr(r.i8()) : null;
  if (v3) r.skip(2);
  const senderPrefix = r.take(PUB_KEY_PREFIX_SIZE);
  const pathLen = hops(r.u8());
  const txtType = r.u8();
  const timestamp = r.u32();
  const signerPrefix = txtType === TxtType.SignedPlain ? r.take(4) : null;
  return {
    kind: "contactMessage",
    snr: snrValue,
    senderPrefix,
    pathLen,
    txtType,
    timestamp,
    signerPrefix,
    text: r.restString(),
  };
}

function readChannelMessage(r: ByteReader, v3: boolean): ResponseFrame {
  const snrValue = v3 ? snr(r.i8()) : null;
  if (v3) r.skip(2);
  const channelIndex = r.u8();
  const pathLen = hops(r.u8());
  const txtType = r.u8();
  const timestamp = r.u32();
  return { kind: "channelMessage", snr: snrValue, channelIndex, pathLen, txtType, timestamp, text: r.restString() };
}

function decodeResponse(code: number, r: ByteReader): ResponseFrame | null {
  switch (code) {
    case Resp.Ok:
      return { kind: "ok" };
    case Resp.Err:
      return { kind: "err", code: r.remaining ? r.u8() : 0 };
    case Resp.ContactsStart:
      return { kind: "contactsStart", count: r.u32() };
    case Resp.Contact:
      return { kind: "contact", contact: readContact(r) };
    case Resp.EndOfContacts:
      return { kind: "endOfContacts", mostRecentLastMod: r.remaining >= 4 ? r.u32() : 0 };
    case Resp.SelfInfo:
      return { kind: "selfInfo", info: readSelfInfo(r) };
    case Resp.Sent:
      return { kind: "sent", flood: r.u8() === 1, ackTag: r.u32(), estTimeoutMs: r.u32() };
    case Resp.ContactMsgRecv:
      return readContactMessage(r, false);
    case Resp.ContactMsgRecvV3:
      return readContactMessage(r, true);
    case Resp.ChannelMsgRecv:
      return readChannelMessage(r, false);
    case Resp.ChannelMsgRecvV3:
      return readChannelMessage(r, true);
    case Resp.ChannelDataRecv: {
      const snrValue = snr(r.i8());
      r.skip(2);
      const channelIndex = r.u8();
      const pathLen = hops(r.u8());
      const dataType = r.u16();
      const length = r.u8();
      return { kind: "channelData", snr: snrValue, channelIndex, pathLen, dataType, data: r.take(Math.min(length, r.remaining)) };
    }
    case Resp.CurrTime:
      return { kind: "currTime", time: r.u32() };
    case Resp.NoMoreMessages:
      return { kind: "noMoreMessages" };
    case Resp.ExportContact:
      return { kind: "exportContact", advert: r.rest() };
    case Resp.BattAndStorage:
      return { kind: "battAndStorage", batteryMv: r.u16(), storageUsedKb: r.u32(), storageTotalKb: r.u32() };
    case Resp.DeviceInfo:
      return { kind: "deviceInfo", info: readDeviceInfo(r) };
    case Resp.PrivateKey:
      return { kind: "privateKey", key: r.rest() };
    case Resp.Disabled:
      return { kind: "disabled" };
    case Resp.ChannelInfo:
      return { kind: "channelInfo", index: r.u8(), name: r.fixedString(32), secret: r.take(16) };
    case Resp.SignStart:
      r.skip(1);
      return { kind: "signStart", maxLength: r.u32() };
    case Resp.Signature:
      return { kind: "signature", signature: r.rest() };
    case Resp.CustomVars: {
      const vars: Record<string, string> = {};
      const text = r.restString();
      if (text) {
        for (const pair of text.split(",")) {
          const at = pair.indexOf(":");
          if (at > 0) vars[pair.slice(0, at)] = pair.slice(at + 1);
        }
      }
      return { kind: "customVars", vars };
    }
    case Resp.AdvertPath: {
      const receivedAt = r.u32();
      const pathLen = r.u8();
      return { kind: "advertPath", receivedAt, pathLen, path: r.take(Math.min(pathByteLength(pathLen), r.remaining)) };
    }
    case Resp.TuningParams:
      return { kind: "tuningParams", rxDelayBase: r.u32() / 1000, airtimeFactor: r.u32() / 1000 };
    case Resp.Stats: {
      const type = r.u8();
      switch (type) {
        case StatsType.Core:
          return { kind: "statsCore", batteryMv: r.u16(), uptimeSecs: r.u32(), errFlags: r.u16(), queueLen: r.u8() };
        case StatsType.Radio:
          return {
            kind: "statsRadio",
            noiseFloor: r.i16(),
            lastRssi: r.i8(),
            lastSnr: snr(r.i8()),
            txAirSecs: r.u32(),
            rxAirSecs: r.u32(),
          };
        case StatsType.Packets:
          return {
            kind: "statsPackets",
            recv: r.u32(),
            sent: r.u32(),
            sentFlood: r.u32(),
            sentDirect: r.u32(),
            recvFlood: r.u32(),
            recvDirect: r.u32(),
            recvErrors: r.u32(),
          };
        default:
          return null;
      }
    }
    case Resp.AutoAddConfig:
      return { kind: "autoAddConfig", config: r.u8(), maxHops: r.remaining ? r.u8() : 0 };
    case Resp.AllowedRepeatFreq: {
      const ranges: { lowerKhz: number; upperKhz: number }[] = [];
      while (r.remaining >= 8) ranges.push({ lowerKhz: r.u32(), upperKhz: r.u32() });
      return { kind: "allowedRepeatFreq", ranges };
    }
    case Resp.DefaultFloodScope:
      if (r.remaining < 31 + 16) return { kind: "defaultFloodScope", name: null, key: null };
      return { kind: "defaultFloodScope", name: r.fixedString(31), key: r.take(16) };
    case Resp.CliReply:
      return { kind: "cliReply", text: r.restString() };
    default:
      return null;
  }
}

function decodePush(code: number, r: ByteReader): PushFrame | null {
  switch (code) {
    case Push.Advert:
      return { kind: "advert", publicKey: r.take(PUB_KEY_SIZE) };
    case Push.PathUpdated:
      return { kind: "pathUpdated", publicKey: r.take(PUB_KEY_SIZE) };
    case Push.SendConfirmed:
      return { kind: "sendConfirmed", ackTag: r.u32(), roundTripMs: r.u32() };
    case Push.MsgWaiting:
      return { kind: "msgWaiting" };
    case Push.Mirror: {
      const length = r.u8();
      return { kind: "mirror", command: r.take(length), answer: r.rest() };
    }
    case Push.RawData: {
      const snrValue = snr(r.i8());
      const rssi = r.i8();
      r.skip(1);
      return { kind: "rawData", snr: snrValue, rssi, payload: r.rest() };
    }
    case Push.LoginSuccess: {
      const adminFlag = r.u8();
      const prefix = r.take(PUB_KEY_PREFIX_SIZE);
      const serverTime = r.remaining >= 4 ? r.u32() : null;
      const permissions = r.remaining >= 1 ? r.u8() : null;
      const firmwareLevel = r.remaining >= 1 ? r.u8() : null;
      return { kind: "loginSuccess", adminFlag, prefix, serverTime, permissions, firmwareLevel };
    }
    case Push.LoginFail:
      r.skip(1);
      return { kind: "loginFail", prefix: r.take(PUB_KEY_PREFIX_SIZE) };
    case Push.StatusResponse: {
      r.skip(1);
      const prefix = r.take(PUB_KEY_PREFIX_SIZE);
      return { kind: "statusResponse", prefix, raw: r.rest() };
    }
    case Push.LogRxData:
      return { kind: "logRxData", snr: snr(r.i8()), rssi: r.i8(), raw: r.rest() };
    case Push.TraceData: {
      r.skip(1);
      const pathLen = r.u8();
      const flags = r.u8();
      const tag = r.u32();
      const auth = r.u32();
      const hashes = r.take(Math.min(pathLen, r.remaining));
      const snrs: number[] = [];
      const count = pathLen >> (flags & 0x03);
      for (let i = 0; i < count && r.remaining > 0; i++) snrs.push(snr(r.i8()));
      if (r.remaining > 0) snrs.push(snr(r.i8()));
      return { kind: "traceData", flags, tag, auth, hashes, snrs };
    }
    case Push.NewAdvert:
      return { kind: "newAdvert", contact: readContact(r) };
    case Push.TelemetryResponse: {
      r.skip(1);
      const prefix = r.take(PUB_KEY_PREFIX_SIZE);
      const raw = r.rest();
      return { kind: "telemetryResponse", prefix, readings: decodeLpp(raw), raw };
    }
    case Push.BinaryResponse:
      r.skip(1);
      return { kind: "binaryResponse", tag: r.u32(), data: r.rest() };
    case Push.PathDiscoveryResponse: {
      r.skip(1);
      const prefix = r.take(PUB_KEY_PREFIX_SIZE);
      const outPathLen = r.u8();
      const outPath = r.take(Math.min(pathByteLength(outPathLen), r.remaining));
      const inPathLen = r.u8();
      const inPath = r.take(Math.min(pathByteLength(inPathLen), r.remaining));
      return { kind: "pathDiscoveryResponse", prefix, outPathLen, outPath, inPathLen, inPath };
    }
    case Push.ControlData:
      return { kind: "controlData", snr: snr(r.i8()), rssi: r.i8(), pathLen: r.u8(), payload: r.rest() };
    case Push.ContactDeleted:
      return { kind: "contactDeleted", publicKey: r.take(PUB_KEY_SIZE) };
    case Push.ContactsFull:
      return { kind: "contactsFull" };
    default:
      return null;
  }
}

export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length === 0) return { kind: "unknown", code: -1, raw: bytes };
  const code = bytes[0]!;
  const r = new ByteReader(bytes);
  r.pos = 1;
  try {
    const frame = code >= 0x80 ? decodePush(code, r) : decodeResponse(code, r);
    return frame ?? { kind: "unknown", code, raw: bytes.slice() };
  } catch {
    // Shorter than its layout says: a truncated frame, or a layout this
    // client has wrong. Either way it is reported, not thrown.
    return { kind: "unknown", code, raw: bytes.slice() };
  }
}
