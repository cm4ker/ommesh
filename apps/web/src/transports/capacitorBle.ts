/**
 * BLE on a phone, through the Capacitor plugin. The plugin scans, connects,
 * and on Android asks for a 512-byte MTU by itself, which the 176-byte frames
 * need; iOS negotiates the largest MTU on its own.
 */

import { BaseTransport, BLE } from "@meshnet/meshcore";
import { NeedsPairingError, type Connector, type FoundDevice } from "./types.js";
import { nativePlatform } from "../lib/platform.js";
import { openRelay, relayComesUp, relayHolds, type RelayLink } from "../lib/relay.js";
import { readSetting, writeSetting } from "../lib/storage.js";
import { t } from "../i18n/index.js";

type BleModule = typeof import("@capacitor-community/bluetooth-le");

let plugin: Promise<BleModule> | null = null;
let initialised = false;

async function ble(): Promise<BleModule["BleClient"]> {
  plugin ??= import("@capacitor-community/bluetooth-le");
  const mod = await plugin;
  if (!initialised) {
    await mod.BleClient.initialize({ androidNeverForLocation: true });
    initialised = true;
  }
  return mod.BleClient;
}

class CapacitorBleTransport extends BaseTransport {
  readonly kind = "ble" as const;
  /**
   * The page's frames go through the phone's native link, which goes on
   * reading the radio while the page sleeps and takes turns with a computer
   * the radio is shared with (see lib/relay.ts). The plugin's link stays, for
   * the pairing and to hear of a drop; a link taken over as the phone held it
   * has none (`client` null).
   */
  private relay: RelayLink | null = null;

  constructor(
    private readonly client: BleModule["BleClient"] | null,
    private readonly deviceId: string,
    readonly label: string,
  ) {
    super();
  }

  async useRelay(name: string, held = false): Promise<void> {
    this.relay = await openRelay(
      this.deviceId,
      name,
      (frame) => this.emitFrame(frame),
      (reason) => this.emitClose(new Error(reason)),
      held,
    );
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.relay) return this.relay.send(frame);
    if (!this.client) throw new Error("the phone's link to the radio was closed");
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    // With response: the characteristic demands an encrypted link, and an
    // acknowledged write is what makes the phone start the PIN pairing on an
    // unpaired one instead of dropping the bytes.
    await this.client.write(this.deviceId, BLE.service, BLE.rx, view);
  }

  receive(value: DataView): void {
    if (value.byteLength === 0 || this.relay) return;
    this.emitFrame(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
  }

  onDropped(): void {
    this.emitClose(new Error("Bluetooth device disconnected"));
  }

  protected async shutdown(): Promise<void> {
    if (this.relay) {
      // Not unsubscribed: Android shares the subscription with the relay's own
      // client on the same link, and the computer would stop hearing the radio.
      await this.relay.close();
    } else {
      try {
        await this.client?.stopNotifications(this.deviceId, BLE.service, BLE.tx);
      } catch {
        // Already gone.
      }
    }
    try {
      await this.client?.disconnect(this.deviceId);
    } catch {
      // Already gone.
    }
  }
}

const SCAN_MS = 10_000;
/** How often the adverts heard in a search reach the screen. */
const UPDATE_MS = 1_000;

/** Longer than Android's own wait for a PIN, so its answer, not this, ends a pairing. */
const PAIR_MS = 40_000;

/**
 * On Android a radio met for the first time is paired before anything is
 * written to it, and the PIN may take as long as it takes to type. Left to
 * the first write, the pairing raced the radio's answer time: the connect
 * gave up while the PIN was still being typed and took the pairing down with
 * it. iOS pairs on the first write and holds the write until it is done.
 */
async function pairFirst(client: BleModule["BleClient"], device: FoundDevice): Promise<void> {
  if (nativePlatform() !== "android") return;
  if (await client.isBonded(device.id).catch(() => true)) return;
  try {
    await client.createBond(device.id, { timeout: PAIR_MS });
  } catch {
    await client.disconnect(device.id).catch(() => undefined);
    throw new NeedsPairingError(t("connect.error.phonePairing", { name: device.name }));
  }
}

/** The phone's link to the radio, taken over as it is, with no plugin link beside it. */
async function takeOver(device: FoundDevice): Promise<CapacitorBleTransport> {
  const held = new CapacitorBleTransport(null, device.id, device.name);
  await held.useRelay(device.name, true);
  return held;
}

/** Radios connected to before, by the id the phone gave them, so they can be reached without a scan. */
const KNOWN_KEY = "meshnet.ble.known";

function known(): FoundDevice[] {
  return readSetting<FoundDevice[]>(KNOWN_KEY, []);
}

function remember(device: FoundDevice): void {
  writeSetting(KNOWN_KEY, [device, ...known().filter((d) => d.id !== device.id)].slice(0, 8));
}

export const capacitorBleConnector: Connector = {
  id: "cap-ble",
  kind: "ble",
  get title() {
    return t("connect.transport.bluetooth");
  },
  get description() {
    return t("connect.describe.phoneBle");
  },
  mode: "scan",

  async scan(onFound, signal) {
    const client = await ble();
    const seen = new Map<string, FoundDevice>();
    // A radio already connected to this phone, by another app or by the
    // system, stops advertising, and iOS leaves it out of every scan. iOS
    // hands those over by service instead. Android's list is every GATT
    // connection, watches and headphones included, so it is not asked.
    const connected = nativePlatform() === "ios" ? await client.getConnectedDevices([BLE.service]).catch(() => []) : [];
    for (const device of connected) {
      seen.set(device.deviceId, { id: device.deviceId, name: device.name ?? "MeshCore", detail: t("connect.device.connectedToPhone"), rssi: null });
    }
    if (seen.size > 0) onFound([...seen.values()]);
    if (signal.aborted) return;
    // Every advert, so the signal follows the radio as the phone moves (one per pass only gave the
    // first). A radio new to the list shows at once; the rest reach the screen once a second.
    let told = 0;
    let later: ReturnType<typeof setTimeout> | undefined;
    const tell = () => {
      clearTimeout(later);
      later = undefined;
      told = Date.now();
      onFound([...seen.values()]);
    };
    signal.addEventListener("abort", () => clearTimeout(later), { once: true });
    await client.requestLEScan({ services: [BLE.service], allowDuplicates: true }, (result) => {
      const known = seen.get(result.device.deviceId);
      // Not every advert carries the name: one without keeps the name heard before.
      seen.set(result.device.deviceId, {
        id: result.device.deviceId,
        name: result.localName ?? result.device.name ?? known?.name ?? "MeshCore",
        detail: null,
        rssi: result.rssi ?? known?.rssi ?? null,
      });
      if (!known || Date.now() - told >= UPDATE_MS) tell();
      else later ??= setTimeout(tell, UPDATE_MS - (Date.now() - told));
    });
    // The plugin scans until told to stop and resolves as soon as it starts.
    // This one stops after a while, and resolves then, so the screen can tell
    // "still looking" from "nothing found".
    await new Promise<void>((resolve) => {
      const stop = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        void client.stopLEScan().catch(() => undefined).finally(resolve);
      };
      const timer = setTimeout(stop, SCAN_MS);
      signal.addEventListener("abort", stop, { once: true });
    });
  },

  async remembered() {
    return known();
  },

  async connect(device) {
    if (!device) throw new Error(t("connect.error.pickRadio"));
    // A page made anew while the phone kept its link (Android lets a page go
    // for memory; the link and its service stay) takes the link over as it is:
    // no BLE plugin, whose first call waits for the app to be on screen, and no
    // second connect, discovery and subscription.
    if (await relayHolds(device.id).catch(() => false)) return takeOver(device);
    // A phone's link that is to this radio and waits for it comes back by
    // itself, and may beat the plugin, which in the background waits for the
    // app to be on screen before its first call: whichever is first is used.
    const relay = relayComesUp(device.id);
    let transport: CapacitorBleTransport | null = null;
    const reaching = (async () => {
      const client = await ble();
      // iOS connects only to a peripheral the plugin has met since launch. A
      // remembered radio, or the one "Reconnect at launch" reaches for, is met
      // by asking the system for it by id.
      await client.getDevices([device.id]).catch(() => []);
      await client.connect(device.id, () => transport?.onDropped());
      return client;
    })();
    let client: BleModule["BleClient"] | null;
    try {
      client = await Promise.race([reaching, relay.up.then(() => null)]);
    } finally {
      relay.cancel();
    }
    if (!client) {
      // The plugin's link, should it come after all, is not wanted.
      void reaching.then((late) => late.disconnect(device.id), () => undefined);
      return takeOver(device);
    }
    await pairFirst(client, device);
    transport = new CapacitorBleTransport(client, device.id, device.name);
    try {
      await client.startNotifications(device.id, BLE.service, BLE.tx, (value) => transport?.receive(value));
    } catch (error) {
      // A radio left connected after a failed attempt (a PIN prompt turned
      // down or left to time out) stays taken, and its prompt can come back.
      await client.disconnect(device.id).catch(() => undefined);
      throw error;
    }
    try {
      await transport.useRelay(device.name);
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
    remember(device);
    return transport;
  },
};
