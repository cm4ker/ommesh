/**
 * BLE on Windows through the shell's own GATT commands (`winble.rs`), which
 * exist because btleplug wedges on the firmware's encrypted UART service
 * there. The shell scans, connects and subscribes; frames arrive on a
 * channel; a drop arrives as an event.
 */

import { BaseTransport } from "@meshnet/meshcore";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { NeedsPairingError, type Connector, type FoundDevice } from "./types.js";
import { knownList } from "./known.js";
import { t } from "../i18n/index.js";

interface Found {
  address: string;
  name: string;
  rssi: number;
}

function pretty(address: string): string {
  return address.match(/.{2}/g)?.join(":") ?? address;
}

/** The shell's commands, handed in so a test can stand in for them. */
type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

export class TauriWinBleTransport extends BaseTransport {
  readonly kind = "ble" as const;
  private unlisten: UnlistenFn | null = null;

  constructor(
    readonly label: string,
    /** The shell's number for this link: closing it late, after another was opened, leaves that one up. */
    private readonly link: number,
    private readonly call: Invoke = invoke,
  ) {
    super();
  }

  async watch(): Promise<void> {
    this.unlisten = await listen<string>("winble:closed", (event) => {
      this.emitClose(new Error(event.payload || "Bluetooth device disconnected"));
    });
  }

  receive(data: number[]): void {
    if (data.length === 0) return;
    this.emitFrame(Uint8Array.from(data));
  }

  /**
   * A write that does not go through ends the link. Windows can keep the
   * connection to a phone up after the phone's app went away and came back,
   * so no disconnect is heard, and every later write met the same dead
   * service. Ended here, the link is got back as after any drop, on fresh
   * objects and a fresh subscription, which the phone needs to know the
   * computer again.
   */
  async send(frame: Uint8Array): Promise<void> {
    try {
      await this.call("winble_send", { data: Array.from(frame) });
    } catch (error) {
      const reason = new Error(String(error));
      void this.shutdown();
      this.emitClose(reason);
      throw reason;
    }
  }

  protected async shutdown(): Promise<void> {
    this.unlisten?.();
    this.unlisten = null;
    await this.call("winble_disconnect", { link: this.link }).catch(() => undefined);
  }
}

/** Radios connected to before, so a launch can reach one without a scan. */
const known = knownList("meshnet.winble.known", "ble");
/** How the firmware names a radio; anything else with its service is a phone sharing one. */
const RADIO_PREFIX = "MeshCore-";

export const tauriWinBleConnector: Connector = {
  id: "tauri-winble",
  kind: "ble",
  get title() {
    return t("connect.transport.bluetooth");
  },
  get description() {
    return t("connect.describe.windowsBle");
  },
  mode: "scan",

  async scan(onFound, signal) {
    // One listen of a few seconds at a time, repeated while the panel is open;
    // an abort ends the listen in progress too, so a connection is not kept
    // waiting behind it.
    signal.addEventListener("abort", () => void invoke("winble_stop_scan").catch(() => undefined), { once: true });
    while (!signal.aborted) {
      const list = await invoke<Found[]>("winble_scan", { timeoutMs: 4000 });
      if (signal.aborted) return;
      onFound(list.map((f) => ({ id: f.address, name: f.name, detail: pretty(f.address), rssi: f.rssi })));
    }
  },

  async remembered() {
    return known.list();
  },

  async forget(id) {
    known.forget(id);
  },

  identify: (id, radioKey) => known.identify(id, radioKey),

  async connect(device) {
    if (!device) throw new Error(t("connect.error.pickRadio"));
    let transport: TauriWinBleTransport | null = null;
    const channel = new Channel<number[]>();
    channel.onmessage = (data) => transport?.receive(data);
    const open = () => invoke<{ name: string; link: number }>("winble_connect", { address: device.id, onFrame: channel });
    let name: string;
    let link: number;
    try {
      try {
        ({ name, link } = await open());
      } catch (error) {
        // A phone sharing its radio has no PIN to type: it asks on its own
        // screen, and Windows takes any answer. So it is paired at once, and
        // only a radio (named MeshCore-…) is left to the PIN prompt.
        if (!/NEEDS_PAIRING/.test(String(error)) || device.name.startsWith(RADIO_PREFIX)) throw error;
        await invoke<string>("winble_pair", { address: device.id, pin: "" });
        ({ name, link } = await open());
      }
    } catch (error) {
      const text = String(error);
      if (/NEEDS_PAIRING/.test(text)) {
        throw new NeedsPairingError(t("connect.error.notPaired", { name: device.name }));
      }
      throw new Error(text);
    }
    transport = new TauriWinBleTransport(name || device.name, link);
    await transport.watch();
    known.remember({ ...device, name: name || device.name });
    return transport;
  },

  async pair(device, pin) {
    await invoke<string>("winble_pair", { address: device.id, pin });
  },
};
