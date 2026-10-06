/**
 * The MeshCore Companion Radio Protocol, as the firmware speaks it.
 *
 * Every number here is copied from `examples/companion_radio/MyMesh.cpp` in the
 * MeshCore firmware tree, which is the only specification that cannot be out of
 * date. The wiki page of the same name lags it by a version or two.
 */

export const PUB_KEY_SIZE = 32;
/** A contact is named on the wire by the first six bytes of its key. */
export const PUB_KEY_PREFIX_SIZE = 6;
export const MAX_PATH_SIZE = 64;
/** The largest frame either side will accept. Longer ones are truncated by the firmware. */
export const MAX_FRAME_SIZE = 176;
/** `10 * CIPHER_BLOCK_SIZE`: the longest text a packet carries, in bytes, name prefix included on a channel. */
export const MAX_TEXT_LEN = 160;
/**
 * The longest text this client puts in a direct message. From the fifth
 * attempt the firmware hides the attempt number in two bytes after the text,
 * and refuses a text with no room for them (`composeMsgPacket`); at this
 * length every attempt is a packet of its own.
 */
export const DIRECT_TEXT_LEN = MAX_TEXT_LEN - 2;
export const OUT_PATH_UNKNOWN = 0xff;
/**
 * The protocol version this client claims in `CMD_DEVICE_QUERY`. Three is where
 * the message frames grew an SNR byte; nothing above it changes what the
 * firmware sends, only what it accepts, so claiming more buys nothing.
 */
export const APP_PROTOCOL_VERSION = 3;

/** App → radio. */
export const Cmd = {
  AppStart: 1,
  SendTxtMsg: 2,
  SendChannelTxtMsg: 3,
  GetContacts: 4,
  GetDeviceTime: 5,
  SetDeviceTime: 6,
  SendSelfAdvert: 7,
  SetAdvertName: 8,
  AddUpdateContact: 9,
  SyncNextMessage: 10,
  SetRadioParams: 11,
  SetRadioTxPower: 12,
  ResetPath: 13,
  SetAdvertLatLon: 14,
  RemoveContact: 15,
  ShareContact: 16,
  ExportContact: 17,
  ImportContact: 18,
  Reboot: 19,
  GetBattAndStorage: 20,
  SetTuningParams: 21,
  DeviceQuery: 22,
  ExportPrivateKey: 23,
  ImportPrivateKey: 24,
  SendRawData: 25,
  SendLogin: 26,
  SendStatusReq: 27,
  HasConnection: 28,
  Logout: 29,
  GetContactByKey: 30,
  GetChannel: 31,
  SetChannel: 32,
  SignStart: 33,
  SignData: 34,
  SignFinish: 35,
  SendTracePath: 36,
  SetDevicePin: 37,
  SetOtherParams: 38,
  SendTelemetryReq: 39,
  GetCustomVars: 40,
  SetCustomVar: 41,
  GetAdvertPath: 42,
  GetTuningParams: 43,
  SendBinaryReq: 50,
  FactoryReset: 51,
  SendPathDiscoveryReq: 52,
  SetFloodScopeKey: 54,
  SendControlData: 55,
  GetStats: 56,
  SendAnonReq: 57,
  SetAutoAddConfig: 58,
  GetAutoAddConfig: 59,
  GetAllowedRepeatFreq: 60,
  SetPathHashMode: 61,
  SendChannelData: 62,
  SetDefaultFloodScope: 63,
  GetDefaultFloodScope: 64,
  SendRawPacket: 65,
} as const;

/** Radio → app, in answer to a command. Always below 0x80. */
export const Resp = {
  Ok: 0,
  Err: 1,
  ContactsStart: 2,
  Contact: 3,
  EndOfContacts: 4,
  SelfInfo: 5,
  Sent: 6,
  ContactMsgRecv: 7,
  ChannelMsgRecv: 8,
  CurrTime: 9,
  NoMoreMessages: 10,
  ExportContact: 11,
  BattAndStorage: 12,
  DeviceInfo: 13,
  PrivateKey: 14,
  Disabled: 15,
  ContactMsgRecvV3: 16,
  ChannelMsgRecvV3: 17,
  ChannelInfo: 18,
  SignStart: 19,
  Signature: 20,
  CustomVars: 21,
  AdvertPath: 22,
  TuningParams: 23,
  Stats: 24,
  AutoAddConfig: 25,
  AllowedRepeatFreq: 26,
  ChannelDataRecv: 27,
  DefaultFloodScope: 28,
} as const;

/** Radio → app, unprompted. Always 0x80 and above, which is how they are told apart. */
export const Push = {
  Advert: 0x80,
  PathUpdated: 0x81,
  SendConfirmed: 0x82,
  MsgWaiting: 0x83,
  RawData: 0x84,
  LoginSuccess: 0x85,
  LoginFail: 0x86,
  StatusResponse: 0x87,
  LogRxData: 0x88,
  TraceData: 0x89,
  NewAdvert: 0x8a,
  TelemetryResponse: 0x8b,
  BinaryResponse: 0x8c,
  PathDiscoveryResponse: 0x8d,
  ControlData: 0x8e,
  ContactDeleted: 0x8f,
  ContactsFull: 0x90,
  /**
   * Not the firmware's: the phone's relay (`MeshRelayMux.swift`) sends it when
   * the other app sharing the radio sent a text. The command as written, then
   * the radio's answer: `0xf0`, the command's length, the command, the answer.
   */
  Mirror: 0xf0,
} as const;

export function isPushCode(code: number): boolean {
  return code >= 0x80;
}

export const ErrCode = {
  UnsupportedCmd: 1,
  NotFound: 2,
  TableFull: 3,
  BadState: 4,
  FileIoError: 5,
  IllegalArg: 6,
} as const;

export function errorName(code: number): string {
  switch (code) {
    case ErrCode.UnsupportedCmd:
      return "unsupported command";
    case ErrCode.NotFound:
      return "not found";
    case ErrCode.TableFull:
      return "table full";
    case ErrCode.BadState:
      return "bad state";
    case ErrCode.FileIoError:
      return "file I/O error";
    case ErrCode.IllegalArg:
      return "illegal argument";
    default:
      return `error ${code}`;
  }
}

export const TxtType = {
  Plain: 0,
  CliData: 1,
  SignedPlain: 2,
} as const;

export const AdvType = {
  None: 0,
  Chat: 1,
  Repeater: 2,
  Room: 3,
  Sensor: 4,
} as const;

export const StatsType = {
  Core: 0,
  Radio: 1,
  Packets: 2,
} as const;

/** The upper four bits of a zero-hop control packet's first byte (`CTL_TYPE_*`). */
export const ControlType = {
  /** Who hears me: the low bit asks for key prefixes only. */
  NodeDiscoverReq: 0x80,
  /** The answer; the low four bits are the node's `AdvType`. */
  NodeDiscoverResp: 0x90,
} as const;

export const TelemMode = {
  Deny: 0,
  AllowFlags: 1,
  AllowAll: 2,
} as const;

export const AdvertLocPolicy = {
  None: 0,
  Share: 1,
  Prefs: 2,
} as const;

/**
 * `ContactInfo.flags`. The low bit is the favourite mark; the firmware shifts
 * the rest down by one and reads them as `TELEM_PERM_*`, so the telemetry
 * permissions a contact is granted sit one bit up from where the sensor code
 * names them.
 */
export const ContactFlag = {
  Favourite: 0x01,
  TelemetryBase: 0x02,
  TelemetryLocation: 0x04,
  TelemetryEnvironment: 0x08,
} as const;

export const AutoAdd = {
  OverwriteOldest: 0x01,
  Chat: 0x02,
  Repeater: 0x04,
  Room: 0x08,
  Sensor: 0x10,
} as const;

/**
 * The first byte of a request to a repeater, room or sensor
 * (`CMD_SEND_BINARY_REQ`). Which of them a node answers depends on what it
 * is: `examples/simple_repeater`, `simple_room_server` and `simple_sensor`.
 */
export const ReqType = {
  GetStatus: 0x01,
  KeepAlive: 0x02,
  GetTelemetryData: 0x03,
  /** Sensors only. */
  GetAvgMinMax: 0x04,
  /** Admins only. */
  GetAccessList: 0x05,
  /** Repeaters only. */
  GetNeighbours: 0x06,
  /** Repeaters only, firmware level 2 and up. */
  GetOwnerInfo: 0x07,
} as const;

/** The low two bits of a client's permissions on a repeater, room or sensor (`ClientACL.h`). */
export const AclRole = {
  Guest: 0,
  ReadOnly: 1,
  ReadWrite: 2,
  Admin: 3,
} as const;

/** How a repeater sorts its neighbour list before it pages it out. */
export const NeighbourOrder = {
  Newest: 0,
  Oldest: 1,
  Strongest: 2,
  Weakest: 3,
} as const;

/** The firmware copies at most this many bytes of a login password, and drops the rest without a word. */
export const MAX_PASSWORD_LEN = 15;

/** The Nordic UART service the firmware exposes over BLE. */
export const BLE = {
  service: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
  /** The app writes here. */
  rx: "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
  /** The firmware notifies here. */
  tx: "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
  namePrefix: "MeshCore-",
} as const;

/** The USB serial link runs at this rate on every board. */
export const SERIAL_BAUD = 115200;
