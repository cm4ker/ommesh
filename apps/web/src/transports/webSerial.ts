/**
 * Web Serial, for a browser tab on the desktop: the radio over its USB cable,
 * at the speed and with the lines its port settings name (portSettings.ts).
 */

import { BaseTransport, frameForStream, StreamFrameDecoder } from "@meshnet/meshcore";
import type { Connector, FoundDevice } from "./types.js";
import { linesOf, portSettings, type Lines } from "./portSettings.js";
import { lowerLines, writeLines, type LineWriter, type RawPort } from "./rawPort.js";
import { t } from "../i18n/index.js";

function lineWriter(port: SerialPort): LineWriter {
  return {
    dtr: (level) => port.setSignals({ dataTerminalReady: level }),
    rts: (level) => port.setSignals({ requestToSend: level }),
  };
}

class WebSerialTransport extends BaseTransport {
  readonly kind = "serial" as const;
  readonly label: string;
  private readonly decoder = new StreamFrameDecoder();
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writing: Promise<void> = Promise.resolve();

  /** `lines`: set both as picked in the port's settings; null ("auto") leaves them as the browser opens the port. */
  constructor(
    private readonly port: SerialPort,
    private readonly baud: number,
    private readonly lines: Lines | null,
  ) {
    super();
    this.label = describe(port);
  }

  async open(): Promise<void> {
    await this.port.open({ baudRate: this.baud });
    if (!this.port.readable || !this.port.writable) throw new Error(t("connect.error.noStreams"));
    if (this.lines) await writeLines(lineWriter(this.port), this.lines);
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    void this.readLoop(this.reader);
  }

  private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) for (const frame of this.decoder.push(value)) this.emitFrame(frame);
      }
      this.emitClose(new Error("the port closed"));
    } catch (error) {
      this.emitClose(error instanceof Error ? error : new Error(String(error)));
    }
  }

  send(frame: Uint8Array): Promise<void> {
    const writer = this.writer;
    if (!writer) return Promise.reject(new Error(t("connect.error.portNotOpen")));
    const bytes = frameForStream(frame);
    // Writes are serialised: a second `write` before the first settles is an error on some stacks.
    this.writing = this.writing.then(() => writer.write(bytes));
    return this.writing;
  }

  protected async shutdown(): Promise<void> {
    // With RTS up, an ESP32 on its own USB would restart into its loader as the port closes.
    if (this.lines?.rts) await lowerLines(lineWriter(this.port), this.lines).catch(() => undefined);
    await closePort(this.port, this.reader, this.writer);
  }
}

async function closePort(port: SerialPort, reader: ReadableStreamDefaultReader<Uint8Array> | null, writer: WritableStreamDefaultWriter<Uint8Array> | null): Promise<void> {
  try {
    await reader?.cancel();
  } catch {
    // Already closed.
  }
  reader?.releaseLock();
  try {
    await writer?.close();
  } catch {
    // Already closed.
  }
  writer?.releaseLock();
  try {
    await port.close();
  } catch {
    // Already closed.
  }
}

/** The port bare, for its log: what comes in is handed on as it comes, nothing is framed. */
class WebRawPort implements RawPort {
  private readonly dataListeners = new Set<(bytes: Uint8Array) => void>();
  private readonly closeListeners = new Set<(reason: Error | null) => void>();
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private closed = false;

  constructor(private readonly port: SerialPort) {}

  start(): void {
    if (!this.port.readable || !this.port.writable) throw new Error(t("connect.error.noStreams"));
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    void this.readLoop(this.reader);
  }

  private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) for (const listener of this.dataListeners) listener(value);
      }
      void this.end(this.closed ? null : new Error("the port closed"));
    } catch (error) {
      void this.end(error instanceof Error ? error : new Error(String(error)));
    }
  }

  setLines(lines: Lines): Promise<void> {
    return writeLines(lineWriter(this.port), lines);
  }

  async readSignals(): Promise<{ cts: boolean; dsr: boolean } | null> {
    try {
      const signals = await this.port.getSignals();
      return { cts: signals.clearToSend, dsr: signals.dataSetReady };
    } catch {
      return null;
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed || !this.writer) throw new Error(t("connect.error.portClosed"));
    await this.writer.write(bytes);
  }

  onData(listener: (bytes: Uint8Array) => void): void {
    this.dataListeners.add(listener);
  }

  onClose(listener: (reason: Error | null) => void): void {
    this.closeListeners.add(listener);
  }

  close(): Promise<void> {
    return this.end(null);
  }

  private async end(reason: Error | null): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await closePort(this.port, this.reader, this.writer);
    for (const listener of this.closeListeners) listener(reason);
  }
}

function describe(port: SerialPort): string {
  const info = port.getInfo();
  if (info.usbVendorId !== undefined) {
    return `USB ${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0).toString(16).padStart(4, "0")}`;
  }
  return t("connect.transport.serialPort");
}

function found(port: SerialPort, index: number): FoundDevice {
  const info = port.getInfo();
  const usb = info.usbVendorId !== undefined ? { vid: info.usbVendorId, pid: info.usbProductId ?? 0 } : undefined;
  return { id: String(index), name: describe(port), detail: null, rssi: null, usb };
}

/** The port a remembered device names: the browser lists the ports it was given, and the device keeps its place in that list. */
async function portOf(device: FoundDevice): Promise<SerialPort | undefined> {
  return (await navigator.serial.getPorts())[Number(device.id)];
}

/** By the board on it: the browser numbers its ports anew, but the maker and the product stay. */
function keyOf(device: FoundDevice): string {
  return `web:${device.name}`;
}

export const webSerialConnector: Connector = {
  id: "web-serial",
  kind: "serial",
  get title() {
    return t("connect.transport.usb");
  },
  get description() {
    return t("connect.describe.browserSerial");
  },
  mode: "picker",

  async remembered() {
    try {
      return (await navigator.serial.getPorts()).map(found);
    } catch {
      return [];
    }
  },

  async connect(device) {
    let port: SerialPort | undefined;
    if (device) port = await portOf(device);
    port ??= await navigator.serial.requestPort();
    const settings = portSettings(keyOf(device ?? found(port, -1)));
    const transport = new WebSerialTransport(port, settings.baud, settings.lines === "auto" ? null : linesOf(settings.lines));
    await transport.open();
    return transport;
  },

  port: {
    key: keyOf,
    // The browser opens the port with the lines it likes; "auto" does not touch them.
    autoLines: () => null,
    async openRaw(device, baud) {
      const port = await portOf(device);
      if (!port) throw new Error(t("connect.error.pickPort"));
      await port.open({ baudRate: baud });
      const raw = new WebRawPort(port);
      try {
        raw.start();
      } catch (error) {
        await raw.close();
        throw error;
      }
      return raw;
    },
  },
};
