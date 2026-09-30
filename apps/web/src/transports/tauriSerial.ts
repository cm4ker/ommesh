/**
 * The USB cable through the desktop shell's serial plugin. Ports are listed by
 * the shell; the client opens one at the radio's rate and frames the stream.
 */

import { BaseTransport, frameForStream, SERIAL_BAUD, StreamFrameDecoder } from "@meshnet/meshcore";
import type { PortInfo } from "tauri-plugin-serialplugin-api";
import type { Connector, FoundDevice } from "./types.js";
import { t } from "../i18n/index.js";

type SerialModule = typeof import("tauri-plugin-serialplugin-api");

const known = (value: string | undefined): string | null => (value && value !== "Unknown" ? value : null);

/**
 * A port as the screen lists it. A radio's cable is a USB port; a port on the
 * board or one Windows keeps for Bluetooth is set apart, named by its kind.
 * The product is named without the port Windows appends to it.
 */
export function portDevice(path: string, info: PortInfo): FoundDevice {
  if (info.type !== "USB") {
    const kind = info.type === "Bluetooth" ? t("connect.port.bluetooth") : info.type === "PCI" ? t("connect.port.board") : t("connect.port.other");
    return { id: path, name: path, detail: kind, rssi: null, role: "port" };
  }
  const product = known(info.product)?.replace(/\s*\((?:COM\d+|\/dev\/[^)]+)\)$/, "") ?? null;
  return { id: path, name: path, detail: product ?? known(info.manufacturer), rssi: null, role: "radio" };
}

// The makers of USB-to-UART chips: Silicon Labs (CP210x), WCH (CH340, CH9102), FTDI, Prolific.
const BRIDGE_VENDORS = new Set([0x10c4, 0x1a86, 0x0403, 0x067b]);

/**
 * Whether the port is opened with DTR raised. A radio with USB of its own on TinyUSB (the nRF52
 * boards: T-Echo, RAK) reads what it is sent but writes nothing back until the host raises it, and
 * Windows opens a port with it down. A board behind a USB-to-UART chip needs no line, and such
 * boards wire DTR to the BOOT pin, so there it stays as it was.
 */
export function raisesDtr(info: PortInfo | undefined): boolean {
  return !(info?.type === "USB" && BRIDGE_VENDORS.has(Number(info.vid)));
}

let plugin: Promise<SerialModule> | null = null;
function serial(): Promise<SerialModule> {
  plugin ??= import("tauri-plugin-serialplugin-api");
  return plugin;
}

export class TauriSerialTransport extends BaseTransport {
  readonly kind = "serial" as const;
  private readonly decoder = new StreamFrameDecoder();

  constructor(
    private readonly port: Pick<InstanceType<SerialModule["SerialPort"]>, "open" | "watch" | "writeBinary" | "close" | "writeDataTerminalReady">,
    readonly label: string,
    private readonly dtr = true,
  ) {
    super();
  }

  async open(): Promise<void> {
    try {
      await this.port.open();
      // RTS is never raised. An ESP32 on its own USB reads the two lines as a flashing tool's signals:
      // a port closed with both up restarts the board into its loader, silent to every later
      // connection until it is reset by hand. With DTR alone it keeps running (checked on a Xiao C6).
      if (this.dtr) await this.port.writeDataTerminalReady(true);
      await this.port.watch(
        {
          onData: (data) => {
            const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
            for (const frame of this.decoder.push(bytes)) this.emitFrame(frame);
          },
          onDisconnect: (reason) => this.fail(new Error(reason || "the port closed")),
          onError: (message) => this.fail(new Error(message)),
        },
        { decode: false, routeUrc: false, timeout: 20 },
      );
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private fail(reason: Error): void {
    // BaseTransport.close() is a no-op after emitClose, so release the native
    // port here too; otherwise the next connection can find it still occupied.
    if (this.isClosed) return;
    this.emitClose(reason);
    void this.shutdown();
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.isClosed) throw new Error(t("connect.error.portClosed"));
    await this.port.writeBinary(frameForStream(frame));
  }

  protected async shutdown(): Promise<void> {
    try {
      await this.port.close();
    } catch {
      // Already closed.
    }
  }
}

export const tauriSerialConnector: Connector = {
  id: "tauri-serial",
  kind: "serial",
  get title() {
    return t("connect.transport.usb");
  },
  get description() {
    return t("connect.describe.shellSerial");
  },
  mode: "scan",

  async scan(onFound, signal) {
    const { SerialPort } = await serial();
    const list = async () => {
      const ports = await SerialPort.available_ports();
      const devices = Object.entries(ports).map(([path, info]) => portDevice(path, info));
      devices.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
      onFound(devices);
    };
    await list();
    const timer = setInterval(() => void list().catch(() => undefined), 2000);
    signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  },

  async remembered() {
    return [];
  },

  async connect(device) {
    if (!device) throw new Error(t("connect.error.pickPort"));
    const { SerialPort } = await serial();
    const port = new SerialPort({ path: device.id, baudRate: SERIAL_BAUD });
    // A remembered port carries only its name, so what it is gets read again.
    const info = (await SerialPort.available_ports().catch(() => ({}) as Record<string, PortInfo>))[device.id];
    const transport = new TauriSerialTransport(port, device.name, raisesDtr(info));
    await transport.open();
    return transport;
  },
};
