import type { DeviceInfo, SessionState, Transport, TransportKind } from "@meshnet/meshcore";

/** A radio the connect screen can offer. */
export interface FoundDevice {
  /** What `connect` takes: a BLE address, a serial path, a browser device id. */
  id: string;
  name: string;
  /** A second line: an address, a manufacturer, a signal. */
  detail: string | null;
  rssi: number | null;
  /**
   * What it is, where the connector can tell better than the name (a serial
   * port's kind); left out, `roleOf` reads it from the name.
   */
  role?: DeviceRole;
}

/** A radio; a phone sharing its radio; a port that is likely something else. */
export type DeviceRole = "radio" | "phone" | "port";

/**
 * One way of reaching a radio on this platform. `picker` connectors hand the
 * choice to the browser's own chooser (Web Bluetooth, Web Serial); `scan`
 * connectors list what they find and connect to one; `address` connectors
 * take an address typed in (a radio on the network).
 */
export interface Connector {
  id: string;
  kind: TransportKind;
  title: string;
  description: string;
  mode: "picker" | "scan" | "address";
  /** Lists devices as they are found until the signal aborts. `scan` connectors only. */
  scan?(onFound: (devices: FoundDevice[]) => void, signal: AbortSignal): Promise<void>;
  /** Devices this platform can reconnect to without a scan or a chooser. */
  remembered(): Promise<FoundDevice[]>;
  /** `null` asks the picker; a device connects to it. */
  connect(device: FoundDevice | null): Promise<Transport>;
  /**
   * Bonds with a radio using the PIN on its screen, where the platform lets
   * the client do that itself. A `connect` that fails with `needsPairing`
   * set is the cue to ask for the PIN and call this.
   */
  pair?(device: FoundDevice, pin: string): Promise<void>;
}

/** A connect failure the client can do something about: pair, then try again. */
export class NeedsPairingError extends Error {
  readonly needsPairing = true;
  constructor(message: string) {
    super(message);
    this.name = "NeedsPairingError";
  }
}

export function needsPairing(error: unknown): boolean {
  return error instanceof NeedsPairingError || /NEEDS_PAIRING|insufficient auth|ProtocolError/i.test(String((error as Error)?.message ?? error));
}

export interface RememberedLink {
  connectorId: string;
  device: FoundDevice;
  /** The node's own name, as the radio gave it: a port or an address says nothing of which radio it was. */
  radioName?: string | undefined;
  /** The radio as it last said who it is (its PIN left out): the next launch shows its stored chats by it, before it is reached. */
  radio?: { self: NonNullable<SessionState["self"]>; device: DeviceInfo | null } | undefined;
}
