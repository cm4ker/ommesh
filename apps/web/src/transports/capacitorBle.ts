/**
 * BLE on a phone, through the Capacitor plugin. The plugin scans, connects,
 * and on Android asks for a 512-byte MTU by itself, which the 176-byte frames
 * need; iOS negotiates the largest MTU on its own.
 */

import { BaseTransport, BLE } from "@meshnet/meshcore";
import { BluetoothOffError, NeedsPairingError, type Connector, type FoundDevice, type ReachOptions } from "./types.js";
import { nativePlatform } from "../lib/platform.js";
import { openRelay, relayComesUp, relayHolds, type RelayLink } from "../lib/relay.js";
import { knownList } from "./known.js";
import { roleOf } from "./role.js";
import { t } from "../i18n/index.js";

type BleModule = typeof import("@capacitor-community/bluetooth-le");
type BleDevice = import("@capacitor-community/bluetooth-le").BleDevice;

let plugin: Promise<BleModule> | null = null;
let ready: Promise<BleModule> | null = null;

function loadBle(): Promise<BleModule> {
  plugin ??= import("@capacitor-community/bluetooth-le");
  return plugin;
}

async function bleModule(): Promise<BleModule> {
  if (!ready) {
    ready = (async () => {
      const mod = await loadBle();
      await mod.BleClient.initialize({ androidNeverForLocation: true });
      return mod;
    })().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

async function ble(): Promise<BleModule["BleClient"]> {
  return (await bleModule()).BleClient;
}

function nonEmpty(value: string | null | undefined): string | null {
  const clean = value?.replace(/\0+$/, "");
  return clean && clean.trim().length > 0 ? clean : null;
}

const textDecoder = new TextDecoder();

/**
 * Complete (0x09) or shortened (0x08) local name from raw Android scan record bytes.
 * The BLE plugin populates `localName` from `BluetoothDevice.getName()` (the OS cache,
 * often empty before a GATT connection) instead of `ScanRecord.getDeviceName()`, so
 * reading the raw advertisement recovers the live name from the radio's scan response.
 */
export function advertisedName(raw: DataView | undefined): string | null {
  if (!raw || raw.byteLength === 0) return null;
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  let shortened: string | null = null;
  let offset = 0;
  while (offset < bytes.length) {
    const length = bytes[offset]!;
    if (length === 0) break;
    const end = offset + 1 + length;
    if (end > bytes.length) break;
    const type = bytes[offset + 1]!;
    if (type === 0x09 || type === 0x08) {
      const name = nonEmpty(textDecoder.decode(bytes.subarray(offset + 2, end)));
      if (name) {
        if (type === 0x09) return name;
        shortened ??= name;
      }
    }
    offset = end;
  }
  return shortened;
}

/**
 * Picks a display name from a scan result without letting an empty cached string hide
 * the radio under "phones sharing a radio".
 */
export function scanDeviceName(
  result: { localName?: string; device: { name?: string }; rawAdvertisement?: DataView },
  previous?: string,
): string {
  const live = advertisedName(result.rawAdvertisement);
  if (live) return live;
  // On Android the plugin fills `localName` from the cached device name; once a scan
  // response has named the radio, a later advert without one keeps that name.
  if (result.rawAdvertisement && previous && previous !== "MeshCore") return previous;
  return nonEmpty(result.localName) ?? nonEmpty(result.device.name) ?? nonEmpty(previous) ?? "MeshCore";
}

/** Whether a device from Android's system connected or bonded lists is a MeshCore radio. */
export function isMeshCoreDevice(device: Pick<BleDevice, "name" | "uuids">): boolean {
  if (device.uuids?.some((uuid) => uuid.toLowerCase() === BLE.service)) return true;
  const name = nonEmpty(device.name);
  return name !== null && roleOf({ id: "", name, detail: null, rssi: null }, "ble") === "radio";
}

/** Appends system-bonded MeshCore radios after the app's own remembered list without duplicates. */
export function mergeRemembered(saved: FoundDevice[], bonded: Pick<BleDevice, "deviceId" | "name" | "uuids">[]): FoundDevice[] {
  const out = [...saved];
  const ids = new Set(saved.map((device) => device.id.toUpperCase()));
  for (const device of bonded) {
    if (!isMeshCoreDevice(device)) continue;
    const key = device.deviceId.toUpperCase();
    if (ids.has(key)) continue;
    ids.add(key);
    out.push({ id: device.deviceId, name: nonEmpty(device.name) ?? "MeshCore", detail: null, rssi: null, bonded: true });
  }
  return out;
}

/** The phone's prompt to turn Bluetooth on while it is up, to its answer: whether it was turned on. */
let asking: Promise<boolean> | null = null;

/**
 * With Bluetooth off a search stays empty and a connect waits out its time,
 * and neither says why. Android asks to turn it on with its own prompt; iOS
 * puts its own up by itself the first time the app reaches for Bluetooth,
 * so there it is only said.
 */
async function switchedOn(client: BleModule["BleClient"], options: ReachOptions | undefined): Promise<void> {
  if (await client.isEnabled().catch(() => true)) return;
  if (options?.mayAsk && nativePlatform() === "android") {
    // Resolves once Bluetooth is on; turned down, it rejects.
    asking ??= client
      .requestEnable()
      .then(() => true, () => false)
      .finally(() => (asking = null));
  }
  // A search and a connect that both find it off while the prompt is up take its one answer.
  const answer = asking;
  if (answer && (await answer)) return;
  throw new BluetoothOffError(t("connect.error.bluetoothOff"));
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
const known = knownList("meshnet.ble.known", "ble");

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

  async scan(onFound, signal, options) {
    const mod = await bleModule();
    const client = mod.BleClient;
    await switchedOn(client, options);
    const platform = nativePlatform();
    const seen = new Map<string, FoundDevice>();
    // A radio already connected to this phone, by another app or by the
    // system, stops advertising and drops out of every scan. iOS hands those
    // over by service; Android lists every GATT connection, so non-MeshCore
    // devices (watches, headphones) are filtered out here.
    const connected =
      platform === "ios"
        ? await client.getConnectedDevices([BLE.service]).catch(() => [])
        : platform === "android"
          ? await client.getConnectedDevices([BLE.service]).then((list) => list.filter(isMeshCoreDevice), () => [])
          : [];
    for (const device of connected) {
      seen.set(device.deviceId, {
        id: device.deviceId,
        name: nonEmpty(device.name) ?? "MeshCore",
        detail: t("connect.device.connectedToPhone"),
        rssi: null,
      });
    }
    if (signal.aborted) return;
    if (seen.size > 0) onFound([...seen.values()]);
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
    // Interactive scan while the connect screen is open: full duty cycle on Android
    // catches sparse adverts (e.g. Wi-Fi/BLE coexistence) that BALANCED can miss.
    await client.requestLEScan(
      { services: [BLE.service], allowDuplicates: true, scanMode: mod.ScanMode.SCAN_MODE_LOW_LATENCY },
      (result) => {
        const before = seen.get(result.device.deviceId);
        // Not every advert carries the name: one without keeps the name heard before.
        seen.set(result.device.deviceId, {
          id: result.device.deviceId,
          name: scanDeviceName(result, before?.name),
          detail: null,
          rssi: result.rssi ?? before?.rssi ?? null,
        });
        if (!before || Date.now() - told >= UPDATE_MS) tell();
        else later ??= setTimeout(tell, UPDATE_MS - (Date.now() - told));
      },
    );
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
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    });
    // Android 10–11 (and some OEM ROMs) return zero scan results silently while the
    // system Location switch is off. Checked only after an empty scan so Android 12+
    // phones that scan fine with Location off never see a false warning.
    if (!signal.aborted && seen.size === 0 && platform === "android") {
      const locationOn = await client.isLocationEnabled().catch(() => true);
      if (!locationOn) throw new Error(t("connect.error.locationOff"));
    }
  },

  async remembered() {
    const saved = known.list();
    // Include MeshCore radios paired in Android's own Bluetooth settings once the
    // plugin has been initialised, so a radio missed by a scan can still be reached
    // without prompting for Bluetooth permissions before the Bluetooth tab is used.
    if (nativePlatform() !== "android" || !ready) return saved;
    const mod = await ready.catch(() => null);
    if (!mod) return saved;
    const bonded = await mod.BleClient.getBondedDevices().catch(() => []);
    return mergeRemembered(saved, bonded);
  },

  async forget(id) {
    known.forget(id);
  },

  identify: (id, radioKey) => known.identify(id, radioKey),

  async connect(device, options) {
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
      await switchedOn(client, options);
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
    const saved: FoundDevice = { ...device };
    delete saved.bonded;
    known.remember(saved);
    return transport;
  },
};
