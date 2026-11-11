/**
 * The packet as it goes over the air, which the radio hands up whole on
 * `PUSH_CODE_LOG_RX_DATA`. The layout is `Packet::writeTo` in the firmware:
 * a header byte, four bytes of transport codes when the route has them, the
 * `path_len` byte, the path, and the payload to the end.
 */
import { ByteReader, pathByteLength, pathHashCount, toHex } from "./bytes.js";
import { MAX_PATH_SIZE } from "./codes.js";

/** The low two bits of the header. */
export const RouteType = {
  TransportFlood: 0,
  Flood: 1,
  Direct: 2,
  TransportDirect: 3,
} as const;

/** Bits 2..5 of the header. */
export const PayloadType = {
  Req: 0,
  Response: 1,
  TxtMsg: 2,
  Ack: 3,
  Advert: 4,
  GroupText: 5,
  GroupData: 6,
  AnonReq: 7,
  Path: 8,
  Trace: 9,
  Multipart: 10,
  Control: 11,
  RawCustom: 15,
} as const;

export interface RawPacket {
  header: number;
  routeType: number;
  payloadType: number;
  payloadVersion: number;
  /** Flooded: every repeater that hears it appends its hash and sends it on. */
  flood: boolean;
  transportCodes: [number, number] | null;
  /** The hashes of the nodes that relayed it, first relay first, each as hex. */
  path: string[];
  payload: Uint8Array;
}

/** Null when the bytes are not a packet, as `Packet::readFrom` would refuse them. */
export function parseRawPacket(raw: Uint8Array): RawPacket | null {
  if (raw.length < 2) return null;
  const header = raw[0]!;
  const routeType = header & 0x03;
  const transport = routeType === RouteType.TransportFlood || routeType === RouteType.TransportDirect;
  let i = 1;
  let transportCodes: [number, number] | null = null;
  if (transport) {
    if (raw.length < 6) return null;
    transportCodes = [raw[1]! | (raw[2]! << 8), raw[3]! | (raw[4]! << 8)];
    i = 5;
  }
  const pathLen = raw[i++]!;
  const count = pathHashCount(pathLen);
  const size = (pathLen >> 6) + 1;
  const bytes = pathByteLength(pathLen);
  if (bytes > MAX_PATH_SIZE || i + bytes >= raw.length) return null;
  const path: string[] = [];
  for (let h = 0; h < count; h++) path.push(toHex(raw.subarray(i + h * size, i + (h + 1) * size)));
  i += bytes;
  return {
    header,
    routeType,
    payloadType: (header >> 2) & 0x0f,
    payloadVersion: (header >> 6) & 0x03,
    flood: routeType === RouteType.Flood || routeType === RouteType.TransportFlood,
    transportCodes,
    path,
    payload: raw.subarray(i),
  };
}

/** What an advert says of its node, as `AdvertDataParser` in the firmware reads it. The signature is not checked. */
export interface Advert {
  key: string;
  /** The node's own clock, seconds. */
  timestamp: number;
  type: number;
  name: string;
  /** Degrees; null when the advert carries no place. */
  lat: number | null;
  lon: number | null;
}

/**
 * An advert's payload: the key, a timestamp, the signature, then a flags byte
 * whose low four bits are the kind and whose high ones say which of place,
 * two feature words and name follow. Null when it is cut short.
 */
export function parseAdvert(payload: Uint8Array): Advert | null {
  if (payload.length < 32 + 4 + 64 + 1) return null;
  const r = new ByteReader(payload);
  const key = toHex(r.take(32));
  const timestamp = r.u32();
  r.skip(64);
  const flags = r.u8();
  try {
    const place = flags & 0x10 ? { lat: r.i32() / 1e6, lon: r.i32() / 1e6 } : null;
    if (flags & 0x20) r.skip(2);
    if (flags & 0x40) r.skip(2);
    const name = flags & 0x80 ? r.restString().replace(/\0+$/, "") : "";
    return { key, timestamp, type: flags & 0x0f, name, lat: place?.lat ?? null, lon: place?.lon ?? null };
  } catch {
    return null;
  }
}
