/**
 * A serial port's own settings: the speed it is opened at and what is done
 * with its DTR and RTS lines. They are kept per port on this machine, and a
 * port nobody has touched stays on "auto": the radio's speed, and the lines
 * the board's kind wants.
 */

import { useSyncExternalStore } from "react";
import { SERIAL_BAUD } from "@meshnet/meshcore";
import { readSetting, writeSetting } from "../lib/storage.js";
import type { FoundDevice } from "./types.js";

/** DTR and RTS, each raised or left down. */
export interface Lines {
  dtr: boolean;
  rts: boolean;
}

/** "auto" leaves the lines to the app, by what the board is; the others set both by hand. */
export type LinesChoice = "auto" | "off-off" | "off-on" | "on-off" | "on-on";

export interface PortSettings {
  baud: number;
  lines: LinesChoice;
}

export const DEFAULT_PORT: PortSettings = { baud: SERIAL_BAUD, lines: "auto" };

/** The speeds offered in the list; any other is typed in. */
export const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export const LINE_CHOICES: LinesChoice[] = ["auto", "off-off", "off-on", "on-off", "on-on"];

export function linesOf(choice: Exclude<LinesChoice, "auto">): Lines {
  return { dtr: choice.startsWith("on"), rts: choice.endsWith("-on") };
}

export function choiceOf(lines: Lines): Exclude<LinesChoice, "auto"> {
  return `${lines.dtr ? "on" : "off"}-${lines.rts ? "on" : "off"}`;
}

/**
 * A speed a port can be opened at. Never 1200: opening and closing a port at
 * 1200 is the signal for an nRF52 or RP2040 board (and some ESP32 ones) to
 * restart into its bootloader, which a radio left there would not leave.
 */
export function validBaud(baud: number): boolean {
  return Number.isInteger(baud) && baud >= 300 && baud <= 4_000_000 && baud !== 1200;
}

// The makers of USB-to-UART chips: Silicon Labs (CP210x), WCH (CH340, CH9102), FTDI, Prolific.
const BRIDGE_VENDORS = new Set([0x10c4, 0x1a86, 0x0403, 0x067b]);
const ESPRESSIF = 0x303a;

/**
 * What stands between the cable and the radio's chip: a USB-to-UART bridge
 * (an ESP32 behind a CP210x or a CH340), the chip's own USB (nRF52, an ESP32
 * with USB of its own), or a port that does not say.
 */
export type BoardKind = "bridge" | "native" | "unknown";

export function boardKind(usb: FoundDevice["usb"]): BoardKind {
  if (!usb) return "unknown";
  return BRIDGE_VENDORS.has(usb.vid) ? "bridge" : "native";
}

/** A board that may be an ESP32, which has a ROM loader to be found, and restarted out of. */
export function mayBeEsp32(usb: FoundDevice["usb"]): boolean {
  return !usb || BRIDGE_VENDORS.has(usb.vid) || usb.vid === ESPRESSIF;
}

/**
 * The lines "auto" raises. A radio with USB of its own on TinyUSB (the nRF52
 * boards: T-Echo, RAK) writes nothing back until the host raises DTR, and
 * Windows opens a port with it down. A board behind a USB-to-UART chip wires
 * DTR to its BOOT pin, so there it stays as it was. RTS is never raised: an
 * ESP32 on its own USB reads the two lines as a flashing tool's signals, and a
 * port closed with both up restarts it into its loader.
 */
export function autoLines(usb: FoundDevice["usb"]): Lines {
  return { dtr: boardKind(usb) !== "bridge", rts: false };
}

export function isDefault(settings: PortSettings): boolean {
  return settings.baud === DEFAULT_PORT.baud && settings.lines === DEFAULT_PORT.lines;
}

const KEY = "meshnet.port.settings";
const listeners = new Set<() => void>();
let all: Record<string, PortSettings> | null = null;

/**
 * Read once, each port's settings checked field by field: one from an older
 * or a hand-edited store falls back to the default. The objects stay the same
 * until a change, as `useSyncExternalStore` wants of a snapshot.
 */
function stored(): Record<string, PortSettings> {
  if (all) return all;
  const raw = readSetting<Record<string, Partial<PortSettings>>>(KEY, {});
  all = {};
  for (const [key, kept] of Object.entries(raw ?? {})) {
    all[key] = {
      baud: typeof kept?.baud === "number" && validBaud(kept.baud) ? kept.baud : DEFAULT_PORT.baud,
      lines: kept?.lines && LINE_CHOICES.includes(kept.lines) ? kept.lines : DEFAULT_PORT.lines,
    };
  }
  return all;
}

export function portSettings(key: string): PortSettings {
  return stored()[key] ?? DEFAULT_PORT;
}

/** Back to "auto" drops the port from the store, so the defaults can change later without a migration. */
export function setPortSettings(key: string, next: PortSettings): void {
  const rest = { ...stored() };
  if (isDefault(next)) delete rest[key];
  else rest[key] = next;
  all = rest;
  writeSetting(KEY, Object.keys(rest).length > 0 ? rest : null);
  for (const listener of listeners) listener();
}

export function usePortSettings(key: string | null): PortSettings {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (key === null ? DEFAULT_PORT : portSettings(key)),
  );
}
