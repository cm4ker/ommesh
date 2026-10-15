/**
 * What every Wi-Fi link shares, whichever shell holds the socket. Companion
 * firmware built with Wi-Fi (ESP32 boards, `WIFI_SSID` at build time) listens
 * on TCP port 5000 and speaks exactly what its USB serial speaks: `'<'`/`'>'`,
 * a little-endian length and the frame. A radio is reached by the address the
 * user types, and the addresses that worked are offered again.
 */

import type { FoundDevice } from "./types.js";
import { knownList } from "./known.js";
import { t } from "../i18n/index.js";

/** The port companion firmware listens on unless it was built with another. */
export const DEFAULT_TCP_PORT = 5000;

/** How long a connection may take before it is given up on. */
export const TCP_CONNECT_TIMEOUT_S = 10;

/** `host:port`, with the port the firmware uses when none is given. Brackets keep an IPv6 address whole. */
export function parseAddress(text: string): { host: string; port: number } | null {
  const value = text.trim();
  if (!value) return null;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracketed) return { host: bracketed[1]!, port: bracketed[2] ? Number(bracketed[2]) : DEFAULT_TCP_PORT };
  const colons = value.split(":").length - 1;
  if (colons === 1) {
    const [host, port] = value.split(":") as [string, string];
    if (!host || !/^\d+$/.test(port)) return null;
    return { host, port: Number(port) };
  }
  // No colon is a bare host; several are an IPv6 address with no port.
  return { host: value, port: DEFAULT_TCP_PORT };
}

/** The address a connector's `connect` was handed, checked, or the reason it cannot be used. */
export function addressOf(device: FoundDevice): { host: string; port: number } {
  const address = parseAddress(device.id);
  if (!address || address.port < 1 || address.port > 65535) throw new Error(t("connect.error.notAddress", { address: device.id }));
  return address;
}

export function addressLabel(host: string, port: number): string {
  const shown = host.includes(":") ? `[${host}]` : host;
  return port === DEFAULT_TCP_PORT ? shown : `${shown}:${port}`;
}

/** What the connect screen hands `connect` for a typed address. */
export function addressDevice(text: string): FoundDevice | null {
  const address = parseAddress(text);
  if (!address) return null;
  const label = addressLabel(address.host, address.port);
  return { id: label, name: label, detail: null, rssi: null };
}

/**
 * Addresses connected to before, newest first. One radio may be reached at
 * several (at home and through a tunnel), so a radio found at a new one
 * leaves the old ones be.
 */
export const knownAddresses = knownList("meshnet.tcp.known", "tcp");
