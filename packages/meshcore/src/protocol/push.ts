/**
 * Readings a sensor sends by itself (MeshCore 1.18, `simple_sensor`): the app
 * asks once (`ReqType.Subscribe`), naming a tag and, per reading, how far it
 * must move to be worth a packet; the sensor then looks once a minute and
 * sends its whole telemetry, under that tag, whenever one moved past its
 * threshold, until the time it was given runs out.
 *
 * The thresholds go as Cayenne LPP, as the sensor reads them back
 * (`LPPData::getFloat`): a channel, a type, and the threshold in the type's
 * width and scale, big-endian. The sensor keeps 14 bytes of them.
 */

import { ByteReader, ByteWriter } from "./bytes.js";
import { ReqType } from "./codes.js";
import { decodeLpp, type LppReading } from "./lpp.js";

/** The readings a threshold can be set on: one number each, in one or two bytes. */
export type PushableType = "temperature" | "humidity" | "barometer" | "voltage" | "current" | "luminosity" | "analogIn" | "altitude" | "power" | "concentration" | "percentage";

const SPEC: Record<PushableType, { code: number; size: 1 | 2; mult: number }> = {
  temperature: { code: 103, size: 2, mult: 10 },
  humidity: { code: 104, size: 1, mult: 2 },
  barometer: { code: 115, size: 2, mult: 10 },
  voltage: { code: 116, size: 2, mult: 100 },
  current: { code: 117, size: 2, mult: 1000 },
  luminosity: { code: 101, size: 2, mult: 1 },
  analogIn: { code: 2, size: 2, mult: 100 },
  altitude: { code: 121, size: 2, mult: 1 },
  power: { code: 128, size: 2, mult: 1 },
  concentration: { code: 125, size: 2, mult: 1 },
  percentage: { code: 120, size: 1, mult: 1 },
};

/** The bytes a sensor keeps for thresholds (`min_deltas[14]`). */
export const PUSH_THRESHOLD_BYTES = 14;

/** The longest a sensor is asked to keep sending, seconds: the request carries it in two bytes. */
export const PUSH_MAX_SECS = 0xffff;

/** How far a reading must move for the sensor to send, on one reading of one channel. */
export interface PushThreshold {
  channel: number;
  type: PushableType;
  /** In the reading's own unit: °C, %, hPa, V, A, lx, m, W, ppm. */
  delta: number;
}

export function isPushable(type: string): type is PushableType {
  return type in SPEC;
}

/** The bytes one threshold takes of the sensor's fourteen. */
export function thresholdBytes(type: PushableType): number {
  return 2 + SPEC[type].size;
}

/** A reading's number, for a type a threshold can be set on. */
export function readingValue(reading: LppReading): number | null {
  switch (reading.type) {
    case "temperature":
      return reading.celsius;
    case "humidity":
      return reading.percent;
    case "barometer":
      return reading.hpa;
    case "voltage":
      return reading.volts;
    case "current":
      return reading.amps;
    case "luminosity":
      return reading.lux;
    case "analogIn":
      return reading.value;
    case "altitude":
      return reading.meters;
    case "power":
      return reading.watts;
    case "concentration":
      return reading.ppm;
    case "percentage":
      return reading.percent;
    default:
      return null;
  }
}

export function encodeThresholds(thresholds: PushThreshold[]): Uint8Array {
  const w = new ByteWriter();
  let size = 0;
  for (const t of thresholds) {
    const spec = SPEC[t.type];
    size += 2 + spec.size;
    if (size > PUSH_THRESHOLD_BYTES) throw new Error(`thresholds take at most ${PUSH_THRESHOLD_BYTES} bytes`);
    const max = spec.size === 1 ? 0xff : 0x7fff;
    const value = Math.min(max, Math.max(0, Math.round(t.delta * spec.mult)));
    w.u8(t.channel).u8(spec.code);
    if (spec.size === 1) w.u8(value);
    else w.u8(value >> 8).u8(value & 0xff);
  }
  return w.toBytes();
}

/** Asks a sensor to send its readings by itself under `tag` for `timeoutSecs`, when one moves past its threshold. */
export function subscribeRequest(tag: number, timeoutSecs: number, thresholds: PushThreshold[]): Uint8Array {
  const deltas = encodeThresholds(thresholds);
  if (deltas.length < 3) throw new Error("a sensor needs a threshold on at least one reading");
  return new ByteWriter()
    .u8(ReqType.Subscribe)
    .u32(tag)
    .u16(Math.min(PUSH_MAX_SECS, Math.max(1, Math.round(timeoutSecs))))
    .u8(0)
    .u8(deltas.length)
    .bytes(deltas)
    .toBytes();
}

/** Stops what `subscribeRequest` started. */
export function unsubscribeRequest(): Uint8Array {
  return new ByteWriter().u8(ReqType.Unsubscribe).toBytes();
}

/**
 * The sensor's answer to a subscribe, after its tag: the seconds it will send
 * for, 0 when it will not (it has no region to send under), then the region.
 */
export function readSubscribeAnswer(data: Uint8Array): { secs: number; region: string | null } {
  const r = new ByteReader(data);
  const secs = r.remaining >= 2 ? r.u16() : 0;
  if (r.remaining >= 2) r.u16();
  const name = new TextDecoder().decode(r.rest()).replace(/\0[\s\S]*$/, "").trim();
  return { secs, region: name || null };
}

/** What a sensor sent by itself, after its tag: its clock, then its whole telemetry. */
export function readPushed(data: Uint8Array): { time: number; readings: LppReading[] } {
  const r = new ByteReader(data);
  const time = r.u32();
  return { time, readings: decodeLpp(r.rest()) };
}
