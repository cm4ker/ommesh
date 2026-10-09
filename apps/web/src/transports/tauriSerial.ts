/**
 * The USB cable through the desktop shell's serial plugin. Ports are listed by
 * the shell; the client opens one at the speed and with the lines its port
 * settings name (portSettings.ts), and frames the stream.
 */

import { BaseTransport, frameForStream, StreamFrameDecoder } from "@meshnet/meshcore";
import type { PortInfo } from "tauri-plugin-serialplugin-api";
import type { Connector, FoundDevice } from "./types.js";
import { autoLines, linesOf, portSettings, type Lines } from "./portSettings.js";
import { lowerLines, writeLines, type LineWriter, type RawPort } from "./rawPort.js";
import { t } from "../i18n/index.js";

type SerialModule = typeof import("tauri-plugin-serialplugin-api");
type PluginPort = InstanceType<SerialModule["SerialPort"]>;

const known = (value: string | undefined): string | null => (value && value !== "Unknown" ? value : null);

/** A USB port's maker and product, as the plugin gives them: decimal strings, "Unknown" when the system does not say. */
function usbOf(info: PortInfo | undefined): FoundDevice["usb"] {
  if (info?.type !== "USB") return undefined;
  const vid = Number(info.vid);
  const pid = Number(info.pid);
  return Number.isInteger(vid) && vid > 0 ? { vid, pid: Number.isInteger(pid) ? pid : 0 } : undefined;
}

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
  return { id: path, name: path, detail: product ?? known(info.manufacturer), rssi: null, role: "radio", usb: usbOf(info) };
}

/** Whether "auto" opens the port with DTR raised: see `autoLines`. */
export function raisesDtr(info: PortInfo | undefined): boolean {
  return autoLines(usbOf(info)).dtr;
}

function lineWriter(port: Pick<PluginPort, "writeDataTerminalReady" | "writeRequestToSend">): LineWriter {
  return { dtr: (level) => port.writeDataTerminalReady(level), rts: (level) => port.writeRequestToSend(level) };
}

let plugin: Promise<SerialModule> | null = null;
function serial(): Promise<SerialModule> {
  plugin ??= import("tauri-plugin-serialplugin-api");
  return plugin;
}

export class TauriSerialTransport extends BaseTransport {
  readonly kind = "serial" as const;
  private readonly decoder = new StreamFrameDecoder();

  /**
   * `byHand`: the lines were picked in the port's settings, and both are set
   * as picked. Otherwise ("auto") only DTR is raised, where it is wanted, and
   * a line it does not want is left as the port opened it.
   */
  constructor(
    private readonly port: Pick<PluginPort, "open" | "watch" | "writeBinary" | "close" | "writeDataTerminalReady" | "writeRequestToSend">,
    readonly label: string,
    private readonly lines: Lines = { dtr: true, rts: false },
    private readonly byHand = false,
  ) {
    super();
  }

  async open(): Promise<void> {
    try {
      await this.port.open();
      if (this.byHand) await writeLines(lineWriter(this.port), this.lines);
      else if (this.lines.dtr) await this.port.writeDataTerminalReady(true);
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
    // With RTS up, an ESP32 on its own USB would restart into its loader as the port closes.
    if (this.lines.rts) await lowerLines(lineWriter(this.port), this.lines).catch(() => undefined);
    try {
      await this.port.close();
    } catch {
      // Already closed.
    }
  }
}

/** The port bare, for its log: what comes in is handed on as it comes, nothing is framed. */
class TauriRawPort implements RawPort {
  private readonly dataListeners = new Set<(bytes: Uint8Array) => void>();
  private readonly closeListeners = new Set<(reason: Error | null) => void>();
  private closed = false;

  constructor(private readonly port: PluginPort) {}

  async start(): Promise<void> {
    await this.port.watch(
      {
        onData: (data) => {
          const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
          for (const listener of this.dataListeners) listener(bytes);
        },
        onDisconnect: (reason) => void this.end(new Error(reason || "the port closed")),
        onError: (message) => void this.end(new Error(message)),
      },
      { decode: false, routeUrc: false, timeout: 20 },
    );
  }

  setLines(lines: Lines): Promise<void> {
    return writeLines(lineWriter(this.port), lines);
  }

  async readSignals(): Promise<{ cts: boolean; dsr: boolean } | null> {
    try {
      const [cts, dsr] = await Promise.all([this.port.readClearToSend(), this.port.readDataSetReady()]);
      return { cts, dsr };
    } catch {
      return null;
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error(t("connect.error.portClosed"));
    await this.port.writeBinary(bytes);
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
    try {
      await this.port.close();
    } catch {
      // Already closed.
    }
    for (const listener of this.closeListeners) listener(reason);
  }
}

/** A remembered port carries only its name, so what it is gets read again. */
async function infoOf(path: string): Promise<PortInfo | undefined> {
  const { SerialPort } = await serial();
  return (await SerialPort.available_ports().catch(() => ({}) as Record<string, PortInfo>))[path];
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
    const settings = portSettings(device.id);
    const port = new SerialPort({ path: device.id, baudRate: settings.baud });
    const transport =
      settings.lines === "auto"
        ? new TauriSerialTransport(port, device.name, autoLines(usbOf(await infoOf(device.id))))
        : new TauriSerialTransport(port, device.name, linesOf(settings.lines), true);
    await transport.open();
    return transport;
  },

  port: {
    // By the port's name: the plugin lists ports by it, and the remembered link keeps it.
    key: (device) => device.id,
    // A port remembered from before the board was known says nothing until the list finds it again.
    autoLines: (device) => (device.usb ? autoLines(device.usb) : null),
    async openRaw(device, baud) {
      const { SerialPort } = await serial();
      const port = new SerialPort({ path: device.id, baudRate: baud });
      await port.open();
      const raw = new TauriRawPort(port);
      try {
        await raw.start();
      } catch (error) {
        await raw.close();
        throw error;
      }
      return raw;
    },
  },
};
