/**
 * What the port's log makes of the bytes on a cable, and how its check goes
 * about a port: the pieces a stream splits into, what the answer to a probe
 * says, and the order the probes run in.
 */

import { decodeFrame, MAX_FRAME_SIZE, type DeviceInfo } from "@meshnet/meshcore";
import { linesOf, type BoardKind, type Lines, type PortSettings } from "../transports/portSettings.js";

const RADIO_TO_APP = 0x3e; // '>'
const LINE_END = 0x0a;
/** Bytes that never end a line or form a frame are let out at this many, rather than held for ever. */
const MAX_HELD = 512;

export type Piece =
  | { kind: "frame"; payload: Uint8Array; bytes: Uint8Array }
  | { kind: "text"; text: string; bytes: Uint8Array }
  | { kind: "bytes"; bytes: Uint8Array };

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** A line that reads as text: UTF-8, with no control character but a tab or a line's end. */
function asText(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? null : text;
}

function loose(run: number[]): Piece[] {
  if (run.length === 0) return [];
  const bytes = Uint8Array.from(run);
  const text = asText(bytes);
  if (text === null) return [{ kind: "bytes", bytes }];
  const line = text.replace(/\r?\n$/, "").replace(/\r$/, "");
  // A bare line end between two frames says nothing.
  return line.trim() === "" ? [] : [{ kind: "text", text: line, bytes }];
}

/**
 * Splits what comes in into the radio's frames, lines of text, and bytes that
 * are neither. A frame is the radio's marker, a length a radio could send,
 * and that many bytes. What does not yet make a frame or a line waits for
 * more, or for `flush` once the port has gone quiet.
 */
export class PieceSplitter {
  private held: number[] = [];

  push(chunk: Uint8Array): Piece[] {
    for (const byte of chunk) this.held.push(byte);
    return this.take(false);
  }

  /** Lets out whatever is held: the port has gone quiet, and no more of it is coming. */
  flush(): Piece[] {
    return this.take(true);
  }

  private take(all: boolean): Piece[] {
    const out: Piece[] = [];
    const buf = this.held;
    let start = 0;
    let i = 0;
    let waiting = false;
    while (i < buf.length) {
      if (buf[i] === RADIO_TO_APP) {
        const whole = i + 2 < buf.length;
        const length = whole ? buf[i + 1]! | (buf[i + 2]! << 8) : 0;
        const plausible = length >= 1 && length <= MAX_FRAME_SIZE;
        if (whole && plausible && i + 3 + length <= buf.length) {
          out.push(...loose(buf.slice(start, i)));
          const bytes = Uint8Array.from(buf.slice(i, i + 3 + length));
          out.push({ kind: "frame", payload: bytes.slice(3), bytes });
          i += 3 + length;
          start = i;
          continue;
        }
        // A frame may be under way; once the port is quiet, it was not one.
        if ((!whole || plausible) && !all) {
          waiting = true;
          break;
        }
      }
      if (buf[i] === LINE_END) {
        out.push(...loose(buf.slice(start, i + 1)));
        start = i + 1;
      }
      i++;
    }
    if (all || (!waiting && buf.length - start > MAX_HELD)) {
      out.push(...loose(buf.slice(start)));
      start = buf.length;
    }
    this.held = buf.slice(start);
    return out;
  }
}

/** What an ESP32's ROM prints as it boots, which says nothing of the radio's firmware. */
const BOOT_TEXT = /^(ESP-ROM:|Build:|rst:|boot:|SPIWP:|mode:|load:|entry |configsip:|clk_drv|ets |waiting for download)/;
/** What an ESP32 prints when it has booted into its ROM loader. */
const LOADER_TEXT = /waiting for download/i;

/** esptool's SYNC command, SLIP-framed: an ESP32's ROM loader answers it, a running radio does not. */
export const ESP_SYNC = Uint8Array.from([0xc0, 0x00, 0x08, 0x24, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07, 0x07, 0x12, 0x20, ...new Array<number>(32).fill(0x55), 0xc0]);

/** The loader's answer to SYNC: a SLIP frame of a response (1) to command 8. */
export function isLoaderAnswer(bytes: Uint8Array): boolean {
  for (let i = 0; i + 2 < bytes.length; i++) if (bytes[i] === 0xc0 && bytes[i + 1] === 0x01 && bytes[i + 2] === 0x08) return true;
  return false;
}

export type Verdict =
  | { kind: "answered"; info: DeviceInfo | null }
  | { kind: "text"; text: string }
  | { kind: "loader" }
  | { kind: "garbage" }
  | { kind: "silent" };

/**
 * What came back to a probe says. Frames: the radio heard it, at the right
 * speed. Text: the speed is right but the board talks in words (a console, or
 * firmware in another mode). Bytes that are neither: the speed is wrong. An
 * ESP32's boot lines do not count as words: a board restarted by the probe
 * prints them before its firmware answers.
 */
export function judge(pieces: Piece[]): Verdict {
  let info: DeviceInfo | null = null;
  let frames = 0;
  let loader = false;
  let other = 0;
  const words: string[] = [];
  for (const piece of pieces) {
    if (piece.kind === "frame") {
      frames++;
      const frame = decodeFrame(piece.payload);
      if (frame.kind === "deviceInfo") info = frame.info;
    } else if (piece.kind === "text") {
      if (LOADER_TEXT.test(piece.text)) loader = true;
      if (!BOOT_TEXT.test(piece.text.trim())) words.push(piece.text);
    } else {
      if (isLoaderAnswer(piece.bytes)) loader = true;
      other += piece.bytes.length;
    }
  }
  if (frames > 0) return { kind: "answered", info };
  if (loader) return { kind: "loader" };
  if (words.length > 0) return { kind: "text", text: words.join("\n") };
  if (other > 0) return { kind: "garbage" };
  return { kind: "silent" };
}

export interface Probe {
  baud: number;
  lines: Lines;
  /** What Connect would use now. */
  current: boolean;
}

/** The speeds tried on a board behind a bridge, the likeliest first. */
const BAUD_ORDER = [115200, 57600, 230400, 460800, 921600, 38400, 19200, 9600];
const OFF: Lines = { dtr: false, rts: false };
const DTR: Lines = { dtr: true, rts: false };
const BOTH: Lines = { dtr: true, rts: true };

/**
 * The probes a check runs, in order: what Connect would use now, then the
 * rest. On a board with its own USB the speed means nothing and only the
 * lines are tried; behind a bridge the lines mean nothing to the radio and
 * only the speed is; a port that does not say gets both. RTS alone is never
 * tried: it holds an ESP32 in reset.
 */
export function planProbes(kind: BoardKind, settings: PortSettings, auto: Lines | null): Probe[] {
  const speeds = [settings.baud, ...BAUD_ORDER.filter((b) => b !== settings.baud)];
  const tries: Omit<Probe, "current">[] =
    kind === "native"
      ? [DTR, OFF, BOTH].map((lines) => ({ baud: settings.baud, lines }))
      : kind === "bridge"
        ? speeds.map((baud) => ({ baud, lines: OFF }))
        : speeds.flatMap((baud) => [DTR, OFF].map((lines) => ({ baud, lines })));
  const now = settings.lines === "auto" ? auto : linesOf(settings.lines);
  const same = (a: Omit<Probe, "current">, b: Omit<Probe, "current">) => a.baud === b.baud && a.lines.dtr === b.lines.dtr && a.lines.rts === b.lines.rts;
  if (!now) return tries.map((p) => ({ ...p, current: false }));
  const first = { baud: settings.baud, lines: now };
  return [{ ...first, current: true }, ...tries.filter((p) => !same(p, first)).map((p) => ({ ...p, current: false }))];
}

/** Bytes as the log shows them: hex pairs, cut with "…" past `max`. */
export function hex(bytes: Uint8Array, max = 24): string {
  const shown = [...bytes.slice(0, max)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  return bytes.length > max ? `${shown} …` : shown;
}
