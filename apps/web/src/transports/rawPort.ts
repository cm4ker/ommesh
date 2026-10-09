/**
 * A serial port opened bare, for the port's log and its check: bytes in and
 * out with no framing, and its lines set by hand. Also the line sequences the
 * transports share, written for Windows' USB serial driver.
 */

import type { Lines } from "./portSettings.js";

export interface RawPort {
  /** Sets DTR and RTS, both: see `writeLines`. */
  setLines(lines: Lines): Promise<void>;
  /** CTS and DSR as the board drives them; null where the platform cannot say. */
  readSignals(): Promise<{ cts: boolean; dsr: boolean } | null>;
  write(bytes: Uint8Array): Promise<void>;
  onData(listener: (bytes: Uint8Array) => void): void;
  /** Once, when the port goes: null for a close asked for, the reason otherwise. */
  onClose(listener: (reason: Error | null) => void): void;
  close(): Promise<void>;
}

/** How a platform sets one line at a time. */
export interface LineWriter {
  dtr(level: boolean): Promise<void>;
  rts(level: boolean): Promise<void>;
}

/**
 * Sets both lines. Windows' usbser driver passes the lines to a board on its
 * own USB only when DTR is written, so RTS is followed by DTR written again,
 * as esptool does: without it an RTS change never reaches the chip.
 */
export async function writeLines(writer: LineWriter, lines: Lines): Promise<void> {
  await writer.dtr(lines.dtr);
  await writer.rts(lines.rts);
  await writer.dtr(lines.dtr);
}

/**
 * Lowers the lines before a port is closed: RTS first, then DTR. An ESP32 on
 * its own USB closed with both up restarts into its loader and stays silent
 * until reset by hand; lowered in this order, it keeps running.
 */
export async function lowerLines(writer: LineWriter, now: Lines): Promise<void> {
  if (now.rts) {
    await writer.rts(false);
    await writer.dtr(now.dtr);
  }
  if (now.dtr) await writer.dtr(false);
}
