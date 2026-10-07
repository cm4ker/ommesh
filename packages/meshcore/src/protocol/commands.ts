/**
 * Builders for every command the companion firmware handles. Each returns the
 * bare frame; the transport wraps it (serial) or writes it whole (BLE).
 *
 * Layouts are the firmware's `handleCmdFrame`, byte for byte.
 */

import { ByteWriter, unixNow, utf8 } from "./bytes.js";
import {
  APP_PROTOCOL_VERSION,
  Cmd,
  ControlType,
  MAX_PASSWORD_LEN,
  MAX_PATH_SIZE,
  MAX_TEXT_LEN,
  OUT_PATH_UNKNOWN,
  PUB_KEY_PREFIX_SIZE,
  PUB_KEY_SIZE,
  ReqType,
  TxtType,
} from "./codes.js";

function key(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== PUB_KEY_SIZE) {
    throw new Error(`a public key is ${PUB_KEY_SIZE} bytes, got ${publicKey.length}`);
  }
  return publicKey;
}

function prefix(p: Uint8Array): Uint8Array {
  if (p.length < PUB_KEY_PREFIX_SIZE) {
    throw new Error(`a key prefix is ${PUB_KEY_PREFIX_SIZE} bytes, got ${p.length}`);
  }
  return p.subarray(0, PUB_KEY_PREFIX_SIZE);
}

/** Text the firmware will take whole. Longer is truncated on the radio, silently. */
export function assertTextFits(text: string, reserve = 0): Uint8Array {
  const bytes = utf8(text);
  if (bytes.length + reserve > MAX_TEXT_LEN) {
    throw new Error(`message is ${bytes.length} bytes; the radio carries at most ${MAX_TEXT_LEN - reserve}`);
  }
  return bytes;
}

/** Sent first, so the firmware knows which frame versions to use. */
export function deviceQuery(appVersion = APP_PROTOCOL_VERSION): Uint8Array {
  return new ByteWriter().u8(Cmd.DeviceQuery).u8(appVersion).toBytes();
}

/** Sent second; answered with `selfInfo`. */
export function appStart(appName: string): Uint8Array {
  return new ByteWriter().u8(Cmd.AppStart).zeros(7).string(appName).toBytes();
}

export function sendTextMessage(
  recipientPrefix: Uint8Array,
  text: string,
  options: { txtType?: number; attempt?: number; timestamp?: number } = {},
): Uint8Array {
  return new ByteWriter()
    .u8(Cmd.SendTxtMsg)
    .u8(options.txtType ?? TxtType.Plain)
    .u8(options.attempt ?? 0)
    .u32(options.timestamp ?? unixNow())
    .bytes(prefix(recipientPrefix))
    .bytes(assertTextFits(text))
    .toBytes();
}

/**
 * A channel message carries `<name>: ` before the text on the air, so the
 * room for the text is what the name leaves. `senderName` is only for that
 * arithmetic: the firmware adds the prefix itself.
 */
export function sendChannelTextMessage(
  channelIndex: number,
  text: string,
  options: { timestamp?: number; senderName?: string } = {},
): Uint8Array {
  const reserve = options.senderName ? utf8(options.senderName).length + 2 : 0;
  return new ByteWriter()
    .u8(Cmd.SendChannelTxtMsg)
    .u8(TxtType.Plain)
    .u8(channelIndex)
    .u32(options.timestamp ?? unixNow())
    .bytes(assertTextFits(text, reserve))
    .toBytes();
}

/** With `since`, only contacts modified after that time come back. */
export function getContacts(since?: number): Uint8Array {
  const w = new ByteWriter().u8(Cmd.GetContacts);
  if (since !== undefined) w.u32(since);
  return w.toBytes();
}

export function getDeviceTime(): Uint8Array {
  return new ByteWriter().u8(Cmd.GetDeviceTime).toBytes();
}

/** Refused with `illegal argument` when it would turn the clock back. */
export function setDeviceTime(unixSeconds = unixNow()): Uint8Array {
  return new ByteWriter().u8(Cmd.SetDeviceTime).u32(unixSeconds).toBytes();
}

export function sendSelfAdvert(flood = false): Uint8Array {
  return new ByteWriter().u8(Cmd.SendSelfAdvert).u8(flood ? 1 : 0).toBytes();
}

export function setAdvertName(name: string): Uint8Array {
  return new ByteWriter().u8(Cmd.SetAdvertName).string(name).toBytes();
}

export function setAdvertLatLon(lat: number, lon: number): Uint8Array {
  return new ByteWriter()
    .u8(Cmd.SetAdvertLatLon)
    .i32(Math.round(lat * 1e6))
    .i32(Math.round(lon * 1e6))
    .toBytes();
}

export interface ContactRecordInput {
  publicKey: Uint8Array;
  type: number;
  flags: number;
  /** `0xff` when unknown. */
  outPathLen: number;
  outPath: Uint8Array;
  name: string;
  lastAdvert: number;
  lat: number;
  lon: number;
  /** Omit to let the radio stamp it with its own clock. */
  lastMod?: number;
}

/** Adds a contact, or rewrites one whose key the radio already holds. */
export function addUpdateContact(c: ContactRecordInput): Uint8Array {
  const path = new Uint8Array(MAX_PATH_SIZE);
  path.set(c.outPath.subarray(0, MAX_PATH_SIZE));
  const w = new ByteWriter()
    .u8(Cmd.AddUpdateContact)
    .bytes(key(c.publicKey))
    .u8(c.type)
    .u8(c.flags)
    .u8(c.outPathLen)
    .bytes(path)
    .fixedString(c.name, 32)
    .u32(c.lastAdvert)
    .i32(Math.round(c.lat * 1e6))
    .i32(Math.round(c.lon * 1e6));
  if (c.lastMod !== undefined) w.u32(c.lastMod);
  return w.toBytes();
}

export function removeContact(publicKey: Uint8Array): Uint8Array {
  return new ByteWriter().u8(Cmd.RemoveContact).bytes(key(publicKey)).toBytes();
}

/** Forgets the route to a contact, so the next message floods and learns a new one. */
export function resetPath(publicKey: Uint8Array): Uint8Array {
  return new ByteWriter().u8(Cmd.ResetPath).bytes(key(publicKey)).toBytes();
}

/** Re-broadcasts a contact's advert, zero-hop, for the radios in earshot. */
export function shareContact(publicKey: Uint8Array): Uint8Array {
  return new ByteWriter().u8(Cmd.ShareContact).bytes(key(publicKey)).toBytes();
}

export function getContactByKey(publicKey: Uint8Array): Uint8Array {
  return new ByteWriter().u8(Cmd.GetContactByKey).bytes(key(publicKey)).toBytes();
}

/** Without a key, exports the radio's own advert. */
export function exportContact(publicKey?: Uint8Array): Uint8Array {
  const w = new ByteWriter().u8(Cmd.ExportContact);
  if (publicKey) w.bytes(key(publicKey));
  return w.toBytes();
}

/** The bytes an `exportContact` answer carried, or a `meshcore://` link decoded. */
export function importContact(advert: Uint8Array): Uint8Array {
  return new ByteWriter().u8(Cmd.ImportContact).bytes(advert).toBytes();
}

export function syncNextMessage(): Uint8Array {
  return new ByteWriter().u8(Cmd.SyncNextMessage).toBytes();
}

export interface RadioParams {
  /** kHz. */
  frequencyKhz: number;
  /** Hz. */
  bandwidthHz: number;
  spreadingFactor: number;
  codingRate: number;
  /** Firmware 9+: whether this node repeats. Refused on frequencies where clients may not. */
  repeat?: boolean;
}

export function setRadioParams(p: RadioParams): Uint8Array {
  const w = new ByteWriter()
    .u8(Cmd.SetRadioParams)
    .u32(Math.round(p.frequencyKhz))
    .u32(Math.round(p.bandwidthHz))
    .u8(p.spreadingFactor)
    .u8(p.codingRate);
  if (p.repeat !== undefined) w.u8(p.repeat ? 1 : 0);
  return w.toBytes();
}

export function setRadioTxPower(dbm: number): Uint8Array {
  return new ByteWriter().u8(Cmd.SetRadioTxPower).i8(dbm).toBytes();
}

export function getTuningParams(): Uint8Array {
  return new ByteWriter().u8(Cmd.GetTuningParams).toBytes();
}

export function setTuningParams(rxDelayBase: number, airtimeFactor: number): Uint8Array {
  return new ByteWriter()
    .u8(Cmd.SetTuningParams)
    .u32(Math.round(rxDelayBase * 1000))
    .u32(Math.round(airtimeFactor * 1000))
    .toBytes();
}

export interface OtherParams {
  manualAddContacts: number;
  telemetryModeBase: number;
  telemetryModeLocation: number;
  telemetryModeEnvironment: number;
  advertLocPolicy: number;
  multiAcks: number;
}

export function setOtherParams(p: OtherParams): Uint8Array {
  const modes =
    (p.telemetryModeEnvironment << 4) | (p.telemetryModeLocation << 2) | (p.telemetryModeBase & 0x03);
  return new ByteWriter()
    .u8(Cmd.SetOtherParams)
    .u8(p.manualAddContacts)
    .u8(modes)
    .u8(p.advertLocPolicy)
    .u8(p.multiAcks)
    .toBytes();
}

export function setPathHashMode(mode: number): Uint8Array {
  return new ByteWriter().u8(Cmd.SetPathHashMode).u8(0).u8(mode).toBytes();
}

/** The radio answers nothing: it reboots. */
export function reboot(): Uint8Array {
  return new ByteWriter().u8(Cmd.Reboot).string("reboot").toBytes();
}

/** Wipes the file system and reboots. The OK, if any, arrives just before the link drops. */
export function factoryReset(): Uint8Array {
  return new ByteWriter().u8(Cmd.FactoryReset).string("reset").toBytes();
}

export function getBattAndStorage(): Uint8Array {
  return new ByteWriter().u8(Cmd.GetBattAndStorage).toBytes();
}

export function getChannel(index: number): Uint8Array {
  return new ByteWriter().u8(Cmd.GetChannel).u8(index).toBytes();
}

/** A 16-byte secret; the firmware supports only 128-bit channel keys. */
export function setChannel(index: number, name: string, secret: Uint8Array): Uint8Array {
  if (secret.length !== 16) throw new Error(`a channel secret is 16 bytes, got ${secret.length}`);
  return new ByteWriter().u8(Cmd.SetChannel).u8(index).fixedString(name, 32).bytes(secret).toBytes();
}

export function sendLogin(publicKey: Uint8Array, password: string): Uint8Array {
  const bytes = utf8(password);
  if (bytes.length > MAX_PASSWORD_LEN) {
    throw new Error(`a password is at most ${MAX_PASSWORD_LEN} bytes; the node would only check the first ${MAX_PASSWORD_LEN}`);
  }
  return new ByteWriter().u8(Cmd.SendLogin).bytes(key(publicKey)).bytes(bytes).toBytes();
}

/**
 * A console command for a repeater, room or sensor. It carries the stamp
 * given here, this clock's by default, and expects no ack; the answer comes
 * back as a contact message of type `CliData`. The node carries out a command
 * only if its stamp is past the last one it had from us, and answers one with
 * the same stamp as a repeat, with nothing.
 */
export function sendCliCommand(recipientPrefix: Uint8Array, text: string, timestamp?: number): Uint8Array {
  return sendTextMessage(recipientPrefix, text, { txtType: TxtType.CliData, ...(timestamp === undefined ? {} : { timestamp }) });
}

function random4(): Uint8Array {
  const out = new Uint8Array(4);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/**
 * `GetNeighbours`, version 0: a page of the repeaters this one hears direct.
 * The answer holds as many as fit in 130 bytes, so eleven with six-byte
 * prefixes. The random tail keeps two identical requests from looking like
 * one packet to the mesh.
 */
export function neighboursRequest(
  options: { count?: number; offset?: number; order?: number; prefixLength?: number; random?: Uint8Array } = {},
): Uint8Array {
  return new ByteWriter()
    .u8(ReqType.GetNeighbours)
    .u8(0)
    .u8(options.count ?? 10)
    .u16(options.offset ?? 0)
    .u8(options.order ?? 0)
    .u8(options.prefixLength ?? PUB_KEY_PREFIX_SIZE)
    .bytes(options.random ?? random4())
    .toBytes();
}

/** `GetAccessList`; the two zero bytes are reserved query parameters the node insists on. */
export function accessListRequest(): Uint8Array {
  return new ByteWriter().u8(ReqType.GetAccessList).u8(0).u8(0).toBytes();
}

export function ownerInfoRequest(): Uint8Array {
  return new ByteWriter().u8(ReqType.GetOwnerInfo).toBytes();
}

/** A sensor's min, max and mean for each series over one window, given as seconds ago. */
export function avgMinMaxRequest(startSecsAgo: number, endSecsAgo = 0): Uint8Array {
  return new ByteWriter().u8(ReqType.GetAvgMinMax).u32(startSecsAgo).u32(endSecsAgo).u8(0).u8(0).toBytes();
}

export function logout(publicKey: Uint8Array): Uint8Array {
  return new ByteWriter().u8(Cmd.Logout).bytes(key(publicKey)).toBytes();
}

export function hasConnection(publicKey: Uint8Array): Uint8Array {
  return new ByteWriter().u8(Cmd.HasConnection).bytes(key(publicKey)).toBytes();
}

export function sendStatusReq(publicKey: Uint8Array): Uint8Array {
  return new ByteWriter().u8(Cmd.SendStatusReq).bytes(key(publicKey)).toBytes();
}

/** With no key, the radio reports its own sensors, at once, as a push. */
export function sendTelemetryReq(publicKey?: Uint8Array): Uint8Array {
  const w = new ByteWriter().u8(Cmd.SendTelemetryReq).zeros(3);
  if (publicKey) w.bytes(key(publicKey));
  return w.toBytes();
}

export function sendBinaryReq(publicKey: Uint8Array, request: Uint8Array): Uint8Array {
  return new ByteWriter().u8(Cmd.SendBinaryReq).bytes(key(publicKey)).bytes(request).toBytes();
}

/**
 * A trace along an explicit path of node hashes. `flags & 3` is the hash size
 * class; with the default of one-byte hashes the path is one byte per hop.
 */
export function sendTracePath(tag: number, auth: number, flags: number, path: Uint8Array): Uint8Array {
  return new ByteWriter().u8(Cmd.SendTracePath).u32(tag).u32(auth).u8(flags).bytes(path).toBytes();
}

export function sendPathDiscoveryReq(publicKey: Uint8Array): Uint8Array {
  return new ByteWriter().u8(Cmd.SendPathDiscoveryReq).u8(0).bytes(key(publicKey)).toBytes();
}

export function getStats(type: number): Uint8Array {
  return new ByteWriter().u8(Cmd.GetStats).u8(type).toBytes();
}

/** A zero-hop control packet; the firmware sends only payloads whose first byte has its top bit set. */
export function sendControlData(payload: Uint8Array): Uint8Array {
  return new ByteWriter().u8(Cmd.SendControlData).bytes(payload).toBytes();
}

/**
 * Asks the nodes in direct range to say how well they heard this one.
 * `filter` has a bit per `AdvType` (repeaters are `1 << AdvType.Repeater`);
 * `since` skips nodes whose settings have not changed since that unix time.
 * They answer with their whole key unless `prefixOnly` asks for eight bytes.
 */
export function nodeDiscoverRequest(tag: number, filter: number, options: { prefixOnly?: boolean; since?: number } = {}): Uint8Array {
  return new ByteWriter()
    .u8(ControlType.NodeDiscoverReq | (options.prefixOnly ? 1 : 0))
    .u8(filter)
    .u32(tag)
    .u32(options.since ?? 0)
    .toBytes();
}

/** The inbound path the last advert from this contact took, if the radio still has it. */
export function getAdvertPath(publicKey: Uint8Array): Uint8Array {
  return new ByteWriter().u8(Cmd.GetAdvertPath).u8(0).bytes(key(publicKey)).toBytes();
}

/** Zero clears the PIN; otherwise six digits. */
export function setDevicePin(pin: number): Uint8Array {
  return new ByteWriter().u8(Cmd.SetDevicePin).u32(pin).toBytes();
}

export function getCustomVars(): Uint8Array {
  return new ByteWriter().u8(Cmd.GetCustomVars).toBytes();
}

/** A console line for this radio itself (v14), as typed: the radio answers with `CliReply`. */
export function runCliCommand(text: string): Uint8Array {
  return new ByteWriter().u8(Cmd.RunCliCommand).string(text).toBytes();
}

export function setCustomVar(name: string, value: string): Uint8Array {
  return new ByteWriter().u8(Cmd.SetCustomVar).string(`${name}:${value}`).toBytes();
}

export function setAutoAddConfig(config: number, maxHops?: number): Uint8Array {
  const w = new ByteWriter().u8(Cmd.SetAutoAddConfig).u8(config);
  if (maxHops !== undefined) w.u8(maxHops);
  return w.toBytes();
}

export function getAutoAddConfig(): Uint8Array {
  return new ByteWriter().u8(Cmd.GetAutoAddConfig).toBytes();
}

export function getAllowedRepeatFreq(): Uint8Array {
  return new ByteWriter().u8(Cmd.GetAllowedRepeatFreq).toBytes();
}

/** A raw datagram down an explicit path. Flooding is not offered by the firmware. */
export function sendRawData(path: Uint8Array, payload: Uint8Array): Uint8Array {
  if (payload.length < 4) throw new Error("a raw payload is at least 4 bytes");
  return new ByteWriter().u8(Cmd.SendRawData).u8(path.length).bytes(path).bytes(payload).toBytes();
}

export function sendChannelData(
  channelIndex: number,
  dataType: number,
  payload: Uint8Array,
  path?: Uint8Array,
): Uint8Array {
  const w = new ByteWriter().u8(Cmd.SendChannelData).u8(channelIndex);
  if (path) {
    w.u8(path.length).bytes(path);
  } else {
    w.u8(OUT_PATH_UNKNOWN);
  }
  return w.u16(dataType).bytes(payload).toBytes();
}

export function exportPrivateKey(): Uint8Array {
  return new ByteWriter().u8(Cmd.ExportPrivateKey).toBytes();
}

export function importPrivateKey(privateKey: Uint8Array): Uint8Array {
  if (privateKey.length !== 64) throw new Error(`a private key is 64 bytes, got ${privateKey.length}`);
  return new ByteWriter().u8(Cmd.ImportPrivateKey).bytes(privateKey).toBytes();
}
