/**
 * The connectors this platform has, and the link the client last used.
 */

import { ownKey } from "../lib/instance.js";
import { hasWebBluetooth, hasWebSerial, shell } from "../lib/platform.js";
import { readSetting, writeSetting } from "../lib/storage.js";
import { capacitorBleConnector } from "./capacitorBle.js";
import { capacitorTcpConnector } from "./capacitorTcp.js";
import { demoConnector, demoWanted } from "./demo.js";
import { tauriBleConnector } from "./tauriBle.js";
import { tauriSerialConnector } from "./tauriSerial.js";
import { tauriTcpConnector } from "./tauriTcp.js";
import { tauriWinBleConnector } from "./tauriWinBle.js";
import type { Connector, RememberedLink } from "./types.js";
import { webBluetoothConnector } from "./webBluetooth.js";
import { webSerialConnector } from "./webSerial.js";

export type { Connector, FoundDevice, ReachOptions, RememberedLink } from "./types.js";
export { BluetoothOffError, bluetoothOff, NeedsPairingError, needsPairing } from "./types.js";
export { addressDevice } from "./tcp.js";

export function connectors(): Connector[] {
  const list: Connector[] = [];
  switch (shell()) {
    case "tauri":
      // Windows gets the shell's own GATT path; see tauriWinBle.ts for why.
      list.push(navigator.userAgent.includes("Windows") ? tauriWinBleConnector : tauriBleConnector, tauriSerialConnector, tauriTcpConnector);
      break;
    case "capacitor":
      list.push(capacitorBleConnector, capacitorTcpConnector);
      break;
    default:
      if (hasWebBluetooth()) list.push(webBluetoothConnector);
      if (hasWebSerial()) list.push(webSerialConnector);
  }
  // Available to phone users and store reviewers without a radio or a special URL.
  if (shell() === "capacitor" || demoWanted()) list.push(demoConnector);
  return list;
}

export function connectorById(id: string): Connector | undefined {
  return connectors().find((c) => c.id === id);
}

// Each copy of the desktop app keeps a radio of its own (instance.ts).
const LAST_KEY = ownKey("meshnet.link.last");

export function lastLink(): RememberedLink | null {
  return readSetting<RememberedLink | null>(LAST_KEY, null);
}

export function rememberLink(link: RememberedLink | null): void {
  writeSetting(LAST_KEY, link);
}

const AUTO_KEY = ownKey("meshnet.link.auto");

export function autoConnectWanted(): boolean {
  return readSetting<boolean>(AUTO_KEY, true);
}

export function setAutoConnect(on: boolean): void {
  writeSetting(AUTO_KEY, on);
}
